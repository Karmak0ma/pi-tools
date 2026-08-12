/**
 * Subprocess runner for child pi processes.
 *
 * Spawns `pi --mode json -p --no-session` with resolved model/tools/cwd.
 * Collects JSON events from stdout and stderr separately.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { RuntimeSubagentInstance } from "./tracker.js";
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

// ─── Event Parsing ───────────────────────────────────────────────────────────

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
  onProcessReady?: (proc: ChildProcess) => void;
}

/**
 * Spawn a child pi process and collect results.
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
  } = options;

  // Run child agents in a minimal non-interactive environment. In particular,
  // disable extension discovery so UI/footer/sidebar extensions from the parent
  // user's config do not run inside the JSON-mode subprocess and leak stderr.
  // If specific extensions are allowed (childExtensionPaths), pass them explicitly.
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
  if (childExtensionPaths && childExtensionPaths.length > 0) {
    for (const extPath of childExtensionPaths) {
      args.push("-e", extPath);
    }
  }
  if (resolvedModel) args.push("--model", resolvedModel);
  if (thinking) args.push("--thinking", thinking);
  args.push("--tools", resolvedTools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let collectedStderr = "";

  const result: ChildRunResult = {
    exitCode: 0,
    usage: emptyUsage(),
    finalOutput: "",
    toolCalls: [],
  };

  try {
    if (agentPrompt.trim()) {
      const tmp = await writePromptToTempFile(agentName, agentPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${taskText}`);

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: resolvedCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      onProcessReady?.(proc);

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
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

            // Extract the latest assistant text as the final output.
            if (msg.content) {
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

        if (event.type === "tool_result_end" && event.message) {
          // Track tool results but don't update final output
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
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.errorMessage) {
          result.errorMessage = `Spawn error: ${err.message}`;
        }
        resolve(1);
      });

      if (signal) {
        let exited = false;
        proc.on("close", () => { exited = true; });
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!exited) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else {
          signal.addEventListener("abort", killProc, { once: true });
          // Remove listener when process exits to avoid buildup
          proc.on("close", () => {
            signal.removeEventListener("abort", killProc);
          });
        }
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) {
      result.stopReason = "aborted";
    } else if (exitCode !== 0 && !result.errorMessage) {
      const stderrSnippet = collectedStderr.trim().slice(0, 300);
      result.errorMessage = stderrSnippet
        ? `Child exited with code ${exitCode}: ${stderrSnippet}`
        : `Child exited with code ${exitCode}`;
    }
    return result;
  } finally {
    if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
  }
}

// ─── Concurrency Utility ─────────────────────────────────────────────────────

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
