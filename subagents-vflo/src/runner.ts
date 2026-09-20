/**
 * Subprocess runner for child pi processes.
 *
 * Child agents run in RPC mode rather than print/JSON mode. This keeps the
 * child connected during its active turn so the inspector can steer it; the
 * RPC process is closed as soon as the turn settles.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ChildMessageDelivery, SubagentProcessControl } from "./tracker.js";
import {
  cancelledResponse,
  localDeadline,
  parseExtensionUIRequest,
  sanitizeTerminalText,
  type ChildExtensionUIDialogRequest,
  type ChildExtensionUIResponse,
} from "./rpc-extension-ui.js";
import {
  contextTokensFromUsage,
  emptyUsage,
  MAX_NESTING_DEPTH,
  type SubagentLifecycleState,
  type TaskUsage,
  type ThinkingLevel,
} from "./types.js";

/**
 * Env marker recording how many subagent generations a process sits below
 * the top-level session. Absent in a normal parent (depth 0); runChild writes
 * depth+1 into every spawned child so the nesting guard in runChild can
 * refuse spawns beyond MAX_NESTING_DEPTH without any in-band coordination.
 */
export const NESTING_DEPTH_ENV = "PI_SUBAGENTS_VFLO_DEPTH";

/**
 * Read the current nesting generation from the given environment.
 * Absent, non-numeric, or negative values count as depth 0 (top-level
 * session) so a corrupted marker degrades to "allow spawning", never to
 * "block everything".
 */
