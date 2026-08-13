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
import { emptyUsage, type TaskUsage, type ThinkingLevel } from "./types.js";

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

// ─── Temp File Management ────────────────────────────────────────────────────

export async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
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
  usage: TaskUsage;
  finalOutput: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
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
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
  onStderr?: (data: string) => void;
  onProcessReady?: (proc: ChildProcess, control: SubagentProcessControl) => void;
  onProcessExit?: (code: number | null) => void;
}

type PendingResponse = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function commandName(delivery: ChildMessageDelivery): "prompt" | "steer" {
  return delivery;
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
    signal,
    onEvent,
    onStderr,
    onProcessReady,
    onProcessExit,
  } = options;

  const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions"];
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
    usage: emptyUsage(),
    finalOutput: "",
    toolCalls: [],
  };

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  if (agentPrompt.trim()) {
    const tmp = await writePromptToTempFile(agentName, agentPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
  }

  const invocation = getPiInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd: resolvedCwd,
    shell: false,
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
          result.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!result.model && msg.model) result.model = msg.model;
        if (msg.stopReason) result.stopReason = msg.stopReason;
        if (msg.errorMessage) result.errorMessage = msg.errorMessage;

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
          if (messageText) {
            result.finalOutput = result.finalOutput
              ? `${result.finalOutput}\n\n${messageText}`
              : messageText;
          }
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
    if (buffer.trim()) processLine(buffer);
    result.exitCode = code ?? 0;
    if (wasAborted) {
      result.stopReason = "aborted";
    } else if (result.exitCode !== 0 && !result.errorMessage) {
      const stderrSnippet = collectedStderr.trim().slice(0, 300);
      result.errorMessage = stderrSnippet
        ? `Child exited with code ${result.exitCode}: ${stderrSnippet}`
        : `Child exited with code ${result.exitCode}`;
    }
    rejectPending(new Error(result.errorMessage || "Subagent process exited"));
    onProcessExit?.(code);
    resolveClosed();
    settleInitial();
  });

  proc.on("error", (err) => {
    if (!result.errorMessage) result.errorMessage = `Spawn error: ${err.message}`;
    if (!processExited) {
      processExited = true;
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
    if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
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
