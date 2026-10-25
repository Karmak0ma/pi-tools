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
      let focused;
      try { focused = await run(["plugin", "pane", "focus", runtime.paneId]); }
      catch { runtime.paneId = undefined; }
      if (runtime.paneId) {
        runtime.tabId = focused?.plugin_pane?.pane?.tab_id || runtime.tabId;
        await arrangeReview(runtime, comparison, current);
        return;
      }
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
    const caller = await reviewCaller(current);
    if (!caller) return;
    const paneId = caller.pane_id;
    const opened = await run([
      "plugin", "pane", "open", "--plugin", "vflo.review", "--entrypoint", "review",
      "--placement", "split", "--direction", "right", "--target-pane", paneId,
      "--cwd", root, "--focus",
      "--env", `VFLO_REVIEW_APP=${new URL("./tui.mjs", import.meta.url).href}`,
      "--env", `VFLO_REVIEW_DIR=${runtime.bridge.dir}`,
    ]);
    // If shutdown won the race with Herdr's open command, close only the
    // reviewer we just created. Do not leave an untracked pane behind.
    if (!current()) {
      const stalePane = opened.plugin_pane?.pane?.pane_id;
      if (stalePane) await run(["pane", "close", stalePane]);
      return;
    }
    runtime.paneId = opened.plugin_pane?.pane?.pane_id;
    runtime.tabId = opened.plugin_pane?.pane?.tab_id;
    if (!runtime.paneId || !runtime.tabId) throw new Error("Herdr did not identify the review pane and tab.");
    // Plugin focus can target the pane without switching the visible tab on
    // some Herdr versions. Explicit tab focus makes /review switch screens.
    await run(["tab", "rename", runtime.tabId, comparison ? `Review ${comparison}` : "Review"]);
    if (current()) await run(["tab", "focus", runtime.tabId]);
  }

  // A split inside the caller's old tile would inherit that tile's small size.
  // Move only the calling agent into a new tab first. Plugin splits use 0.5,
  // so the agent and reviewer each receive half of the full tab. Other panes
  // stay where they were; Herdr removes a source tab only when it is empty.
  async function reviewCaller(current, existingTab) {
    if (!current()) return;
    const result = await run(["pane", "current", "--current"]);
    if (!current()) return;
    const caller = result.pane;
    if (!caller?.pane_id) throw new Error("Herdr did not identify the calling pane.");
    if (existingTab && caller.tab_id === existingTab) return caller;
    const moved = await run(["pane", "move", caller.pane_id, "--new-tab", "--no-focus"]);
    const pane = moved.move_result?.pane;
    if (!pane?.pane_id || !pane.tab_id) throw new Error("Herdr did not identify the moved calling pane.");
    return current() ? pane : undefined;
  }

  async function arrangeReview(runtime, comparison, current) {
    const caller = await reviewCaller(current, runtime.tabId);
    if (!caller) return;
    // One agent cannot occupy several comparison tabs at once. Bring the
    // matching saved reviewer alongside it when switching comparisons.
    if (caller.tab_id !== runtime.tabId) {
      const moved = await run(["pane", "move", runtime.paneId, "--tab", caller.tab_id,
        "--split", "right", "--target-pane", caller.pane_id, "--ratio", "0.5", "--no-focus"]);
      const pane = moved.move_result?.pane;
      if (!pane?.pane_id || !pane.tab_id) throw new Error("Herdr did not identify the moved review pane.");
      runtime.paneId = pane.pane_id;
      runtime.tabId = pane.tab_id;
    }
    if (!current()) return;
    await run(["tab", "rename", runtime.tabId, comparison ? `Review ${comparison}` : "Review"]);
    if (!current()) return;
    await run(["plugin", "pane", "focus", runtime.paneId]);
    if (current()) await run(["tab", "focus", runtime.tabId]);
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

