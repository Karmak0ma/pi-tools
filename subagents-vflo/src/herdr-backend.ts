/**
 * Herdr execution backend.
 *
 * Spawns each subagent as a real interactive pi session inside a new Herdr
 * pane in the parent's workspace, and observes it through the session JSONL
 * it writes. There is no RPC channel: the pane is the user's window into the
 * child, and the JSONL is the parent's source of truth.
 *
 * Lifecycle semantics (the contract shared with the default backend):
 * - The task completes only after an assistant turn ends normally
 *   (stopReason "stop" in the session JSONL) AND the child run has really
 *   settled. A "stop" entry alone is NOT enough: an extension can return
 *   `continue: true` from `turn_end` and start another model request in the
 *   same run (claude-tool-repair does this when Claude writes a tool call as
 *   text). Completing on the first "stop" made the parent take an
 *   unfinished answer while the child kept working. So a "stop" entry only
 *   makes completion PENDING; the task completes when Herdr reports the
 *   child idle/done (the lifecycle hook reports idle only on Pi's
 *   `agent_settled`). If that status never arrives (hook missing or its
 *   socket report lost) and no continuation entry follows the stop, a
 *   fallback timer completes the task anyway. Herdr status alone, without a
 *   pending "stop", is still never treated as completion.
 * - An interrupted turn (stopReason "aborted", e.g. the user pressed Escape
 *   inside the pane) does NOT complete the task. The pane and session stay
 *   alive so the user can give the subagent corrective input directly; a
 *   later normal turn completion still delivers the result automatically.
 * - Pane death is a task-level terminal event, separate from an aborted turn:
 *   an interrupted task becomes `closed` (with cancellation text), an
 *   errored task becomes `failed`, and an otherwise active task becomes
 *   `closed`. A dead pane is never a successful completion.
 * - Parent abort (control.abort) closes the pane and resolves as `closed`.
 * - An errored turn (stopReason "error") works like "stop": it only makes
 *   FAILURE pending. Pi retries transient provider errors inside the same
 *   run (it writes a `context_edit` entry, waits with backoff, then asks the
 *   model again), so the error entry is not the end of the run. Failing on
 *   a short timer here once failed a task while the child's retry was still
 *   running: the parent started a second child and both edited the same
 *   files. So the task fails when Herdr reports the child idle/done (all
 *   retries are spent), and any later assistant message cancels the
 *   pending failure. This mirrors the RPC runner, which waits for
 *   `agent_settled`.
 * - Both pending states have a fallback timer for a lost idle/done status.
 *   A continuation entry (custom_message, user, context_edit) cancels the
 *   timer. When the timer settles the task, the child's state is unknown,
 *   so the backend also CLOSES the pane: a child that is in fact still
 *   running must not keep working after the parent stopped watching it.
 *   Closing the pane sends SIGHUP; pi then stops its retries and the bash
 *   processes it tracks, and exits. The session JSONL stays on disk.
 */

import * as fs from "node:fs";
import {
  createSubagentSessionDir,
  currentNestingDepth,
  nestingDepthRefusal,
  NESTING_DEPTH_ENV,
  writePromptToTempFile,
  type ChildRunResult,
} from "./runner.js";
import { HERDR_PANE_ID_VAR, resolveHerdrAgentStateExtension, type HerdrClient } from "./herdr.js";
import { canonicalEntryPath } from "./path-utils.js";
import { SessionWatcher } from "./session-watcher.js";
import type { SubagentBackend, SubagentHandle, SubagentSpec } from "./backends.js";
import type { SubagentProcessControl } from "./tracker.js";
import {
  clearPendingTimer,
  contextTokensFromUsage,
  emptyUsage,
  type SubagentLifecycleState,
} from "./types.js";

/** Below this width a right-split would produce unusably narrow panes. */
const MIN_RIGHT_SPLIT_WIDTH = 160;

/** How many consecutive pane-poll failures imply the Herdr server is gone. */
const MAX_PANE_POLL_FAILURES = 3;

/**
 * Maximum time after the first prompt for Herdr to observe the child begin a
 * turn. This is a notification/deadline, not a recovery attempt: if the
 * child stays idle this long, the result reports a specific startup failure.
 */
const DEFAULT_STARTUP_ACTIVITY_TIMEOUT_MS = 30_000;

export interface HerdrBackendOptions {
  cli: HerdrClient;
  /** Pane/session polling cadence. */
  pollIntervalMs?: number;
  /**
   * Time after an errored turn with no continuation entry before the task
   * fails even though Herdr never reported idle/done. Safety net only.
   */
  errorSettleGraceMs?: number;
  /** Combined budget for agent start and the following readiness gate (see startHerdrAgent). */
  agentStartTimeoutMs?: number;
  /** Maximum time after the initial prompt to observe working or blocked state. */
  startupActivityTimeoutMs?: number;
  /**
   * Time after a "stop" turn with no continuation entry before the task
   * completes even though Herdr never reported idle/done. Safety net only.
   */
  completionFallbackMs?: number;
}

