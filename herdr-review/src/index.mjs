import { fileURLToPath } from "node:url";
import { repositoryRoot, normalizeComparison, resolveComparison } from "./git.mjs";
import { createBridge } from "./protocol.mjs";
import { runHerdr } from "./herdr.mjs";
import { openPiReview } from "./pi-ui.mjs";

/** A small launch interface also lets tests exercise real lifecycle decisions. */
export function registerReview(pi, dependencies = {}) {
  const run = dependencies.herdr || runHerdr;
  const findRoot = dependencies.repositoryRoot || repositoryRoot;
  const resolve = dependencies.resolveComparison || resolveComparison;
  const makeBridge = dependencies.createBridge || createBridge;
  const showPiReview = dependencies.openPiReview || openPiReview;
  const env = dependencies.env || process.env;
  let generation = 0;
  const runtimes = new Map();
  const pending = new Map();
  let opening = Promise.resolve();

  async function open(ctx, comparison, epoch, sessionId) {
    const current = () => epoch === generation && ctx.sessionManager.getSessionId() === sessionId;
    if (!current()) return;
    if (ctx.mode !== "tui") throw new Error("Review requires Pi's interactive terminal mode.");
    const root = await findRoot(ctx.cwd);
    if (!current()) return;
    // Validate revisions before opening a pane or disturbing existing drafts.
    if (comparison) await resolve(root, comparison);
    if (!current()) return;
    for (const [key, runtime] of runtimes) {
      if (runtime.sessionId !== sessionId || runtime.root !== root) {
        runtimes.delete(key);
        runtime.closeUI?.();
        await runtime.bridge.close();
        if (!current()) return;
      }
    }
    // Each comparison has its own socket, pane and draft file. Changing scope
    // must not silently relabel old comments or strand another open review.
    let runtime = runtimes.get(comparison);
    if (runtime?.paneId) {
      try { await run(["plugin", "pane", "focus", runtime.paneId]); return; }
      catch { runtime.paneId = undefined; }
    }
    if (!runtime) {
      const bridge = await makeBridge({
        root, sessionId, comparison, isCurrent: current,
        // Follow-up does not interrupt an active tool or overwrite the editor.
        // Disable template expansion so comment text cannot invoke /commands.
        deliver: (text) => pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false }),
      });
      if (!current()) { await bridge.close(); return; }
      runtime = { root, sessionId, bridge };
      runtimes.set(comparison, runtime);
    }
    if (env.HERDR_ENV !== "1") {
      await showPiReview(ctx, {
        dir: runtime.bridge.dir, isCurrent: current,
        registerClose: (close) => { runtime.closeUI = close; },
      });
      return;
    }
    const result = await run(["pane", "current", "--current"]);
    if (!current()) return;
    // Split the caller's live pane, never whichever agent the UI currently
    // happens to focus. Herdr returns fresh IDs after workspace moves.
    const paneId = result.pane?.pane_id;
    if (!paneId) throw new Error("Herdr did not identify the calling pane.");
    const opened = await run([
      "plugin", "pane", "open", "--plugin", "vflo.review", "--entrypoint", "review",
      "--placement", "split", "--target-pane", paneId, "--direction", "right",
      "--cwd", root, "--focus",
      "--env", `VFLO_REVIEW_APP=${new URL("./tui.mjs", import.meta.url).href}`,
      "--env", `VFLO_REVIEW_DIR=${runtime.bridge.dir}`,
    ]);
    if (current()) runtime.paneId = opened.plugin_pane?.pane?.pane_id;
  }

  const handler = async (args, ctx) => {
    let comparison;
    try { comparison = normalizeComparison(args); }
    catch (error) { ctx.ui.notify(`Review: ${error.message}`, "error"); return; }
    const epoch = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const key = JSON.stringify([epoch, sessionId, ctx.cwd, comparison]);
    // Double presses share one request. Different comparisons are serialized,
    // not discarded, and retain the session identity from command invocation.
    if (pending.has(key)) return pending.get(key);
    const task = opening.then(() => open(ctx, comparison, epoch, sessionId)).catch((error) => {
      const hint = /plugin/i.test(error.message) ? `\nIf the plugin is missing, run: herdr plugin link ${fileURLToPath(new URL("..", import.meta.url))}` : "";
      ctx.ui.notify(`Review: ${error.message}${hint}`, "error");
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    opening = task;
    return task;
  };
  pi.registerCommand("review", { description: "Review Git changes, optionally with base...tip or base..tip", handler });
  pi.registerShortcut("alt+r", { description: "Open repository review", handler: (ctx) => handler("", ctx) });
  pi.on("session_shutdown", async () => {
    generation++;
    const old = [...runtimes.values()];
    runtimes.clear();
    // Leave panes readable. Closing their sockets rejects delivery to a new
    // session while keeping each comparison's draft file for manual recovery.
    for (const runtime of old) runtime.closeUI?.();
    await Promise.all(old.map((runtime) => runtime.bridge.close()));
  });
}