export function currentNestingDepth(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env[NESTING_DEPTH_ENV] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Recursion guard: the failed ChildRunResult when spawning is not allowed at
 * this process's nesting generation, or null when spawning is fine. Kept as a
 * pure helper so the refusal policy is unit-testable without faking a child.
 */
export function nestingDepthRefusal(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildRunResult | null {
  const nestingDepth = currentNestingDepth(env);
  if (nestingDepth < MAX_NESTING_DEPTH) return null;
  return {
    exitCode: 1,
    usage: emptyUsage(),
    finalOutput: "",
    toolCalls: [],
    lifecycle: "failed",
    errorMessage: `Subagent nesting depth limit reached: refusing to spawn "${agentName}" at nesting level ${nestingDepth + 1} (max ${MAX_NESTING_DEPTH})`,
  };
}

// ─── Pi Invocation ───────────────────────────────────────────────────────────

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ─── Session Management ──────────────────────────────────────────────────────

/**
 * Create a private session directory for one child.
 *
 * When the parent has a persistent session, its session manager directory is
 * used as the storage root. Each child still gets a unique subdirectory so
 * the JSONL watcher cannot mistake the parent or a sibling child session for
 * this child. In-memory parents have no usable session directory, so they
 * retain the old temporary-storage behavior.
 */
export async function createSubagentSessionDir(parentSessionDir?: string): Promise<string> {
  if (parentSessionDir) {
    try {
      await fs.promises.mkdir(parentSessionDir, { recursive: true });
      return await fs.promises.mkdtemp(path.join(parentSessionDir, "pi-subagent-"));
    } catch {
      // A custom parent session directory may be unavailable. Do not prevent
      // the delegated task from running when Pi itself can still persist a
      // child session in the process temporary directory.
    }
  }

  return fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
}

export async function writePromptToTempFile(
  agentName: string,
  prompt: string,
  existingDir?: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = existingDir || await createSubagentSessionDir();
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

// ─── RPC Session ─────────────────────────────────────────────────────────────

export interface ChildRunResult {
  exitCode: number;
  /** Final delegated-task state; a turn-level `aborted` is not terminal. */
  lifecycle: SubagentLifecycleState;
  usage: TaskUsage;
  finalOutput: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
}

/**
 * Convert process-close observations into the terminal delegated-task state.
 * A normal stop is authoritative even when the transport closes noisily;
 * without that stop, an aborted/cancelled child is closed and other abnormal
 * exits are failed.
 */
function finalizeChildResult(
  result: ChildRunResult,
  wasAborted: boolean,
  collectedStderr: string,
): void {
  if (wasAborted) result.stopReason = "aborted";
  const validCompletion = !wasAborted && result.stopReason === "stop";
  if (!wasAborted && result.stopReason === "aborted" && !result.errorMessage) {
    result.errorMessage = "Subagent turn was interrupted before the child process closed";
  }
  if (!validCompletion && result.exitCode !== 0 && !result.errorMessage) {
    const stderrSnippet = collectedStderr.trim().slice(0, 300);
    result.errorMessage = stderrSnippet
      ? `Child exited with code ${result.exitCode}: ${stderrSnippet}`
      : `Child exited with code ${result.exitCode}`;
  }
  result.lifecycle = validCompletion
    ? "completed"
    : wasAborted || result.stopReason === "aborted"
      ? "closed"
      : result.stopReason === "error" || result.exitCode !== 0 || !!result.errorMessage
        ? "failed"
        : "closed";
}

export interface RunChildOptions {
  resolvedModel?: string;
  resolvedTools: string[];
  resolvedCwd: string;
  agentName: string;
  agentPrompt: string;
  taskText: string;
  thinking?: ThinkingLevel;
  childExtensionPaths?: string[];
  /** Parent Pi session directory where this child's isolated directory is created. */
  parentSessionDir?: string;
  /** Test seam for deterministic JSONL transport tests; production uses spawn. */
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
  onExtensionUIRequest?: (
    request: ChildExtensionUIDialogRequest,
    channel: ChildExtensionUIChannel,
  ) => void;
  onStderr?: (data: string) => void;
  onProcessReady?: (proc: ChildProcess, control: SubagentProcessControl) => void;
  onProcessExit?: (code: number | null) => void;
}

/**
 * A response channel is created per child, never shared between instances.
 * The optional deadline accessor lets the session broker use the exact same
 * conservative deadline that guards the wire write in the runner.
 */
export interface ChildExtensionUIChannel {
  respond(response: ChildExtensionUIResponse): boolean;
  forget(requestId: string): void;
  isOpen(): boolean;
  getDeadline?(requestId: string): number | undefined;
}

type PendingResponse = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function commandName(delivery: ChildMessageDelivery): "prompt" | "steer" {
  return delivery;
}

/**
 * Build the child process environment: the parent's environment flows through
 * so child tools keep working, with only session plumbing scrubbed and the
 * nesting generation stamped.
 *
 * The parent pi process may expose its own session path through
 * PI_SESSION_FILE. If inherited, that environment variable can redirect a
 * child away from the explicit --session-dir the spawn passes, so remove it
 * before spawning. Other environment values remain available to child tools.
 *
 * The generation marker (see MAX_NESTING_DEPTH) bounds recursive self-dispatch:
 * top-level parents have no marker and count as 0, so the first child is 1.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  delete childEnv.PI_SESSION_FILE;
  childEnv[NESTING_DEPTH_ENV] = String(currentNestingDepth() + 1);
  return childEnv;
}

/**
 * Spawn a child pi process and wait for its first agent run to settle.
 *
 * The returned promise resolves after `agent_settled` and the RPC child has
 * been shut down. The child is steerable only while its initial run is active.
 */
export async function runChild(options: RunChildOptions): Promise<ChildRunResult> {
  const {
    resolvedModel,
    resolvedTools,
    resolvedCwd,
    agentName,
    agentPrompt,
    taskText,
    thinking,
    childExtensionPaths,
    parentSessionDir,
    spawnProcess,
    signal,
    onEvent,
    onExtensionUIRequest,
    onStderr,
    onProcessReady,
    onProcessExit,
  } = options;

  // Recursion guard (see MAX_NESTING_DEPTH): refuse to spawn when this
  // process is already at the depth limit. Returned as a normal failed
  // ChildRunResult so the caller reports it like any other child failure;
  // placed before any session dir or process creation, so a refused spawn
  // has zero side effects.
  const refusal = nestingDepthRefusal(agentName);
  if (refusal) return refusal;

  // Keep each child history in its own directory. Prefer a unique directory
  // below the parent's Pi session directory so the history survives outside
  // /tmp; the helper falls back to /tmp for an in-memory/unavailable parent.
  // Do not use --no-session: the resulting JSONL file is useful for post-run
  // inspection, while the unique directory keeps it separate from the
  // parent's history.
  const sessionDir = await createSubagentSessionDir(parentSessionDir);
  const args: string[] = ["--mode", "rpc", "--session-dir", sessionDir, "--no-extensions"];
  if (childExtensionPaths && childExtensionPaths.length > 0) {
    for (const extPath of childExtensionPaths) {
      args.push("-e", extPath);
    }
  }
  if (resolvedModel) args.push("--model", resolvedModel);
  if (thinking) args.push("--thinking", thinking);
  args.push("--tools", resolvedTools.join(","));

  let collectedStderr = "";

  const result: ChildRunResult = {
    exitCode: 0,
    lifecycle: "running",
    usage: emptyUsage(),
    finalOutput: "",
    toolCalls: [],
  };

  let tmpPromptPath: string | null = null;
  if (agentPrompt.trim()) {
    const tmp = await writePromptToTempFile(agentName, agentPrompt, sessionDir);
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
  }

  const invocation = getPiInvocation(args);
  const childEnv = buildChildEnv();
  const proc = (spawnProcess || spawn)(invocation.command, invocation.args, {
    cwd: resolvedCwd,
    shell: false,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let processExited = false;
  let wasAborted = false;
  let initialSettled = false;
  let resolveInitial!: (value: ChildRunResult) => void;
  let resolveClosed!: () => void;
  const processClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const initialResult = new Promise<ChildRunResult>((resolve) => {
    resolveInitial = resolve;
  });
  const pendingResponses = new Map<string, PendingResponse>();
  type ObservedUIRequest = {
    method?: ChildExtensionUIDialogRequest["method"];
    options?: string[];
    deadline?: number;
  };
  const pendingUIRequests = new Map<string, ObservedUIRequest>();
  let uiChannelClosed = false;

  const observeUIRequest = (
    request: ChildExtensionUIDialogRequest,
    receivedAt: number,
  ): boolean => {
    if (pendingUIRequests.has(request.id)) return false;
    pendingUIRequests.set(request.id, {
      method: request.method,
      options: request.method === "select" ? [...request.options] : undefined,
      deadline: localDeadline(receivedAt, request.timeout),
    });
    return true;
  };

  const observeMalformedUIRequest = (requestId: string, method: string, receivedAt: number, timeout?: number): boolean => {
    if (pendingUIRequests.has(requestId)) return false;
    pendingUIRequests.set(requestId, {
      method: method as ChildExtensionUIDialogRequest["method"],
      deadline: localDeadline(receivedAt, timeout),
    });
    return true;
  };

  const extensionUIChannel: ChildExtensionUIChannel = {
    respond(response) {
      if (response.type !== "extension_ui_response") return false;
      if (uiChannelClosed || processExited || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
        return false;
      }

      const observed = pendingUIRequests.get(response.id);
      if (!observed) return false;
      if (observed.deadline !== undefined && Date.now() >= observed.deadline) {
        pendingUIRequests.delete(response.id);
        return false;
      }

      // Validate the response against the request before taking the exactly
      // once gate. A select value from a different request must never cross a
      // child boundary, even if a caller accidentally reuses an id.
      if (observed.method === "select") {
        if (!("cancelled" in response) && (!("value" in response) || !observed.options?.includes(response.value))) {
          return false;
        }
      } else if (observed.method === "confirm") {
        if (!("cancelled" in response) && !("confirmed" in response)) return false;
      } else if (observed.method === "input" || observed.method === "editor") {
        if (!("cancelled" in response) && (!("value" in response) || typeof response.value !== "string")) {
          return false;
        }
      }

      // Mark answered before writing. This synchronous check-and-set is the
      // authoritative wire-level exactly-once gate for presenter/abort races.
      pendingUIRequests.delete(response.id);
      try {
        proc.stdin.write(`${JSON.stringify(response)}\n`);
        return true;
      } catch {
        return false;
      }
    },
    forget(requestId) {
      pendingUIRequests.delete(requestId);
    },
    isOpen() {
      return !uiChannelClosed && !processExited && !!proc.stdin && !proc.stdin.destroyed && !!proc.stdin.writable;
    },
    getDeadline(requestId) {
      return pendingUIRequests.get(requestId)?.deadline;
    },
  };

  const closeExtensionUIChannel = () => {
    uiChannelClosed = true;
    pendingUIRequests.clear();
  };

  const settleInitial = () => {
    if (initialSettled) return;
    initialSettled = true;
    if (signal) signal.removeEventListener("abort", abortProcess);
    resolveInitial(result);
  };

  const rejectPending = (error: Error) => {
    for (const pending of pendingResponses.values()) pending.reject(error);
    pendingResponses.clear();
  };

  const sendCommand = (message: string, delivery: ChildMessageDelivery): Promise<void> => {
    if (processExited || !proc.stdin || proc.stdin.destroyed) {
      return Promise.reject(new Error("Subagent process is no longer running"));
    }

    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const command = {
      id,
      type: commandName(delivery),
      message,
    };

    return new Promise<void>((resolve, reject) => {
      pendingResponses.set(id, { resolve, reject });
      try {
        proc.stdin!.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        pendingResponses.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const abortProcess = () => {
    if (processExited) return;
    wasAborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!processExited) proc.kill("SIGKILL");
    }, 5000);
  };

  const control: SubagentProcessControl = {
    sendMessage: sendCommand,
    abort: abortProcess,
  };

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "response" && event.id) {
      const pending = pendingResponses.get(event.id);
      if (!pending) return;
      pendingResponses.delete(event.id);
      if (event.success) pending.resolve();
      else pending.reject(new Error(event.error || `RPC ${event.command || "command"} failed`));
      return;
    }

    if (event.type === "extension_ui_request") {
      const receivedAt = Date.now();
      const parsed = parseExtensionUIRequest(event);

      if (parsed.kind === "dialog") {
        // Register before exposing the event so a synchronous parent callback
        // can answer it without racing a second stdout event.
        const firstObservation = observeUIRequest(parsed.request, receivedAt);
        onEvent?.(event);
        if (!firstObservation) {
          onStderr?.(`Duplicate extension UI request ignored: ${sanitizeTerminalText(parsed.request.id)}\n`);
          return;
        }
        try {
          if (onExtensionUIRequest) onExtensionUIRequest(parsed.request, extensionUIChannel);
          else extensionUIChannel.respond(cancelledResponse(parsed.request.id));
        } catch (error) {
          onStderr?.(`Extension UI broker callback failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\n`);
          extensionUIChannel.respond(cancelledResponse(parsed.request.id));
        }
        return;
      }

      onEvent?.(event);
      if (parsed.kind === "invalid") {
        const usableId = typeof parsed.requestId === "string" && parsed.requestId.length > 0;
        if (parsed.blocking && usableId) {
          const firstObservation = observeMalformedUIRequest(
            parsed.requestId!,
            parsed.method || "unknown",
            receivedAt,
            parsed.timeout,
          );
          if (firstObservation) extensionUIChannel.respond(cancelledResponse(parsed.requestId!));
        }
        onStderr?.(`Invalid extension UI request: ${parsed.reason}\n`);
      } else if (!parsed.known) {
        onStderr?.(`Unhandled extension UI method left untouched: ${sanitizeTerminalText(parsed.method)}\n`);
      }
      return;
    }

    onEvent?.(event);

    if (event.type === "message_end" && event.message) {
      const msg = event.message;
      if (msg.role === "assistant") {
        result.usage.turns++;
        const usage = msg.usage;
        if (usage) {
          result.usage.input += usage.input || 0;
          result.usage.output += usage.output || 0;
          result.usage.cacheRead += usage.cacheRead || 0;
          result.usage.cacheWrite += usage.cacheWrite || 0;
          result.usage.cost += usage.cost?.total || 0;
          const contextTokens = contextTokensFromUsage(usage);
          // Preserve the last known context after providers emit an error or
          // zero-usage response, which cannot describe the active context.
          if (contextTokens > 0) result.usage.contextTokens = contextTokens;
        }
        if (!result.model && msg.model) result.model = msg.model;
        if (msg.stopReason) {
          result.stopReason = msg.stopReason;
          if (msg.errorMessage) {
            result.errorMessage = msg.errorMessage;
          } else if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
            // Pi can retry after a transient transport error. A later normal
            // assistant completion is the new terminal state, so do not let
            // the earlier error message make the recovered run fail.
            result.errorMessage = undefined;
          }
        } else if (msg.errorMessage) {
          result.errorMessage = msg.errorMessage;
        }

        if (Array.isArray(msg.content)) {
          let messageText = "";
          for (const part of msg.content) {
            if (part.type === "text") {
              messageText += (messageText ? "\n" : "") + part.text;
            }
            if (part.type === "toolCall") {
              const argsStr = JSON.stringify(part.arguments || {});
              result.toolCalls.push({
                name: part.name,
                argsPreview: argsStr.length > 80 ? argsStr.slice(0, 80) + "..." : argsStr,
              });
            }
          }
          // Only a normal final stop is a delegated-task result. Text from
          // an aborted assistant response is an incomplete turn and must not
          // leak into the result if the child later resumes or closes.
          if (msg.stopReason === "stop") result.finalOutput = messageText;
        }
      }
    }

    // `agent_end` can be followed by an automatic retry or compaction.
    // `agent_settled` is the lifecycle event that guarantees this turn is
    // really idle and safe for the parent tool call to finish.
    if (event.type === "agent_settled" && !initialSettled) {
      settleInitial();
    }
  };

  proc.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  proc.stderr!.on("data", (data: Buffer) => {
    const str = data.toString();
    collectedStderr += str;
    onStderr?.(str);
  });

  proc.on("close", (code) => {
    processExited = true;
    closeExtensionUIChannel();
    if (buffer.trim()) processLine(buffer);
    result.exitCode = code ?? 0;
    // Process lifetime is separate from assistant-turn lifetime. Once a
    // normal stop has been observed, the task is complete even if the
    // transport closes noisily. Otherwise this records terminal closure or
    // failure instead of leaving the parent request pending.
    finalizeChildResult(result, wasAborted, collectedStderr);
    rejectPending(new Error(result.errorMessage || "Subagent process exited"));
    onProcessExit?.(code);
    resolveClosed();
    settleInitial();
  });

  proc.on("error", (err) => {
    if (!result.errorMessage) result.errorMessage = `Spawn error: ${err.message}`;
    result.lifecycle = "failed";
    if (!processExited) {
      processExited = true;
      closeExtensionUIChannel();
      rejectPending(err);
      onProcessExit?.(1);
      resolveClosed();
      settleInitial();
    }
  });

  onProcessReady?.(proc, control);

  if (signal) {
    if (signal.aborted) abortProcess();
    else signal.addEventListener("abort", abortProcess, { once: true });
  }

  try {
    await sendCommand(taskText, "prompt");
    await initialResult;

    // Closing stdin tells RPC mode to shut down cleanly once the agent is
    // settled. This prevents completed subagents from remaining available.
    if (!processExited) proc.stdin?.end();
    await processClosed;
    return result;
  } catch (error) {
    result.errorMessage = error instanceof Error ? error.message : String(error);
    abortProcess();
    await initialResult;
    await processClosed;
    return result;
  } finally {
    // Keep the session directory and its JSONL history in /tmp. Only the
    // generated system-prompt input is disposable after the child exits.
    if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
  }
}

// ─── Concurrency Utility ────────────────────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
