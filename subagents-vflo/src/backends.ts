/**
 * Execution backends for spawned subagents.
 *
 * A backend owns HOW a subagent runs; the orchestration in index.ts only
 * consumes the contract below. Two implementations exist:
 *
 * - DefaultBackend: the original RPC runner (src/runner.ts). Spawns a headless
 *   pi child, resolves after its first settled turn, then shuts it down.
 * - HerdrBackend (src/herdr-backend.ts): when the parent runs inside a Herdr
 *   workspace, launches the child as a real interactive pi session in a new
 *   pane and observes it through its session JSONL.
 *
 * Both backends deliver the same ChildRunResult semantics: the promise
 * resolves exactly once, only at a terminal delegated-task state, and carries
 * an explicit lifecycle. A Herdr turn interrupted by Escape does not resolve
 * this promise; a crashed, closed, or unrecovered child never becomes a
 * successful completion.
 */

import type { ChildProcess } from "node:child_process";
import { runChild, type ChildRunResult, type RunChildOptions } from "./runner.js";
import { HerdrCli, selectBackendKind, type HerdrClient } from "./herdr.js";
import { createHerdrBackend } from "./herdr-backend.js";
import type { SubagentProcessControl } from "./tracker.js";
import type { ThinkingLevel } from "./types.js";

// ─── Contract ────────────────────────────────────────────────────────────────

/**
 * Everything a backend needs to spawn one subagent. The resolved fields are
 * produced by the shared resolution pipeline (resolver.ts) so both backends
 * launch children with identical configuration.
 */
export interface SubagentSpec {
  resolvedModel?: string;
  resolvedTools: string[];
  resolvedCwd: string;
  agentName: string;
  agentPrompt: string;
  taskText: string;
  thinking?: ThinkingLevel;
  childExtensionPaths?: string[];
  /** Parent Pi session directory where this child stores its isolated history. */
  parentSessionDir?: string;
  /** Tool-call abort signal for the parent's subagent tool invocation. */
  signal?: AbortSignal;
  /** Observation callbacks. The Herdr backend emits synthetic session events. */
  onEvent?: (event: any) => void;
  onStderr?: (data: string) => void;
  onExtensionUIRequest?: RunChildOptions["onExtensionUIRequest"];
  /** Pane geometry hint for the Herdr backend. Purely cosmetic — ignored outside Herdr. */
  splitDirection?: "right" | "down";
  /** Test seam mirrored from RunChildOptions so the default backend is testable without a real pi binary. */
  spawnProcess?: RunChildOptions["spawnProcess"];
}

export interface SubagentHandle {
  /** Resolves exactly once with terminal child semantics. */
  result: Promise<ChildRunResult>;
  /**
   * Steering control. Undefined only for refused spawns (nesting depth guard).
   */
  control?: SubagentProcessControl;
  /**
   * The child process handle, RPC backend only. Herdr children are owned by
   * the Herdr server; there is deliberately no process handle for them.
   */
  process?: ChildProcess;
}

export interface SubagentBackend {
  spawn(spec: SubagentSpec): Promise<SubagentHandle>;
}

// ─── Default backend ─────────────────────────────────────────────────────────

/**
 * Wrap the existing runChild flow in the backend contract without changing
 * its behavior. The child's SubagentProcessControl becomes available inside
 * runChild before the first RPC prompt is sent, so the handle exposes it as
 * soon as spawn resolves and steering works from the first moment.
 */
export function createDefaultBackend(): SubagentBackend {
  return {
    async spawn(spec: SubagentSpec): Promise<SubagentHandle> {
      let process: ChildProcess | undefined;
      let control: SubagentProcessControl | undefined;
      let resolveWhenProcessReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveWhenProcessReady = resolve;
      });

      const options: RunChildOptions = {
        ...spec,
        onProcessReady(proc, childControl) {
          process = proc;
          control = childControl;
          resolveWhenProcessReady();
        },
      };
      const result = runChild(options);
      // Refused spawns (nesting guard) never fire onProcessReady; the race
      // lets the handle resolve immediately with the refusal result instead
      // of waiting forever.
      await Promise.race([ready, result.then(() => undefined, () => undefined)]);
      return { result, control, process };
    },
  };
}

// ─── Backend selection ───────────────────────────────────────────────────────

/**
 * Pick the execution backend once per extension runtime. Detection lives in
 * selectBackendKind (src/herdr.ts); this function only wires the choice.
 * The optional Herdr CLI override exists so tests can drive the Herdr path
 * end-to-end without touching the real binary.
 */
export function createBackend(overrides: { herdrCli?: HerdrClient } = {}): SubagentBackend {
  return selectBackendKind() === "herdr"
    ? createHerdrBackend({ cli: overrides.herdrCli ?? new HerdrCli() })
    : createDefaultBackend();
}