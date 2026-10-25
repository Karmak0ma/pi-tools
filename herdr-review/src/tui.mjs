import { readFile } from "node:fs/promises";
import path from "node:path";
import { createReviewController } from "./controller.mjs";
import { InputDecoder, plain } from "./view.mjs";
import { registerReviewPane } from "./herdr.mjs";
import { terminalFrame } from "./terminal-frame.mjs";
import { createTextSelection, clipboardSequence } from "./text-selection.mjs";

/** Standalone terminal ownership is confined here; Pi never imports this app. */
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Review needs an interactive terminal.");
  const dir = process.env.VFLO_REVIEW_DIR;
  if (!dir) throw new Error("Open this review with /review in Pi.");
  const connection = JSON.parse(await readFile(path.join(dir, "connection.json"), "utf8"));
  const decoder = new InputDecoder();
  let escapeTimer, paneLifecycle, previousLines, previousSize, selection, lastFrame;
  function draw() {
    if (controller.stopped) return;
    const rendered = selection?.render() || controller.render(process.stdout.columns || 80, process.stdout.rows || 24);
    lastFrame = rendered;
    const size = `${process.stdout.columns}x${process.stdout.rows}`;
    process.stdout.write(terminalFrame(rendered.lines, process.stdout.rows || 24, size === previousSize ? previousLines : undefined));
    previousLines = rendered.lines; previousSize = size;
  }
  function stop() { controller.stop(); }
  function restore() {
    clearTimeout(escapeTimer);
    process.stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    process.off("SIGTERM", stop); process.off("SIGHUP", stop); process.off("SIGINT", stop);
    process.stdin.setRawMode(false); process.stdin.pause();
    process.stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l");
    // Herdr may already have removed the pane after SIGHUP.
    void paneLifecycle?.close().catch(() => {});
  }
  const controller = await createReviewController({
    connection, dir, onChange: draw, onClose: restore, rows: () => process.stdout.rows || 24,
    onMouseCapture: (enabled) => process.stdout.write(enabled
      ? "\x1b[?1000h\x1b[?1003h\x1b[?1006h"
      : "\x1b[?1000l\x1b[?1003l\x1b[?1006l"),
  });
  selection = createTextSelection({
    onChange: draw,
    onActive: (active) => { controller.state.selecting = active; },
    copy: (text) => process.stdout.write(clipboardSequence(text)),
    click: (event) => controller.enqueue(() => controller.handle(event)),
  });
  function onResize() {
    // A frozen selection uses the old cell coordinates. Clear it rather than
    // copying a different slice after the host changes the pane dimensions.
    selection.clear(); draw();
  }
  function onData(chunk) {
    clearTimeout(escapeTimer);
    const events = [];
    for (const rawEvent of decoder.feed(chunk)) {
      // Resolve each hit after earlier drag packets have updated the layout.
      // One stdin read can contain the release and next press of two gestures.
      const event = controller.capture(rawEvent);
      // Divider capture must run before text selection and hover filtering;
      // otherwise drag reports would be mistaken for pointer-only motion.
      if (controller.resizeDivider(event)) { selection.clear(); continue; }
      if (!controller.state.copyMode && controller.state.mode === "review" && selection.handle(event, lastFrame)) continue;
      // All-motion reports need no async work or persistence. Coalesce moves
      // within one row; do not queue hundreds of them behind a Git refresh.
      if (event.type === "mouse" && (event.button & 32)) { controller.point(event.x, event.y); continue; }
      events.push(event);
    }
    if (events.length) controller.enqueue(async () => { for (const event of events) { if (!controller.stopped) await controller.handle(event); } });
    // An isolated Escape produces no event until its timeout. Still arm it
    // after an empty decode, but do not schedule a repaint for pointer moves.
    escapeTimer = setTimeout(() => {
      const escaped = decoder.flushEscape();
      if (escaped.length) controller.enqueue(async () => {
        for (const event of escaped) await controller.handle(event);
      });
    }, 40);
  }
  // Sidebar plugins such as herdr-radar derive their title tokens from the
  // terminal title. Publish it before agent registration so their first frame
  // is not empty. Do not compete for the plugins\' state-specific token keys.
  process.stdout.write("\x1b]2;review\x07");
  paneLifecycle = await registerReviewPane();
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2J");
  process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.resume();
  process.stdin.on("data", onData); process.stdout.on("resize", onResize);
  process.on("SIGTERM", stop); process.on("SIGHUP", stop); process.on("SIGINT", stop);
  await controller.start();
}

main().catch((error) => { console.error(`Review: ${plain(error.message)}`); process.exitCode = 1; });