interface ResolvedTimings {
  pollIntervalMs: number;
  errorSettleGraceMs: number;
  agentStartTimeoutMs: number;
  startupActivityTimeoutMs: number;
  completionFallbackMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/**
 * Long on purpose. The normal completion path is the idle/done status, which
 * arrives within one poll interval of the child settling. This timer only
 * matters when that status is lost, so it trades a late result for never
 * completing on a turn that the child is about to continue. 120s is far
 * longer than the gap between a "stop" entry and the continuation entry an
 * extension writes in the same `turn_end` (milliseconds in practice).
 */
const DEFAULT_COMPLETION_FALLBACK_MS = 120_000;
/** Herdr statuses that mean the child pi is not running a turn. */
const SETTLED_AGENT_STATUSES = new Set(["idle", "done"]);
/**
 * Same reasoning as DEFAULT_COMPLETION_FALLBACK_MS. The old 30s value was
 * shorter than one pi retry cycle (backoff up to 60s plus model thinking
 * time), so it failed tasks whose retry later succeeded.
 */
const DEFAULT_ERROR_SETTLE_GRACE_MS = 120_000;
const DEFAULT_AGENT_START_TIMEOUT_MS = 60_000;

/**
 * Herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique among live
 * agents. A short random suffix keeps concurrent spawns collision-free.
 */
function deriveHerdrAgentName(agentName: string): string {
  const base = agentName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 20);
  return `sa-${base || "agent"}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Session display name for pi (--name); shows up as the pane title. */
function deriveSessionName(agentName: string): string {
  return agentName.replace(/[^\w.-]+/g, "-").slice(0, 40) || "subagent";
}

/**
 * Build the interactive child pi argv: identical configuration surface to the
 * RPC runner (extensions, model, thinking, tools, agent prompt) minus RPC
 * mode, plus a session display name for the pane title.
 *
 * The task itself deliberately does NOT ride in here as a trailing positional.
 * Pi's `[messages...]` positional would avoid a typed-input startup race, but
 * Herdr rejects any argv value containing a newline (`invalid_agent_argument`)
 * before the child ever starts. `--append-system-prompt <path>` proves a
 * file-based alternative exists, but changes the task framing to
 * `<file name="...">...</file>`. Keeping the task as a normal prompt
 * preserves the same plain-message framing as the RPC backend; readiness is
 * handled explicitly by the readiness gate and the monitor deadline instead.
 *
 * `herdrIntegration` is resolved by the caller, not here, because the same
 * answer also selects the readiness gate: the hook-authority gate can only
 * open if this argv loads the hook.
 */
function buildChildArgs(
  spec: SubagentSpec,
  sessionDir: string,
  promptFilePath: string | null,
  herdrIntegration: string | null,
): string[] {
  const args: string[] = ["--session-dir", sessionDir, "--no-extensions"];
  const configuredExtensions = spec.childExtensionPaths ?? [];
  const herdrIntegrationKey = herdrIntegration ? canonicalEntryPath(herdrIntegration) : undefined;
  let integrationAlreadyConfigured = false;

  // Preserve the configured extension order. The Herdr integration is an
  // additive, backend-owned dependency because `--no-extensions` is required
  // to keep unrelated parent extensions out of isolated child sessions.
  for (const extPath of configuredExtensions) {
    args.push("-e", extPath);
    if (herdrIntegrationKey && canonicalEntryPath(extPath) === herdrIntegrationKey) {
      integrationAlreadyConfigured = true;
    }
  }
  if (herdrIntegration && !integrationAlreadyConfigured) {
    args.push("-e", herdrIntegration);
  }
  if (spec.resolvedModel) args.push("--model", spec.resolvedModel);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  args.push("--tools", spec.resolvedTools.join(","));
  args.push("--name", deriveSessionName(spec.agentName));
  if (promptFilePath) args.push("--append-system-prompt", promptFilePath);
  return args;
}

/**
 * Split the calling pane for one subagent.
 *
 * Geometry: each split halves the calling pane, so a batch of N tasks all
 * splitting right would shrink the parent to 1/N width. The spec hint asks
 * for "right" on the first task of a batch and "down" on the rest; a parent
 * narrower than MIN_RIGHT_SPLIT_WIDTH always splits down.
 */
async function splitPaneForSubagent(cli: HerdrClient, spec: SubagentSpec): Promise<{ paneId: string }> {
  let direction = spec.splitDirection ?? "right";
  const parentPaneId = process.env[HERDR_PANE_ID_VAR] ?? "";
  if (parentPaneId) {
    try {
      const panes = await cli.paneLayout(parentPaneId);
      const width = panes.find((pane) => pane.paneId === parentPaneId)?.width;
      if (width !== undefined && width < MIN_RIGHT_SPLIT_WIDTH) direction = "down";
    } catch {
      // Layout is advisory; the split attempt reports real failures.
    }
  }
  // The nesting-depth marker must reach the pane shell env (the child pi
  // inherits it from there); the parent's own env is not pane env.
  return cli.paneSplit({
    direction,
    cwd: spec.resolvedCwd,
    env: { [NESTING_DEPTH_ENV]: String(currentNestingDepth() + 1) },
  });
}

/**
 * Deliver the child's first task prompt after `agent wait --until idle` has
 * confirmed that the newly started Pi session has settled. The command is
 * intentionally fire-and-forget: Herdr's prompt-confirmation mode has its own
 * fixed five-second observation race, while the child monitor supplies the
 * explicit startup deadline below and the session JSONL remains authoritative.
 */
async function submitInitialPrompt(cli: HerdrClient, agentName: string, taskText: string): Promise<void> {
  await cli.agentPrompt(agentName, taskText);
}

// ─── Child monitor ──────────────────────────────────────────────────────────────

/**
 * One-shot startup watchdog kept separate from the long-lived child monitor.
 * It has one job: turn "no activity after the first prompt" into a callback,
 * while the monitor remains responsible for task lifecycle and result data.
 */
class StartupActivityDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observed = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  start(): void {
    if (this.observed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.observed) this.onTimeout();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  observe(): void {
    if (this.observed) return;
    this.observed = true;
    this.cancel();
  }

  cancel(): void {
    this.timer = clearPendingTimer(this.timer);
  }
}

/** Everything the monitor needs to observe and steer one child. */
interface MonitoredChild {
  cli: HerdrClient;
  timings: ResolvedTimings;
  spec: SubagentSpec;
  sessionDir: string;
  paneId: string;
  agentName: string;
  promptFilePath: string | null;
}

/**
 * Observation + lifecycle for one Herdr-hosted child, created after its task
 * prompt has been injected. Exposes the same contract as the RPC runner's
 * process handle: `result` (terminal semantics, resolves exactly once) and
 * `control` (steer/abort).
 *
 * Polls the session JSONL and pane liveness on one timer; the child's own
 * session entries — not Herdr's UI status — decide completion. All timers are
 * unref'd so the monitor can never keep the parent process alive.
 */
class HerdrChildMonitor {
  readonly result: Promise<ChildRunResult>;
  readonly control: SubagentProcessControl;

  private readonly cli: HerdrClient;
  private readonly timings: ResolvedTimings;
  private readonly spec: SubagentSpec;
  private readonly sessionDir: string;
  private readonly paneId: string;
  private readonly agentName: string;
  private readonly promptFilePath: string | null;
  private readonly watcher: SessionWatcher;

  // Mirrors runner.ts's ChildRunResult accumulation, sourced from the JSONL.
  private readonly usage = emptyUsage();
  private model: string | undefined;
  private finalOutput = "";
  private readonly toolCalls: Array<{ name: string; argsPreview: string }> = [];
  private lastStopReason: string | undefined;
  private lastError: string | undefined;

  /**
   * Task lifecycle is intentionally independent from Herdr pane status and
   * Pi's per-turn stopReason. In particular, an aborted turn is a live,
   * steerable task state, not a settled result.
   */
  private lifecycle: SubagentLifecycleState = "starting";
  private turnGeneration = 0;
  private settled = false;
  private abortedByParent = false;
  private resolveResult!: (value: ChildRunResult) => void;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Set by a "stop" turn ("completed") or an "error" turn ("failed") until
   * a later assistant message or a new parent prompt proves the run
   * continued. While set, an idle/done status settles the task with this
   * outcome. See the header comment for why the entry alone does not.
   */
  private pendingOutcome: "completed" | "failed" | undefined = undefined;
  /** Armed with pendingOutcome; cancelled by any continuation evidence. */
  private settleFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly startupActivityDeadline: StartupActivityDeadline;
  private lastAgentStatus: string | undefined = undefined;
  private tickInFlight = false;
  private pollFailures = 0;

  constructor(child: MonitoredChild) {
    this.cli = child.cli;
    this.timings = child.timings;
    this.spec = child.spec;
    this.sessionDir = child.sessionDir;
    this.paneId = child.paneId;
    this.agentName = child.agentName;
    this.promptFilePath = child.promptFilePath;
    this.watcher = new SessionWatcher({
      sessionDir: child.sessionDir,
      onAssistantMessage: (m) => this.observeAssistantMessage(m),
      onContinuationEntry: () => this.observeContinuationEntry(),
    });
    this.startupActivityDeadline = new StartupActivityDeadline(
      this.timings.startupActivityTimeoutMs,
      () => {
        if (!this.settled) this.settleStartupTimeout();
      },
    );
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    this.control = {
      // "steer" and "prompt" both become a typed prompt in the child's TUI;
      // pi queues input that arrives mid-turn, matching RPC steer semantics.
      // Mark the next turn before crossing the Herdr boundary so a delayed
      // pane observation from the interrupted turn cannot win a race with
      // newly supplied guidance.
      sendMessage: async (message: string) => {
        this.transitionLifecycle("running", true);
        try {
          await this.cli.agentPrompt(this.agentName, message);
        } catch (error) {
          // A failed steering command is a real protocol error, but give a
          // manually typed follow-up the same recovery window as a provider
          // error. Most importantly, arm a terminal fallback so the parent
          // request cannot wait forever on a rejected prompt command.
          if (!this.settled) {
            this.lastStopReason = "error";
            this.lastError = error instanceof Error ? error.message : String(error);
            this.transitionLifecycle("waiting");
            this.markPending("failed");
          }
          throw error;
        }
      },
      abort: () => this.abort(),
    };
  }

  /** Begin observing: wire the tool signal and start the poll loop. */
  start(): void {
    if (this.spec.signal?.aborted) {
      this.abort();
      return;
    }
    this.transitionLifecycle("running");
    this.startupActivityDeadline.start();
    this.spec.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.timings.pollIntervalMs);
    // Unref'd: a live watcher must never keep the parent process alive.
    this.pollTimer.unref?.();
  }

  private readonly onAbort = () => this.abort();

  /** Parent-requested abort: close the pane (killing the child) and settle. */
  private abort(): void {
    if (this.abortedByParent || this.settled) return;
    this.abortedByParent = true;
    void this.cli
      .paneClose(this.paneId)
      .then(() => this.settle(this.buildDeathResult()))
      .catch(() => {
        // The pane may already be gone or the server unreachable; the poll
        // loop observes the death either way and settles the same result.
      });
  }

  private settle(value: ChildRunResult): void {
    if (this.settled) return;
    this.transitionLifecycle(value.lifecycle);
    this.settled = true;
    this.stopPolling();
    this.cancelSettleFallback();
    this.startupActivityDeadline.cancel();
    try {
      this.spec.signal?.removeEventListener("abort", this.onAbort);
    } catch { /* listener bookkeeping is best effort */ }
    // Keep the session directory and its JSONL history in /tmp. Only the
    // generated system-prompt input is disposable once the child is settled.
    if (this.promptFilePath) {
      try { fs.unlinkSync(this.promptFilePath); } catch { /* ignore */ }
    }
    this.resolveResult(value);
  }

  private stopPolling(): void {
    this.pollTimer = clearPendingTimer(this.pollTimer);
  }

  private startOneShotTimer(delayMs: number, callback: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  }

  private cancelSettleFallback(): void {
    this.settleFallbackTimer = clearPendingTimer(this.settleFallbackTimer);
  }

  /**
   * A "stop" or "error" turn ended: wait for proof that the run settled.
   * The fallback is long (see the DEFAULT_* constants) because it only
   * matters when the idle/done status is lost.
   */
  private markPending(outcome: "completed" | "failed"): void {
    this.pendingOutcome = outcome;
    this.cancelSettleFallback();
    const delayMs = outcome === "completed"
      ? this.timings.completionFallbackMs
      : this.timings.errorSettleGraceMs;
    this.settleFallbackTimer = this.startOneShotTimer(delayMs, () => {
      this.settleFallbackTimer = undefined;
      if (this.pendingOutcome) this.settleByFallback();
    });
  }

  /** The run continued after the turn end; the next stop/error re-arms. */
  private clearPending(): void {
    this.pendingOutcome = undefined;
    this.cancelSettleFallback();
  }

  /**
   * A custom_message, user, or context_edit entry was written: the child is
   * about to make another model request (an extension continuation, a typed
   * prompt, or pi's automatic retry after a provider error). Only the
   * fallback timer is cancelled here, because the model may now think (or pi
   * may wait out a retry backoff) for minutes before the next assistant
   * entry appears. `pendingOutcome` stays set on purpose: if the entry did
   * NOT start a new request (an extension can add a display-only message),
   * the idle/done status still settles the task. If it did start one, Herdr
   * reports working until the run settles, and the next assistant message
   * clears the pending state.
   */
  private observeContinuationEntry(): void {
    if (this.settled) return;
    this.cancelSettleFallback();
  }

  /** Settle with the pending outcome. The child is known to be idle or gone. */
  private settlePending(): void {
    if (this.settled || !this.pendingOutcome) return;
    if (this.pendingOutcome === "failed") {
      this.settle(this.buildErrorGraceResult());
      return;
    }
    this.spec.onEvent?.({ type: "agent_end" });
    this.settle(this.buildSuccessResult());
  }

  /**
   * The fallback timer ran out: settle with the pending outcome, then close
   * the pane. The child's state is unknown here (its idle/done status never
   * arrived), so it may still be running. An unwatched child that keeps
   * editing files while the parent moves on (and maybe starts a replacement
   * child) is far worse than losing the pane view. Settle first so the
   * parent gets the real outcome, not the death result the poll loop would
   * build after the pane disappears.
   */
  private settleByFallback(): void {
    if (this.settled) return;
    this.settlePending();
    void this.cli.paneClose(this.paneId).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.spec.onStderr?.(`Herdr fallback pane cleanup failed: ${detail}\n`);
    });
  }

  /**
   * Herdr status is used only to detect startup activity. It is not a task
   * completion signal; the session JSONL still decides the final result.
   */
  private markStartupActivity(): void {
    if (this.settled) return;
    this.startupActivityDeadline.observe();
  }

  // ─── Terminal results ─────────────────────────────────────────────────────

  /**
   * Keep the shared result shape in one place. Terminal lifecycle is separate
   * from the assistant stopReason so `aborted` can remain a turn detail while
   * parent cancellation and pane death are reported as `closed`.
   */
  private buildResult(
    lifecycle: SubagentLifecycleState,
    exitCode: number,
    details: Pick<ChildRunResult, "stopReason" | "errorMessage"> = {},
  ): ChildRunResult {
    return {
      exitCode,
      lifecycle,
      usage: this.usage,
      finalOutput: this.finalOutput,
      ...details,
      model: this.model,
      toolCalls: this.toolCalls,
    };
  }

  private buildSuccessResult(): ChildRunResult {
    return this.buildResult("completed", 0, { stopReason: "stop" });
  }

  /**
   * Terminal result for a pane that is gone. Death is classified by the last
   * session state, never reported as success: a parent-requested close or a
   * user interrupt is closed, an errored task fails, and other death is closed.
   */
  private buildDeathResult(): ChildRunResult {
    if (this.abortedByParent) return this.buildResult("closed", 0, { stopReason: "aborted" });
    if (this.lastStopReason === "aborted") {
      return this.buildResult("closed", 0, {
        stopReason: "aborted",
        errorMessage: "Subagent was interrupted, then its pane was closed before a later turn completed",
      });
    }
    if (this.lastStopReason === "error") {
      return this.buildResult("failed", 1, {
        stopReason: "error",
        errorMessage: this.lastError ?? "Subagent errored, then its pane was closed",
      });
    }
    return this.buildResult("closed", 1, {
      stopReason: this.lastStopReason,
      errorMessage: "Subagent pane was closed before the subagent completed",
    });
  }

  private buildErrorGraceResult(): ChildRunResult {
    return this.buildResult("failed", 1, {
      stopReason: "error",
      errorMessage: this.lastError ? `Subagent turn failed: ${this.lastError}` : "Subagent turn failed",
    });
  }

  private buildStartupTimeoutResult(): ChildRunResult {
    return this.buildResult("failed", 1, {
      stopReason: "error",
      errorMessage:
        `Subagent startup timed out for Herdr agent "${this.agentName}" in pane "${this.paneId}": `
        + `did not observe working or blocked state after the initial prompt `
        + `within ${this.timings.startupActivityTimeoutMs}ms`,
    });
  }

  private settleStartupTimeout(): void {
    if (this.settled) return;
    this.settle(this.buildStartupTimeoutResult());
    // A failed startup has no user-owned completed session to leave open.
    // Closing is best effort because the Herdr server may have disappeared;
    // the specific timeout result has already been resolved for the parent.
    void this.cli.paneClose(this.paneId).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.spec.onStderr?.(`Herdr startup-timeout pane cleanup failed: ${detail}\n`);
    });
  }

  // ─── Session observation ──────────────────────────────────────────────────

  /**
   * Apply one logical task transition. The generation changes only when a
   * new running turn begins; a pane poll that started during the old turn must
   * not overwrite that newer state when its await resumes. Existing Pi-shaped
   * events announce only the transitions the parent UI needs (resume and
   * interruption); the terminal result carries the complete lifecycle.
   */
  private transitionLifecycle(next: SubagentLifecycleState, newTurn = false): void {
    if (this.settled) return;
    const changed = this.lifecycle !== next;
    const resumed = this.lifecycle === "interrupted" && next === "running";
    if (next === "running" && (changed || newTurn)) {
      this.turnGeneration++;
      this.lastStopReason = undefined;
      this.lastError = undefined;
      // New input from the parent (or a resumed turn) means the earlier
      // "stop" or "error" was not the end of the task.
      this.clearPending();
    }
    if (!changed && !newTurn) return;
    this.lifecycle = next;
    // Reuse Pi's existing lifecycle event shape for a resumed turn. The
    // initial running state is supplied by orchestration before spawn; this
    // event is only needed when manual input starts another turn.
    if (resumed || newTurn) this.spec.onEvent?.({ type: "agent_start" });
  }

  private observeAssistantMessage(message: any): void {
    this.markStartupActivity();
    // A direct prompt typed into the pane may first be visible as a complete
    // assistant message with `toolUse`, `stop`, or `error`. Any non-aborted
    // message after an interrupted turn is evidence that the same delegated
    // task has resumed, so publish running before classifying that boundary.
    if (this.lifecycle === "interrupted" && message.stopReason !== "aborted") {
      this.transitionLifecycle("running");
    } else if (!message.stopReason) {
      this.transitionLifecycle("running");
    }
    // Any assistant message after a "stop" or "error" turn proves the run
    // continued (a turn_end continuation or pi's automatic retry). If this
    // message itself ends the turn, observeTurnEnd re-arms the pending state.
    this.clearPending();
    this.accumulateMessage(message);
    // Synthetic event shaped like the RPC stream so index.ts's live summary
    // handling needs zero special cases for Herdr children.
    this.spec.onEvent?.({ type: "message_end", message });
    if (message.stopReason) this.observeTurnEnd(message);
  }

  /** Copy turns/usage/model out of one assistant message. */
  private accumulateMessageStats(message: any): void {
    this.usage.turns++;
    // Model capture must not depend on usage being present: a message can
    // carry the model name without usage data (synthesized/fallback messages,
    // providers that omit usage on non-final turns).
    if (!this.model && message.model) this.model = message.model;
    const msgUsage = message.usage;
    if (!msgUsage) return;
    this.usage.input += msgUsage.input || 0;
    this.usage.output += msgUsage.output || 0;
    this.usage.cacheRead += msgUsage.cacheRead || 0;
    this.usage.cacheWrite += msgUsage.cacheWrite || 0;
    this.usage.cost += msgUsage.cost?.total || 0;
    const contextTokens = contextTokensFromUsage(msgUsage);
    if (contextTokens > 0) this.usage.contextTokens = contextTokens;
  }

  /** Append one assistant message's text and tool calls to the transcript. */
  private accumulateMessageContent(message: any): void {
    if (!Array.isArray(message.content)) return;
    let messageText = "";
    for (const part of message.content) {
      if (part.type === "text") messageText += (messageText ? "\n" : "") + part.text;
      if (part.type === "toolCall") {
        const argsStr = JSON.stringify(part.arguments || {});
        this.toolCalls.push({
          name: part.name,
          argsPreview: argsStr.length > 80 ? argsStr.slice(0, 80) + "..." : argsStr,
        });
      }
    }
    // A final result belongs to the normal stop message only. Do not append
    // text from a partial/aborted turn: after ESC the next successful turn
    // must replace it, not inherit it.
    if (message.stopReason === "stop") this.finalOutput = messageText;
  }

  /** Copy usage/model/text/toolCalls out of one assistant message. */
  private accumulateMessage(message: any): void {
    this.accumulateMessageStats(message);
    this.accumulateMessageContent(message);
  }

  /**
   * Classify a turn boundary. A normal stop makes completion pending and an
   * error makes failure pending (the poll loop settles either once the child
   * is idle; the pane stays alive as a user-owned session); an interruption
   * keeps watching; anything else means the turn continues. Any earlier
   * pending state was already cleared by observeAssistantMessage.
   */
  private observeTurnEnd(message: any): void {
    this.lastStopReason = message.stopReason;
    if (message.errorMessage) {
      this.lastError = message.errorMessage;
    } else if (message.stopReason === "stop" || message.stopReason === "toolUse") {
      // A later normal completion is the new terminal state; do not let an
      // earlier transient error message fail a recovered run.
      this.lastError = undefined;
    }

    switch (message.stopReason) {
      case "stop":
        // Not settled yet: an extension may continue this run from
        // turn_end. finalOutput already holds this turn's text, so a later
        // "stop" simply replaces it.
        this.transitionLifecycle("waiting");
        this.markPending("completed");
        break;
      case "aborted":
        // Interrupted turn: NOT completion. The user can type into the pane
        // and a later normal turn still completes the task.
        this.transitionLifecycle("interrupted");
        this.spec.onEvent?.({ type: "subagent_turn_aborted" });
        this.spec.onEvent?.({ type: "agent_end" });
        break;
      case "error":
        // Not settled yet: pi may retry this error inside the same run.
        this.transitionLifecycle("waiting");
        this.spec.onEvent?.({ type: "agent_end" });
        this.markPending("failed");
        break;
      default:
        // toolUse and unknown reasons: the turn continues.
        this.transitionLifecycle("waiting");
    }
  }

  // ─── Pane death polling ───────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.settled || this.tickInFlight) return;
    this.tickInFlight = true;
    const generation = this.turnGeneration;
    try {
      // Read the session first, then check the pane: if the child completed
      // its final turn and exited, this order sees the "stop" entry before
      // the pane disappears, so the run completes instead of erroring.
      await this.watcher.poll();
      if (this.settled || generation !== this.turnGeneration) return;

      let paneResult: { state: "exists" | "gone"; agentStatus?: string };
      try {
        paneResult = await this.cli.paneGet(this.paneId);
        if (this.settled || generation !== this.turnGeneration) return;
        this.pollFailures = 0;
      } catch {
        // An unreachable server must not wedge the watcher forever: after
        // repeated failures treat the child as unmonitorable and settle.
        this.pollFailures++;
        // A seen "stop" still wins over death, as for a gone pane below.
        if (this.pollFailures >= MAX_PANE_POLL_FAILURES) {
          if (this.pendingOutcome === "completed") this.settlePending();
          else this.settle(this.buildDeathResult());
        }
        return;
      }
      if (paneResult.agentStatus !== undefined && paneResult.agentStatus !== this.lastAgentStatus) {
        this.lastAgentStatus = paneResult.agentStatus;
        // Surface herdr's agent status (idle/working/blocked) to observers
        // so the window-panel symbol is connected to subagent state.
        this.spec.onEvent?.({ type: "agent_status", agentStatus: paneResult.agentStatus });
      }
      if (paneResult.agentStatus === "working" || paneResult.agentStatus === "blocked") {
        this.markStartupActivity();
      }
      if (paneResult.state === "gone") {
        // The final "stop" was seen before the pane died (the session is
        // polled first), so the answer exists: deliver it, not a death.
        // A pending failure falls to buildDeathResult, which already
        // reports the last error as a failure.
        if (this.pendingOutcome === "completed") this.settlePending();
        else this.settle(this.buildDeathResult());
        return;
      }
      // Status was read AFTER the session poll that saw the stop/error
      // entry, and the lifecycle hook reports idle only on agent_settled
      // (never between a pi retry's error and its next attempt), so this
      // cannot be the idle state from before the turn started.
      if (this.pendingOutcome && SETTLED_AGENT_STATUSES.has(paneResult.agentStatus ?? "")) {
        this.settlePending();
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}

// ─── Backend ─────────────────────────────────────────────────────────────────

export function createHerdrBackend(options: HerdrBackendOptions): SubagentBackend {
  const timings: ResolvedTimings = {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    errorSettleGraceMs: options.errorSettleGraceMs ?? DEFAULT_ERROR_SETTLE_GRACE_MS,
    agentStartTimeoutMs: options.agentStartTimeoutMs ?? DEFAULT_AGENT_START_TIMEOUT_MS,
    startupActivityTimeoutMs: options.startupActivityTimeoutMs ?? DEFAULT_STARTUP_ACTIVITY_TIMEOUT_MS,
    completionFallbackMs: options.completionFallbackMs ?? DEFAULT_COMPLETION_FALLBACK_MS,
  };
  return {
    spawn: (spec) => spawnSubagentInHerdr(spec, options.cli, timings),
  };
}

/**
 * Upper bound for the hook-authority poll cadence. Short because every poll
 * step is added directly to the subagent's startup latency; one `agent get`
 * call is cheap. Tests with a faster `pollIntervalMs` poll at that rate.
 */
const MAX_READINESS_POLL_INTERVAL_MS = 250;

/**
 * Start one child and wait until its Pi can accept the first prompt.
 *
 * WHY `agent start` and `idle` are not enough: Herdr says a Pi agent is
 * ready and `idle` from a guess (`default_known_agent_idle_fallback`) as
 * soon as it sees the Pi process, about 4s after launch, even while Pi still
 * loads its extensions. On a cold start (cold disk cache, several children
 * loading about a dozen extensions at the same time) Pi is still loading
 * then. The typed prompt shows in the editor, but its Enter never submits
 * it, and the startup deadline later fails the child. Reproduced on demand
 * with an extension that blocks Pi's load for 6-8s; see
 * docs/design-herdr-backend.md, "Initial prompt readiness".
 *
 * With Pi's lifecycle hook loaded, the gate therefore waits for the hook to
 * own the state (`lifecycleHookAuthority`) AND report `idle`. The hook's
 * first report comes from Pi's `session_start`, which Pi emits only after
 * its real submit handler is installed. Without the hook there is no
 * reliable signal, so the old `idle` wait stays as a best-effort fallback.
 *
 * The configured timeout is one combined readiness budget. Herdr's command
 * runner adds transport slack to each call, but the readiness gate receives
 * only the time left after `agent start` returns.
 */
async function startHerdrAgent(
  cli: HerdrClient,
  spec: SubagentSpec,
  paneId: string,
  agentArgs: string[],
  timings: ResolvedTimings,
  loadsLifecycleHook: boolean,
): Promise<string> {
  const agentName = deriveHerdrAgentName(spec.agentName);
  const readinessDeadline = Date.now() + timings.agentStartTimeoutMs;
  await cli.agentStart(agentName, paneId, agentArgs, timings.agentStartTimeoutMs);
  if (spec.signal?.aborted) throw new Error("Subagent aborted during startup");

  const remainingReadinessMs = readinessDeadline - Date.now();
  if (remainingReadinessMs <= 0) {
    throw new Error("Subagent readiness timed out before the readiness gate: agent start exhausted the combined readiness budget");
  }
  if (loadsLifecycleHook) {
    await waitForLifecycleHookIdle(cli, spec, agentName, paneId, readinessDeadline, timings);
  } else {
    await cli.agentWait(agentName, "idle", remainingReadinessMs);
  }
  if (spec.signal?.aborted) throw new Error("Subagent aborted during startup");
  return agentName;
}

/**
 * Poll Herdr until Pi's lifecycle hook owns the agent state and reports idle.
 *
 * A poll loop, not `herdr agent wait`: the wait command matches the status
 * only, and the fallback guess already says `idle`. Errors from `agent get`
 * are not retried. They mean the agent or the Herdr server is gone, and the
 * caller closes the pane and rejects the spawn.
 */
async function waitForLifecycleHookIdle(
  cli: HerdrClient,
  spec: SubagentSpec,
  agentName: string,
  paneId: string,
  readinessDeadline: number,
  timings: ResolvedTimings,
): Promise<void> {
  const pollIntervalMs = Math.min(timings.pollIntervalMs, MAX_READINESS_POLL_INTERVAL_MS);
  while (true) {
    const snapshot = await cli.agentGet(agentName);
    if (snapshot.lifecycleHookAuthority && snapshot.agentStatus === "idle") return;
    if (spec.signal?.aborted) throw new Error("Subagent aborted during startup");
    if (Date.now() + pollIntervalMs > readinessDeadline) {
      // Name both facts: an operator who sees this must know whether Pi
      // never loaded the hook (authority false) or loaded it but never
      // settled (authority true, status not idle).
      throw new Error(
        `Subagent readiness timed out for Herdr agent "${agentName}" in pane "${paneId}": ` +
          `Pi's lifecycle hook did not report idle within ${timings.agentStartTimeoutMs}ms ` +
          `(last seen: hook authority ${snapshot.lifecycleHookAuthority}, status ${snapshot.agentStatus ?? "unknown"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Spawn one subagent as an interactive pi session in a new Herdr pane.
 *
 * Startup is a strict sequence — split pane, start agent, wait until Pi can
 * take input (see startHerdrAgent), inject task — where any command failure
 * closes the leftover pane and rejects. Once the prompt is accepted, the child monitor owns the explicit
 * startup-activity deadline and all later task observation.
 */
async function spawnSubagentInHerdr(
  spec: SubagentSpec,
  cli: HerdrClient,
  timings: ResolvedTimings,
): Promise<SubagentHandle> {
  // Same recursion guard as the default backend: refuse before any pane or
  // session directory exists so a refused spawn has zero side effects.
  const refusal = nestingDepthRefusal(spec.agentName);
  if (refusal) return { result: Promise.resolve(refusal) };

  const sessionDir = await createSubagentSessionDir(spec.parentSessionDir);
  let promptFilePath: string | null = null;
  if (spec.agentPrompt.trim()) {
    // Same mechanism as the RPC runner: the agent definition rides in via
    // --append-system-prompt so the child is configured identically.
    const tmp = await writePromptToTempFile(spec.agentName, spec.agentPrompt, sessionDir);
    promptFilePath = tmp.filePath;
  }
  // `--kind pi` tells Herdr to resolve and launch its own configured pi
  // binary; the argv after `--` must be pure pi CLI flags. Unlike the default
  // backend, there is no local child_process.spawn() here, so this must NOT
  // go through getPiInvocation() — that helper's job is picking the concrete
  // command+args pair for a direct spawn() call, and on some installs (e.g. an
  // fnm shim where process.argv[1] is the pi script itself) it prepends that
  // script's own path as the first positional argument. Pi treats the first
  // positional argument as the interactive initial prompt, so passing that
  // through here would hand the child its own executable path as its task.
  // Resolve relative PI_CODING_AGENT_DIR values as the child Pi process will:
  // the pane's cwd can differ from the parent's cwd.
  const herdrIntegration = resolveHerdrAgentStateExtension(process.env, spec.resolvedCwd);
  const agentArgs = buildChildArgs(spec, sessionDir, promptFilePath, herdrIntegration);

  let paneId = "";
  try {
    const pane = await splitPaneForSubagent(cli, spec);
    paneId = pane.paneId;
    if (spec.signal?.aborted) throw new Error("Subagent aborted during startup");

    const agentName = await startHerdrAgent(cli, spec, paneId, agentArgs, timings, herdrIntegration !== null);

    // Deliver the task as the child's first prompt. The monitor below reports
    // a specific startup timeout if Herdr never observes the child begin it.
    await submitInitialPrompt(cli, agentName, spec.taskText);

    const monitor = new HerdrChildMonitor({
      cli,
      timings,
      spec,
      sessionDir,
      paneId,
      agentName,
      promptFilePath,
    });
    monitor.start();
    return { result: monitor.result, control: monitor.control };
  } catch (error) {
    // Startup failure: close the pane (may not exist yet) and drop the prompt
    // file, then surface the real error. This must never become a completion.
    if (paneId) {
      try { await cli.paneClose(paneId); } catch { /* best effort */ }
    }
    if (promptFilePath) {
      try { fs.unlinkSync(promptFilePath); } catch { /* ignore */ }
    }
    throw error;
  }
}