import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readSnapshot } from "./git.mjs";
import { submitBatch, validateBatch } from "./protocol.mjs";
import { restoreComments, getUnsent, saveComment, deleteComment, acknowledgeComments } from "./comments.mjs";
import { frame, hitTest, anchor, matchesAnchor, updateOutdated, plain } from "./view.mjs";

/** Both terminal adapters share anchors, revision history and delivery receipts. */
export async function createReviewController({
  connection, dir, loadSnapshot = readSnapshot, send = submitBatch,
  onChange = () => {}, onClose = () => {}, rows = () => 24,
}) {
  const draftPath = path.join(dir, "drafts.json");
  const state = { snapshot: undefined, comparison: connection.comparison || "", fileIndex: 0, rowIndex: 0,
    viewTop: 0, horizontal: 0, focus: "files", mode: "review", comments: [], commentIndex: 0,
    selectedCommentId: undefined, pendingCount: 0, status: "" };
  let pending;
  try {
    const saved = JSON.parse(await readFile(draftPath, "utf8"));
    state.comments = restoreComments(saved.comments || []);
    // Never rewrite an old pending wire batch during migration: the bridge
    // fingerprints it, and a same-ID retry must contain identical bytes.
    if (saved.pending) { pending = validateBatch(saved.pending); state.pendingCount = pending.comments.length; }
  } catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot read saved drafts: ${error.message}. Original file kept at ${draftPath}`); }
  async function persist() {
    // Rename prevents a crash from truncating the saved notes and delivery log.
    await writeFile(draftPath + ".tmp", JSON.stringify({ comments: state.comments, pending }, null, 2), { mode: 0o600 });
    await rename(draftPath + ".tmp", draftPath);
  }
  let stopped = false, refreshing = false, timer, lastFrame, lastWidth = 0;
  let queue = Promise.resolve();
  function draw() { if (!stopped) onChange(); }
  function point(x, y) {
    if (stopped) return;
    const hovered = (position) => position && lastFrame?.hits.find((hit) => hit.type === "row" && hit.source &&
      hit.y === position.y && position.x >= hit.x1 && position.x <= lastWidth);
    const previous = hovered(state.pointer);
    state.pointer = { x, y };
    // Moving within a source row changes no visible state. Cross-row/leave
    // transitions repaint immediately, without waiting for filesystem work.
    if (previous !== hovered(state.pointer)) draw();
  }
  function enqueue(work) {
    queue = queue.then(async () => { if (!stopped) await work(); })
      .catch((error) => { state.status = plain(error.message); }).then(draw);
    return queue;
  }
  async function refresh() {
    const previous = state.snapshot?.files[state.fileIndex]?.path;
    const snapshot = await loadSnapshot(connection.root, connection.comparison);
    if (stopped) return;
    state.snapshot = snapshot;
    const index = snapshot.files.findIndex((f) => f.path === previous);
    state.fileIndex = index < 0 ? Math.min(state.fileIndex, Math.max(0, snapshot.files.length - 1)) : index;
    state.rowIndex = Math.min(state.rowIndex, Math.max(0, (snapshot.files[state.fileIndex]?.rows.length || 0) - 1));
    state.comments = updateOutdated(state.comments, snapshot);
    if (pending) state.status = "Submission awaiting receipt. s: retry the same batch; editing is locked.";
    await persist();
  }
  function locate(source) {
    const index = state.snapshot?.files.findIndex((f) => f.path === source.filePath) ?? -1;
    if (index < 0) return false;
    state.fileIndex = index;
    const file = state.snapshot.files[index];
    const row = file.revision === source.revision ? file.rows.findIndex((r) => source.line === (source.side === "new" ? r.newLine : r.oldLine)) : -1;
    state.rowIndex = Math.max(0, row);
    return row >= 0;
  }
  function edit(commentId, clickedSource) {
    if (pending) { state.status = "Retry the pending submission first. Comments are locked to prevent duplicate feedback."; return; }
    let comment = state.comments.find((c) => c.id === commentId);
    const file = state.snapshot?.files[state.fileIndex];
    const row = file?.rows[state.rowIndex];
    const source = comment || clickedSource || (row && anchor(file, row));
    if (!source) { state.status = "Select a source line, not a diff heading."; return; }
    if (!comment) {
      const same = state.comments.filter((c) => matchesAnchor(c, source));
      comment = same.find((c) => !c.sentAt) || same.at(-1);
    }
    state.editor = { anchor: comment || source, text: comment?.text || "", commentId: comment?.id };
    state.selectedCommentId = comment?.id;
    locate(source);
    state.focus = "diff"; state.mode = "edit"; state.status = "";
  }
  function jumpToComment(commentId) {
    const comment = state.comments.find((c) => c.id === commentId);
    if (!comment) return;
    state.selectedCommentId = comment.id;
    state.commentIndex = state.comments.indexOf(comment);
    state.focus = "diff";
    state.mode = locate(comment) ? "review" : "comments";
    state.status = comment.outdated ? "This note belongs to an outdated snapshot. Enter edits the original note; it is never moved to current code." : "";
  }
  function nextComment(delta) {
    if (!state.comments.length) { state.status = "No saved comments to navigate."; return; }
    const fileOrder = new Map((state.snapshot?.files || []).map((f, i) => [f.path, i]));
    const ordered = [...state.comments].sort((a, b) =>
      (fileOrder.get(a.filePath) ?? Infinity) - (fileOrder.get(b.filePath) ?? Infinity) ||
      a.filePath.localeCompare(b.filePath) || a.line - b.line || a.revisionNumber - b.revisionNumber);
    let index = ordered.findIndex((c) => c.id === state.selectedCommentId);
    if (index < 0) index = delta > 0 ? -1 : 0;
    jumpToComment(ordered[(index + delta + ordered.length) % ordered.length].id);
  }
  async function remove(commentId) {
    if (pending) { state.status = "Retry the pending submission before editing comments."; return; }
    state.comments = deleteComment(state.comments, commentId);
    state.commentIndex = Math.max(0, Math.min(state.commentIndex, state.comments.length - 1));
    if (state.selectedCommentId === commentId) state.selectedCommentId = state.comments[state.commentIndex]?.id;
    await persist(); state.status = "Unsent comment deleted.";
  }
  function confirm() {
    if (!getUnsent(state.comments).length && !pending) { state.status = "No unsent comments. Sent feedback is not sent again."; return; }
    state.mode = "confirm";
  }
  async function submit() {
    if (!pending) {
      await refresh();
      if (stopped) return;
      const candidate = { id: randomUUID(), comments: structuredClone(getUnsent(state.comments)) };
      validateBatch(candidate);
      pending = candidate; state.pendingCount = candidate.comments.length;
      await persist();
    }
    if (stopped) return;
    state.status = "Sending feedback to Pi…"; draw();
    await send(connection, pending);
    const accepted = pending;
    // Receipt marks only this immutable batch. Notes remain visible, and an
    // edit of a sent note becomes a separate unsent revision instead of a resend.
    state.comments = acknowledgeComments(state.comments, accepted);
    pending = undefined; state.pendingCount = 0;
    try { await persist(); }
    catch (error) { pending = accepted; state.pendingCount = accepted.comments.length; throw error; }
    state.mode = "review";
    state.status = `Sent ${accepted.comments.length} comments to Pi. Accepted; not necessarily processed yet.`;
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearInterval(timer); onClose();
  }
  async function handle(event) {
    if (event.type === "mouse") point(event.x, event.y);
    const key = event.key;
    if (key === "quit") { stop(); return; }
    if (state.mode === "edit") {
      const action = event.type === "mouse" && event.down && event.button === 0 ? event.hit?.type : undefined;
      if (key === "escape" || action === "editorCancel") { state.mode = "review"; state.status = "Edit cancelled. Saved comments were not changed."; return; }
      if (key === "save" || action === "editorSave") {
        const result = saveComment(state.comments, { anchor: state.editor.anchor, text: state.editor.text, commentId: state.editor.commentId });
        state.comments = updateOutdated(result.comments, state.snapshot);
        state.selectedCommentId = result.commentId;
        state.commentIndex = Math.max(0, state.comments.findIndex((c) => c.id === result.commentId));
        await persist(); state.mode = "review";
        state.status = result.changed ? "Comment saved as unsent." : "No changes to save.";
        return;
      }
      if (key === "backspace") state.editor.text = Array.from(state.editor.text).slice(0, -1).join("");
      else if (key === "clearline") state.editor.text = state.editor.text.replace(/[^\n]*$/, "");
      else if (key === "enter") state.editor.text += "\n";
      else if (event.text) state.editor.text += event.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      state.editor.text = state.editor.text.slice(0, 20_000);
      return;
    }
    if (event.type === "paste") return;
    if (state.mode === "confirm") {
      if (key === "enter") {
        try { await submit(); }
        catch (error) { state.status = `${plain(error.message)} Enter retries; Esc returns. Notes are kept.`; state.mode = "confirm"; }
      } else if (key === "escape") state.mode = "review";
      return;
    }
    if (event.text === "r") { await refresh(); state.status = "Refreshed."; return; }
    if (event.text === "n" || event.text === "p") { nextComment(event.text === "n" ? 1 : -1); return; }
    if (event.text === "s" || event.text === "S" || (event.type === "mouse" && event.down && event.button === 0 && event.hit?.type === "submit")) { confirm(); return; }
    if (state.mode === "comments") {
      if (key === "escape" || event.text === "c" || event.text === "q") state.mode = "review";
      else if (key === "up" || key === "down") {
        state.commentIndex = Math.max(0, Math.min(state.comments.length - 1, state.commentIndex + (key === "up" ? -1 : 1)));
        state.selectedCommentId = state.comments[state.commentIndex]?.id;
      } else if (key === "enter") edit(state.comments[state.commentIndex]?.id);
      else if (event.text === "d") await remove(state.comments[state.commentIndex]?.id);
      else if (event.type === "mouse" && event.down && event.button === 0 && event.hit?.type === "comment") {
        state.selectedCommentId = event.hit.commentId;
        state.commentIndex = Math.max(0, state.comments.findIndex((c) => c.id === event.hit.commentId));
      }
      return;
    }
    if (event.type === "mouse") {
      if (!event.down) return;
      const hit = event.hit;
      if (event.button === 64 || event.button === 65) {
        state.focus = hit?.type === "file" ? "files" : "diff";
        await handle({ type: "key", key: event.button === 64 ? "up" : "down" }); return;
      }
      if (event.button !== 0) return;
      if (hit?.type === "file") {
        const index = state.snapshot?.files.findIndex((f) => f.path === hit.path);
        if (index >= 0) { state.fileIndex = index; state.rowIndex = 0; state.viewTop = 0; state.horizontal = 0; state.selectedCommentId = undefined; state.focus = "files"; }
      }
      if (hit?.type === "row") {
        state.focus = "diff"; state.selectedCommentId = undefined;
        const visible = state.snapshot?.files[state.fileIndex];
        if (!hit.source || (visible?.path === hit.source.filePath && visible.revision === hit.source.revision)) state.rowIndex = hit.index;
      }
      if (hit?.type === "add" && hit.source) edit(undefined, hit.source);
      if (hit?.type === "editComment") edit(hit.commentId);
      if (hit?.type === "deleteComment") await remove(hit.commentId);
      if (hit?.type === "note") { state.selectedCommentId = hit.commentId; state.focus = "diff"; }
      return;
    }
    if (key === "tab") state.focus = state.focus === "files" ? "diff" : "files";
    else if (key === "enter" || event.text === "a") {
      if (state.focus === "files") state.focus = "diff";
      else edit(state.selectedCommentId);
    } else if (event.text === "d" && state.selectedCommentId) await remove(state.selectedCommentId);
    else if (event.text === "c") { state.mode = "comments"; state.commentIndex = Math.max(0, state.comments.findIndex((c) => c.id === state.selectedCommentId)); }
    else if (event.text === "q" || key === "escape") stop();
    else if (key === "left") state.horizontal = Math.max(0, state.horizontal - 10);
    else if (key === "right") state.horizontal += 10;
    else if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key)) {
      const files = state.snapshot?.files || [];
      const prop = state.focus === "files" ? "fileIndex" : "rowIndex";
      const max = Math.max(0, (state.focus === "files" ? files.length : files[state.fileIndex]?.rows.length || 0) - 1);
      const delta = key === "up" ? -1 : key === "down" ? 1 : (key === "pageup" ? -1 : 1) * Math.max(1, rows() - 6);
      state[prop] = key === "home" ? 0 : key === "end" ? max : Math.min(max, Math.max(0, state[prop] + delta));
      state.selectedCommentId = undefined;
      if (prop === "fileIndex") { state.rowIndex = 0; state.viewTop = 0; state.horizontal = 0; }
    }
  }
  return {
    state, enqueue, handle, stop, point,
    get stopped() { return stopped; },
    render(width, height, fitLine, renderEditor) {
      lastWidth = width;
      lastFrame = frame(state, width, height, fitLine, renderEditor);
      state.viewTop = lastFrame.viewTop;
      return lastFrame;
    },
    capture(event) { return event.type === "mouse" ? { ...event, hit: hitTest(lastFrame?.hits || [], event.x, event.y) } : event; },
    start() {
      if (timer || stopped) return queue;
      timer = setInterval(() => {
        if (refreshing) return;
        refreshing = true;
        enqueue(refresh).finally(() => { refreshing = false; });
      }, 3000);
      return enqueue(refresh);
    },
  };
}
