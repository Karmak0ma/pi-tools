import { readFile } from "node:fs/promises";
import path from "node:path";
import { createReviewController } from "./controller.mjs";
import { InputDecoder, plain } from "./view.mjs";
import { registerReviewPane } from "./herdr.mjs";
import { terminalFrame } from "./terminal-frame.mjs";

/** Standalone terminal ownership is confined here; Pi never imports this app. */
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Review needs an interactive terminal.");
  const dir = process.env.VFLO_REVIEW_DIR;
  if (!dir) throw new Error("Open this review with /review in Pi.");
  const connection = JSON.parse(await readFile(path.join(dir, "connection.json"), "utf8"));
  const decoder = new InputDecoder();
  let escapeTimer, paneLifecycle;
  function draw() {
    if (controller.stopped) return;
    const rendered = controller.render(process.stdout.columns || 80, process.stdout.rows || 24);
    process.stdout.write(terminalFrame(rendered.lines, process.stdout.rows || 24));
  }
  function stop() { controller.stop(); }
  function restore() {
    clearTimeout(escapeTimer);
    process.stdin.off("data", onData);
    process.stdout.off("resize", draw);
    process.off("SIGTERM", stop); process.off("SIGHUP", stop); process.off("SIGINT", stop);
    process.stdin.setRawMode(false); process.stdin.pause();
    process.stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l");
    // Herdr may already have removed the pane after SIGHUP.
    void paneLifecycle?.close().catch(() => {});
  }
  const controller = await createReviewController({ connection, dir, onChange: draw, onClose: restore, rows: () => process.stdout.rows || 24 });
  function onData(chunk) {
    clearTimeout(escapeTimer);
    const events = decoder.feed(chunk).map((event) => controller.capture(event)).filter((event) => {
      // All-motion reports need no async work or persistence. Coalesce moves
      // within one row; do not queue hundreds of them behind a Git refresh.
      if (event.type === "mouse" && (event.button & 32)) { controller.point(event.x, event.y); return false; }
      return true;
    });
    controller.enqueue(async () => { for (const event of events) { if (!controller.stopped) await controller.handle(event); } });
    escapeTimer = setTimeout(() => controller.enqueue(async () => {
      for (const event of decoder.flushEscape()) await controller.handle(event);
    }), 40);
  }
  paneLifecycle = await registerReviewPane();
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2J");
  process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.resume();
  process.stdin.on("data", onData); process.stdout.on("resize", draw);
  process.on("SIGTERM", stop); process.on("SIGHUP", stop); process.on("SIGINT", stop);
  await controller.start();
}

main().catch((error) => { console.error(`Review: ${plain(error.message)}`); process.exitCode = 1; });
