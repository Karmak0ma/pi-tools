// All repository text is untrusted terminal data. Strip control bytes before
// rendering, including OSC/CSI introducers; never allow a diff to set modes.
export function plain(value) {
  return String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ").replace(/[\r\n]/g, " ");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function cells(s) {
  const n = s.codePointAt(0);
  if (/^\p{Mark}+$/u.test(s)) return 0;
  return /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u20e3/u.test(s) || (n >= 0x1100 && (
    n <= 0x115f || n === 0x2329 || n === 0x232a ||
    (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) ||
    (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe6f) ||
    (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) || n >= 0x20000
  )) ? 2 : 1;
}

/** Fixed cell widths keep mouse hit coordinates aligned with wide source text. */
export function fit(value, width, offset = 0) {
  let result = "", position = 0, used = 0;
  for (const { segment } of segmenter.segment(plain(value))) {
    const size = cells(segment);
    const end = position + size;
    if (position >= offset && used + size <= width) { result += segment; used += size; }
    else if (position < offset && end > offset && used < width) { result += " "; used++; }
    else if (position >= offset) break;
    position = end;
  }
  return result + " ".repeat(Math.max(0, width - used));
}

export function anchor(file, row) {
  // Commit IDs identify the original code even when named branches advance.
  const commits = file.baseCommit ? { baseCommit: file.baseCommit, tipCommit: file.tipCommit } : {};
  if (row.newLine) return { filePath: file.path, path: file.path, side: "new", line: row.newLine, quote: row.text.slice(0, 20_000), revision: file.revision, outdated: false, ...commits };
  if (row.oldLine) return { filePath: file.path, path: file.oldPath || file.path, side: "old", line: row.oldLine, quote: row.text.slice(0, 20_000), revision: file.revision, outdated: false, ...commits };
  return undefined;
}

export function updateOutdated(comments, snapshot) {
  return comments.map((comment) => ({ ...comment, outdated: !snapshot.files.some((f) => f.path === comment.filePath && f.revision === comment.revision) }));
}

// Paint the padded source row, not only the +/- character: users must be
// able to distinguish additions/deletions while scanning a wide diff. Keep
// keyboard focus bold rather than inverse so it cannot erase that distinction.
const ansi = {
  add: "\x1b[48;2;21;52;32m\x1b[38;2;169;209;173m",
  delete: "\x1b[48;2;63;29;33m\x1b[38;2;226;161;165m",
  hunk: "\x1b[38;2;122;162;190m", meta: "\x1b[90m", context: "",
};
const hoverStyle = "\x1b[48;2;57;64;71m\x1b[38;2;231;233;235m";
const noteBackground = "\x1b[48;2;29;37;43m";
const noteText = "\x1b[38;2;216;221;225m";
const noteBorder = "\x1b[38;2;196;154;71m";
const placeholderStyle = "\x1b[38;2;113;123;131m";

export function matchesAnchor(comment, source) {
  return !!source && comment.filePath === source.filePath && comment.revision === source.revision &&
    comment.side === source.side && comment.line === source.line;
}

function rawEditorLines(text, width, limit) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "", used = 0;
    for (const { segment } of segmenter.segment(plain(paragraph))) {
      const size = cells(segment);
      if (used + size > width) { lines.push(line); line = ""; used = 0; }
      line += segment; used += size;
    }
    lines.push(line);
  }
  return lines.slice(-limit);
}

/**
 * The right pane is a single list of source rows, notes and an inline editor.
 * Hit regions come from that same list: insertion, scrolling and resize cannot
 * turn a click on source text into an add-comment action.
 */
