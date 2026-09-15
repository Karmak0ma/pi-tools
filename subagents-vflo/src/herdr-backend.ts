/**
 * Herdr execution backend.
 *
 * Spawns each subagent as a real interactive pi session inside a new Herdr
 * pane in the parent's workspace, and observes it through the session JSONL
 * it writes. There is no RPC channel: the pane is the user's window into the
 * child, and the JSONL is the parent's source of truth.
 *
 * Lifecycle semantics (the contract shared with the default backend):
 * - The task completes only when an assistant turn settles normally
 *   (stopReason "stop" in the session JSONL). Herdr's own idle/done pane
 *   status is never treated as completion — it is a UI-seen state, not task
 *   semantics.
 * - An interrupted turn (stopReason "aborted", e.g. the user pressed Escape
 *   inside the pane) does NOT complete the task. The pane and session stay
 *   alive so the user can give the subagent corrective input directly; a
 *   later normal turn completion still delivers the result automatically.
 * - Pane death is a task-level terminal event, separate from an aborted turn:
 *   an interrupted task becomes `closed` (with cancellation text), an
 *   errored task becomes `failed`, and an otherwise active task becomes
 *   `closed`. A dead pane is never a successful completion.
 * - Parent abort (control.abort) closes the pane and resolves as `closed`.
 * - An errored turn (stopReason "error") that sits idle for a grace period
 *   fails the task, mirroring the RPC runner, while still tolerating pi's
 *   automatic in-turn retries (each new session message resets the grace).
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
import { HERDR_PANE_ID_VAR, isHerdrPromptStalled, resolveHerdrAgentStateExtension, type HerdrClient } from "./herdr.js";
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
 * How long to wait for Herdr to confirm a prompt submission left `idle`.
 * Herdr's own internal submission-stall check is a fixed 5 seconds (see
 * docs); this must be strictly larger so a genuine stall surfaces as
 * `agent_prompt_stalled` rather than our own generic CLI timeout racing it.
 */
const PROMPT_CONFIRM_TIMEOUT_MS = 8_000;

export interface HerdrBackendOptions {
  cli: HerdrClient;
  /** Pane/session polling cadence. */
  pollIntervalMs?: number;
  /** Idle time after an errored child turn before the task fails. */
  errorSettleGraceMs?: number;
  /** Wait for the pi TUI to become interactive-ready inside the new pane. */
  agentStartTimeoutMs?: number;
}

interface ResolvedTimings {
  pollIntervalMs: number;
  errorSettleGraceMs: number;
  agentStartTimeoutMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_ERROR_SETTLE_GRACE_MS = 30_000;
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
 * The task itself deliberately does NOT ride in here as a trailing
 * positional. Pi's `[messages...]` positional would avoid the startup race
 * described on `submitInitialPrompt()` below, but Herdr rejects any argv
 * value containing a newline (`invalid_agent_argument`) before the child
 * ever starts — verified live — which would turn a routine multi-line task
 * into a hard spawn failure. `--append-system-prompt <path>` (below) proves
 * a file-based alternative exists, but reading the task from a file instead
 * of a message changes what the model sees (`<file name="...">...</file>`
 * framing, not a plain instruction). Keeping the task as an actual prompt
 * via `submitInitialPrompt()` preserves that framing and every task shape,
 * at the cost of guarding its one real race explicitly.
 */
function buildChildArgs(spec: SubagentSpec, sessionDir: string, promptFilePath: string | null): string[] {
  const args: string[] = ["--session-dir", sessionDir, "--no-extensions"];
  const configuredExtensions = spec.childExtensionPaths ?? [];
  // Resolve relative PI_CODING_AGENT_DIR values as the child Pi process will:
  // the pane's cwd can differ from the parent's cwd.
  const herdrIntegration = resolveHerdrAgentStateExtension(process.env, spec.resolvedCwd);
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
 * Deliver the child's first task prompt, guarded against a startup race in
 * pi's TUI.
 *
 * Right after `agent start` reports the pane ready, pi is still finishing
 * its own terminal handshake (a one-time kitty-keyboard-protocol query it
 * sends at startup). A prompt typed into that window can visibly land in
 * the input box while the trailing Enter keystroke is swallowed by that
 * handshake — the pane looks ready, the text sits there, but no turn
 * starts. This only threatens the very first prompt: by the time any later
 * steering message is sent (HerdrChildMonitor.control.sendMessage below),
 * the child has already finished that one-time handshake, so those calls
 * stay fire-and-forget.
 *
 * Herdr documents this exact failure mode: a confirmed `agent prompt`
 * reports `agent_prompt_stalled` when it does not observe the pane leave
 * idle within its own 5-second window. Recovery is a single corrective
 * keystroke: send Enter, since the pane was idle when the stall fired.
 */
async function submitInitialPrompt(cli: HerdrClient, agentName: string, taskText: string): Promise<void> {
  try {
    await cli.agentPrompt(agentName, taskText, { confirmWithinMs: PROMPT_CONFIRM_TIMEOUT_MS });
  } catch (error) {
    if (!isHerdrPromptStalled(error)) throw error;
    await cli.agentSendKeys(agentName, ["enter"]);
  }
}

// ─── Child monitor ──────────────────────────────────────────────────────────────

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
  private errorGraceTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.watcher = new SessionWatcher({ sessionDir: child.sessionDir, onAssistantMessage: (m) => this.observeAssistantMessage(m) });
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
            this.startErrorGrace();
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
    this.cancelErrorGrace();
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

  private startErrorGrace(): void {
    this.cancelErrorGrace();
    this.errorGraceTimer = setTimeout(() => {
      this.errorGraceTimer = undefined;
      this.settle(this.buildErrorGraceResult());
    }, this.timings.errorSettleGraceMs);
    this.errorGraceTimer.unref?.();
  }

  private cancelErrorGrace(): void {
    this.errorGraceTimer = clearPendingTimer(this.errorGraceTimer);
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
      this.cancelErrorGrace();
    }
    if (!changed && !newTurn) return;
    this.lifecycle = next;
    // Reuse Pi's existing lifecycle event shape for a resumed turn. The
    // initial running state is supplied by orchestration before spawn; this
    // event is only needed when manual input starts another turn.
    if (resumed || newTurn) this.spec.onEvent?.({ type: "agent_start" });
  }