export function frame(state, width, height, fitLine = fit, renderEditor) {
  width = Math.max(1, width); height = Math.max(1, height);
  const lines = [], hits = [];
  const put = (text, style = "") => lines.push(style + fitLine(text, width) + "\x1b[0m");
  if (width < 64 || height < 16) {
    put("Review: enlarge pane to at least 64 columns x 16 rows.");
    put("q: close (saved comments are kept)");
    return { lines, hits, viewTop: state.viewTop || 0 };
  }
  const comments = state.comments;
  const unsent = comments.filter((c) => !c.sentAt).length;
  const sent = comments.length - unsent;
  put(`Git review | ${state.snapshot?.comparison?.expression || state.comparison || "working tree vs HEAD"} | ${state.snapshot?.root || "Loading repository…"}`, "\x1b[1m");
  function footer() {
    put("Tab: files/diff | Enter: add/edit | n/p: next/previous comment | c: list");
    put(state.mode === "confirm" ? `Submit ${state.pendingCount || unsent} unsent comments to Pi? Enter: send | Esc: cancel` :
      `[s] Send ${unsent} unsent | ${sent} sent to Pi | [r] Refresh | [q] Close`, "\x1b[36m");
    if (state.mode !== "confirm") hits.push({ x1: 1, x2: 18, y: lines.length, type: "submit" });
    put(state.status || "Hover a source line to comment. Sent means accepted by Pi, not acted on.");
  }
  if (state.mode === "comments") {
    put("Comments | Enter: edit | d: delete unsent | n/p: navigate | Esc: return", "\x1b[36m");
    const start = Math.max(0, state.commentIndex - (height - 6));
    for (let i = start; i < Math.min(comments.length, start + height - 5); i++) {
      const c = comments[i];
      put(`${i + 1}. [${c.sentAt ? "Sent to Pi" : "Unsent"} r${c.revisionNumber || 1}] ${c.outdated ? "[OUTDATED] " : ""}${c.path}:${c.line} ${c.text}`,
        i === state.commentIndex ? "\x1b[7m" : "");
      hits.push({ x1: 1, x2: width, y: lines.length, type: "comment", commentId: c.id });
    }
    while (lines.length < height - 3) put("");
    footer();
    return { lines, hits, viewTop: state.viewTop || 0 };
  }
  const left = Math.min(32, Math.max(20, Math.floor(width * 0.27)));
  const right = width - left - 1;
  const count = height - 5;
  const files = state.snapshot?.files || [];
  const file = files[state.fileIndex];
  const items = [];
  let target = -1, editorStart = -1, editorEnd = -1, bodyStart = -1, bodyLength = 0;
  const selected = comments.find((c) => c.id === state.selectedCommentId);
  const editorSource = state.mode === "edit" ? state.editor.anchor : undefined;
  const matchesRow = (c, row) => c && c.filePath === file?.path && c.revision === file?.revision &&
    c.line === (c.side === "new" ? row.newLine : row.oldLine);
  const editorRow = editorSource ? file?.rows.findIndex((row) => matchesRow(editorSource, row)) ?? -1 : -1;
  const selectedRow = selected ? file?.rows.findIndex((row) => matchesRow(selected, row)) ?? -1 : -1;
  function note(c) {
    if (state.mode === "edit" && c.id === state.editor.commentId && !c.sentAt) return;
    const actions = c.sentAt ? "[Edit]" : "[Edit] [x]";
    const actionStart = right - actions.length - 1;
    const ranges = [{ type: "editComment", commentId: c.id, start: actionStart, end: actionStart + 5 }];
    if (!c.sentAt) ranges.push({ type: "deleteComment", commentId: c.id, start: actionStart + 7, end: actionStart + 9 });
    const label = `${c.sentAt ? "Sent to Pi" : "Unsent"} r${c.revisionNumber || 1}${c.outdated ? " OUTDATED" : ""}`;
    if (c.id === state.selectedCommentId) target = items.length;
    items.push({ text: fitLine(`╭─ ${label} `, actionStart) + actions + "╮", ranges, noteId: c.id, style: c.sentAt ? "\x1b[32m" : noteBorder });
    const paragraphs = c.text.split("\n");
    for (const text of paragraphs.slice(0, 3)) items.push({ text: "│ " + fitLine(text, right - 4) + " │", noteId: c.id, style: noteBackground + noteText });
    if (paragraphs.length > 3) items.push({ text: "│ " + fitLine("… Edit to read the full comment", right - 4) + " │", noteId: c.id, style: noteBackground + noteText });
    items.push({ text: "╰" + "─".repeat(right - 2) + "╯", noteId: c.id, style: c.sentAt ? "\x1b[32m" : noteBorder });
  }
  let editorX, editorWidth;
  function editorBox() {
    editorStart = items.length;
    const indent = 2, boxWidth = right - indent - 1, bodyWidth = boxWidth - 4;
    const lead = " ".repeat(indent), tail = " ";
    const source = state.editor.anchor;
    const title = fitLine(`─ Draft note · ${source.path} ${source.side === "new" ? "R" : "L"}${source.line} `, boxWidth - 2)
      .replace(/ +$/, (spaces) => "─".repeat(spaces.length));
    function border(text, ranges) {
      items.push({ text: lead + noteBackground + noteBorder + text + "\x1b[0m" + tail, trusted: true, ranges });
    }
    function bodyRow(text, trusted = false) {
      // Only host-rendered editor lines may carry cursor/style sequences. All
      // repository/user strings pass through fitLine before this trusted shell.
      const content = trusted ? text : fitLine(text, bodyWidth);
      items.push({ text: lead + noteBackground + noteBorder + "│ " + noteText + content + noteBorder + " │\x1b[0m" + tail, trusted: true });
    }
    border("╭" + title + "╮");
    bodyRow("");
    // Reserve space for the source row, padding and attached action buttons.
    // The Pi adapter crops its own border, retaining the actual text cursor.
    const maxRows = Math.max(1, count - 7);
    const body = renderEditor ? renderEditor(bodyWidth, maxRows) : rawEditorLines(state.editor.text, bodyWidth, Math.min(3, maxRows));
    bodyStart = items.length; bodyLength = body.length;
    editorX = left + 2 + indent + 2; editorWidth = bodyWidth;
    for (const [index, text] of body.entries()) {
      if (!renderEditor && !state.editor.text && index === 0) bodyRow(placeholderStyle + fitLine("Write a note…", bodyWidth), true);
      else bodyRow(text, !!renderEditor);
    }
    bodyRow("");
    const save = " Save (^S) ", cancel = " Cancel (Esc) ";
    const buttonsWidth = save.length + cancel.length + 3;
    const buttonsStart = boxWidth - buttonsWidth;
    border("╰" + "─".repeat(buttonsStart - 1) + "┬" + "─".repeat(save.length) + "┬" + "─".repeat(cancel.length) + "┤");
    border(" ".repeat(buttonsStart) + "│" + save + "│" + cancel + "│", [
      { type: "editorSave", start: indent + buttonsStart + 1, end: indent + buttonsStart + save.length },
      { type: "editorCancel", start: indent + buttonsStart + save.length + 2, end: indent + boxWidth - 2 },
    ]);
    border(" ".repeat(buttonsStart) + "╰" + "─".repeat(save.length) + "┴" + "─".repeat(cancel.length) + "╯");
    editorEnd = items.length - 1;
  }
  const orphan = (editorSource && editorRow < 0) || (selected && selectedRow < 0);
  if (orphan) {
    const source = editorSource || selected;
    items.push({ text: `Original snapshot: ${source.path}:${source.line} [OUTDATED]`, style: "\x1b[33m" });
    items.push({ text: `> ${source.quote}` });
    if (editorSource) editorBox(); else note(selected);
  }
  // Group notes once, rather than scanning the full history for every source
  // row. Only exact reviewed fingerprints can attach notes to current code.
  const notes = new Map();
  for (const c of comments) {
    if (c.filePath !== file?.path || c.revision !== file?.revision) continue;
    const key = `${c.side}:${c.line}`;
    if (!notes.has(key)) notes.set(key, []);
    notes.get(key).push(c);
  }
  for (const [index, row] of (file?.rows || []).entries()) {
    if (index === state.rowIndex && target < 0) target = items.length;
    items.push({ row, index });
    if (editorSource && index === editorRow) editorBox();
    const rowNotes = [...(notes.get(`old:${row.oldLine}`) || []), ...(notes.get(`new:${row.newLine}`) || [])];
    for (const c of rowNotes) note(c);
  }
  let top = state.viewTop || 0;
  if (state.mode === "edit" && editorStart >= 0) {
    // Keep both the selected source line and the whole inline editor visible.
    if (editorStart - 1 < top) top = Math.max(0, editorStart - 1);
    if (editorEnd >= top + count) top = editorEnd - count + 1;
  } else if (target >= 0) {
    if (target < top) top = target;
    if (target >= top + count) top = target - count + 1;
  }
  top = Math.max(0, Math.min(top, Math.max(0, items.length - count)));
  const title = orphan ? `Original: ${(editorSource || selected).path}:${(editorSource || selected).line} [OUTDATED]` : file ? `${file.path}  +${file.added} −${file.deleted}${file.binary ? " [binary]" : ""}` : "No changes in this comparison";
  lines.push(fitLine(`Files (${files.length})`, left) + "│" + fitLine(title, right));
  const fileStart = Math.max(0, state.fileIndex - count + 1);
  for (let i = 0; i < count; i++) {
    const fi = fileStart + i, f = files[fi], item = items[top + i];
    const lStyle = fi === state.fileIndex ? (state.focus === "files" ? "\x1b[7m" : "\x1b[1m") : "";
    let text = "", style = item?.style || "";
    if (item?.row) {
      const row = item.row;
      const source = anchor(file, row);
      const prefix = `${String(row.oldLine || "").padStart(5)} ${String(row.newLine || "").padStart(5)} ${row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " "}`;
      const hovered = source && state.pointer?.y === lines.length + 1 && state.pointer.x >= left + 2 && state.pointer.x <= width;
      // Keep the action column fixed while panning. One cell of right margin
      // prevents the action from appearing attached to the terminal edge.
      text = fitLine(prefix + row.text, right - 5, state.horizontal) + " " + (hovered ? "[+]" : "   ") + " ";
      style = hovered ? hoverStyle : ansi[row.kind] || "";
      if (item.index === state.rowIndex && state.focus === "diff") style += "\x1b[1m";
      hits.push({ x1: left + 2, x2: width - 4, y: lines.length + 1, type: "row", index: item.index, source });
      // A press can arrive without a preceding move (some terminals do not
      // report hover). Its coordinates still identify this exact action slot.
      if (source) hits.push({ x1: width - 3, x2: width - 1, y: lines.length + 1, type: "add", index: item.index, source });
    } else if (item) text = item.text;
    if (item?.noteId && item.noteId === state.selectedCommentId) style += "\x1b[1m";
    lines.push(lStyle + fitLine(f ? `${f.status} ${f.path} +${f.added} −${f.deleted}` : "", left) + "\x1b[0m│" + style +
      (item && !item.row ? (item.trusted ? text : fitLine(text, right)) : text || fitLine("", right)) + "\x1b[0m");
    if (f) hits.push({ x1: 1, x2: left, y: lines.length, type: "file", index: fi, path: f.path });
    for (const range of item?.ranges || []) hits.push({ x1: left + 2 + range.start, x2: left + 2 + range.end, y: lines.length, ...range });
    if (item?.noteId) hits.push({ x1: left + 2, x2: width, y: lines.length, type: "note", commentId: item.noteId });
  }
  footer();
  const editorBounds = bodyStart >= top && bodyStart + bodyLength <= top + count ?
    { x: editorX, y: 3 + bodyStart - top, width: editorWidth, height: bodyLength } : undefined;
  return { lines, hits, editorBounds, viewTop: top };
}

export function hitTest(hits, x, y) { return hits.find((h) => h.y === y && x >= h.x1 && x <= h.x2); }

/** Streaming input: terminal escape sequences can span several stdin chunks. */
export class InputDecoder {
  buffer = "";
  paste = false;
  feed(chunk) {
    this.buffer += chunk;
    const events = [];
    while (this.buffer) {
      if (this.buffer.startsWith("\x1b[200~")) { this.paste = true; this.buffer = this.buffer.slice(6); continue; }
      if (this.buffer.startsWith("\x1b[201~")) { this.paste = false; this.buffer = this.buffer.slice(6); continue; }
      if (this.paste) {
        // A pasted escape or mouse packet is text, never a UI action. Keep a
        // partial end marker buffered until the next stdin chunk arrives.
        if ("\x1b[201~".startsWith(this.buffer)) break;
        const character = String.fromCodePoint(this.buffer.codePointAt(0));
        events.push({ type: "paste", text: character });
        this.buffer = this.buffer.slice(character.length); continue;
      }
      if (this.buffer.startsWith("\x1b[<")) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer);
        if (!match && this.buffer.length < 40) break;
        if (match) {
          events.push({ type: "mouse", button: +match[1], x: +match[2], y: +match[3], down: match[4] === "M" });
          this.buffer = this.buffer.slice(match[0].length); continue;
        }
      }
      if (this.buffer[0] === "\x1b") {
        if (/^\x1b(?:\[[0-9;<]*)?$/.test(this.buffer)) break;
        const match = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(this.buffer);
        if (match) {
          if (!this.paste) events.push({ type: "key", key: ({ "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[H": "home", "\x1b[F": "end", "\x1bOH": "home", "\x1bOF": "end" })[match[0]] || "unknown" });
          this.buffer = this.buffer.slice(match[0].length); continue;
        }
        events.push({ type: "key", key: "escape" }); this.buffer = this.buffer.slice(1); continue;
      }
      const character = String.fromCodePoint(this.buffer.codePointAt(0));
      this.buffer = this.buffer.slice(character.length);
      if (this.paste) { events.push({ type: "paste", text: character }); continue; }
      const key = ({ "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x13": "save", "\x03": "quit", "\x15": "clearline" })[character];
      events.push(key ? { type: "key", key } : { type: "text", text: character });
    }
    return events;
  }
  // Escape alone is ambiguous until the next chunk; a short UI timer resolves it.
  flushEscape() {
    if (!this.paste && this.buffer === "\x1b") { this.buffer = ""; return [{ type: "key", key: "escape" }]; }
    return [];
  }
}