  private observeAssistantMessage(message: any): void {
    // A direct prompt typed into the pane may first be visible as a complete
    // assistant message with `toolUse`, `stop`, or `error`. Any non-aborted
    // message after an interrupted turn is evidence that the same delegated
    // task has resumed, so publish running before classifying that boundary.
    if (this.lifecycle === "interrupted" && message.stopReason !== "aborted") {
      this.transitionLifecycle("running");
    } else if (!message.stopReason) {
      this.transitionLifecycle("running");
    }
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
   * Classify a turn boundary. A normal settle completes the task (the pane
   * stays alive as a user-owned session); an interruption keeps watching; an
   * error turn arms the idle grace; anything else means the turn continues.
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
        this.spec.onEvent?.({ type: "agent_end" });
        this.settle(this.buildSuccessResult());
        break;
      case "aborted":
        // Interrupted turn: NOT completion. The user can type into the pane
        // and a later normal turn still completes the task.
        this.transitionLifecycle("interrupted");
        this.spec.onEvent?.({ type: "subagent_turn_aborted" });
        this.spec.onEvent?.({ type: "agent_end" });
        this.cancelErrorGrace();
        break;
      case "error":
        this.transitionLifecycle("waiting");
        this.spec.onEvent?.({ type: "agent_end" });
        this.startErrorGrace();
        break;
      case "toolUse":
        this.transitionLifecycle("waiting");
        this.cancelErrorGrace();
        break;
      default:
        this.transitionLifecycle("waiting");
        this.cancelErrorGrace();
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
        if (this.pollFailures >= MAX_PANE_POLL_FAILURES) this.settle(this.buildDeathResult());
        return;
      }
      if (paneResult.agentStatus !== undefined && paneResult.agentStatus !== this.lastAgentStatus) {
        this.lastAgentStatus = paneResult.agentStatus;
        // Surface herdr's agent status (idle/working/blocked) to observers
        // so the window-panel symbol is connected to subagent state.
        this.spec.onEvent?.({ type: "agent_status", agentStatus: paneResult.agentStatus });
      }
      if (paneResult.state === "gone") this.settle(this.buildDeathResult());
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
  };
  return {
    spawn: (spec) => spawnSubagentInHerdr(spec, options.cli, timings),
  };
}

/**
 * Spawn one subagent as an interactive pi session in a new Herdr pane.
 *
 * Startup is a strict sequence — split pane, start agent, inject task — where
 * any failure closes the leftover pane and rejects; nothing partial is ever
 * reported as a completion. Only after the prompt is accepted does the child
 * monitor take over observation.
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

  const sessionDir = await createSubagentSessionDir();
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
  const agentArgs = buildChildArgs(spec, sessionDir, promptFilePath);

  let paneId = "";
  try {
    const pane = await splitPaneForSubagent(cli, spec);
    paneId = pane.paneId;
    if (spec.signal?.aborted) throw new Error("Subagent aborted during startup");

    const agentName = deriveHerdrAgentName(spec.agentName);
    await cli.agentStart(agentName, paneId, agentArgs, timings.agentStartTimeoutMs);
    if (spec.signal?.aborted) throw new Error("Subagent aborted during startup");

    // Deliver the task as the child's first prompt now that its TUI is ready.
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