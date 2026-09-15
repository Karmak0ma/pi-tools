/**
 * Herdr detection and CLI client.
 *
 * This module is the single place in the extension that knows Herdr exists.
 * Everything else — the backends, the orchestration in index.ts — works
 * against the backend contract or the HerdrClient interface defined here.
 *
 * CLI behavior verified against herdr 0.8.2:
 * - Server errors arrive as JSON ({error:{code,message}}) on stdout with
 *   exit code 1; usage errors exit 2. Both must be surfaced as failures.
 * - `pane get` / `agent get` report pane_not_found / agent_not_found after a
 *   pane or its process is gone; these codes mean "the child is dead".
 * - `pane close` kills the process running inside the pane and is a no-op
 *   success for an already-closed pane.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ─── Detection ───────────────────────────────────────────────────────────────

/** Env var Herdr sets in every pane it hosts. "1" means "inside Herdr". */
export const HERDR_ENV_VAR = "HERDR_ENV";

/** Env var naming the pane a process runs in; required to anchor pane splits. */
export const HERDR_PANE_ID_VAR = "HERDR_PANE_ID";

/** Pi's override for the directory that contains its extensions and settings. */
export const PI_CODING_AGENT_DIR_VAR = "PI_CODING_AGENT_DIR";

const HERDR_AGENT_STATE_EXTENSION = path.join("extensions", "herdr-agent-state.ts");

/**
 * Match Pi's agent-directory resolution, including its documented `~/...`
 * expansion for PI_CODING_AGENT_DIR. Keeping this small rule local prevents a
 * custom directory written the same way for Pi from silently disabling Herdr's
 * lifecycle reporting in the child. Relative overrides are anchored at the
 * child's cwd because that is where the explicitly launched Pi resolves them.
 */
function resolvePiAgentDir(env: NodeJS.ProcessEnv, baseDir: string): string {
  const configuredDir = env[PI_CODING_AGENT_DIR_VAR];
  if (!configuredDir) return path.join(os.homedir(), ".pi", "agent");
  if (configuredDir === "~") return os.homedir();
  if (configuredDir.startsWith("~/") || (process.platform === "win32" && configuredDir.startsWith("~\\"))) {
    return path.join(os.homedir(), configuredDir.slice(2));
  }
  return path.isAbsolute(configuredDir) ? configuredDir : path.resolve(baseDir, configuredDir);
}

/**
 * Resolve Herdr's managed Pi lifecycle extension for an explicitly launched
 * child session.
 *
 * Herdr can infer an agent's state from terminal output, but that fallback is
 * intentionally weaker than the lifecycle reports sent by this extension. A
 * child started with `--no-extensions` does not load the managed integration,
 * so Herdr sees the Pi prompt's ready/idle screen even while the model is
 * working. The child argv must therefore opt this one integration back in.
 *
 * The path follows Pi's own configuration contract: use
 * PI_CODING_AGENT_DIR when it is set, otherwise use Pi's default
 * ~/.pi/agent directory. Returning null when the file is unavailable is
 * deliberate. A package can run without Herdr's optional integration, while
 * passing a nonexistent `-e` path would prevent the child from starting.
 */
export function resolveHerdrAgentStateExtension(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
): string | null {
  const candidate = path.join(resolvePiAgentDir(env, baseDir), HERDR_AGENT_STATE_EXTENSION);

  try {
    if (!fs.statSync(candidate).isFile()) return null;
    // Canonicalizing makes the result stable and lets the backend avoid loading
    // the same integration twice when user configuration names a symlink.
    return fs.realpathSync.native(candidate);
  } catch {
    // The integration is optional: an incomplete Herdr installation must not
    // turn an otherwise valid subagent spawn into a hard startup failure.
    return null;
  }
}

/**
 * Whether this process appears to run inside a Herdr workspace.
 * Kept as a pure env check so it is testable without spawning anything.
 */
export function isHerdrEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERDR_ENV_VAR] === "1";
}

/**
 * Which subagent execution backend should be used in this process.
 *
 * Herdr detection requires both markers: HERDR_ENV proves the workspace
 * context, and HERDR_PANE_ID is the anchor pane that `pane split --current`
 * divides. A workspace without a pane id cannot host child panes, so such a
 * process falls back to the default (RPC) backend instead of failing at
 * spawn time.
 */
export function selectBackendKind(env: NodeJS.ProcessEnv = process.env): "herdr" | "default" {
  return isHerdrEnvironment(env) && !!env[HERDR_PANE_ID_VAR] ? "herdr" : "default";
}

// ─── CLI transport ───────────────────────────────────────────────────────────

export interface HerdrCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one herdr CLI invocation. Injectable so tests never touch the real
 * binary. The runner owns timeouts because a wedged CLI call must never hang
 * a watcher forever.
 */
export type HerdrCommandRunner = (args: string[], timeoutMs: number) => Promise<HerdrCommandResult>;

/** Upper bound for any single herdr invocation that has no server-side wait. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Default runner: spawn the herdr binary, capture output, enforce a timeout.
 *
 * The child inherits this process's environment, which carries HERDR_SOCKET_PATH
 * and HERDR_PANE_ID — that is how `--current` anchors to the calling pane even
 * though no flag re-states it.
 */
export function createHerdrCommandRunner(binPath?: string): HerdrCommandRunner {
  const command = binPath || process.env.HERDR_BIN_PATH || "herdr";
  return (args, timeoutMs) => {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;

      // Hard bound so a hung server cannot leave an orphaned watcher behind.
      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
        reject(new Error(`herdr ${args[0] ?? ""} ${args[1] ?? ""} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  };
}

/** First line of CLI output, for error messages that stay one line long. */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * Parse a herdr CLI response. Server errors are JSON on stdout with exit 1;
 * parse failures and usage errors (exit 2, plain text) become plain errors.
 * The parsed `result` payload is returned; an `error` payload is thrown with
 * its code attached so callers can classify not-found responses.
 */
function parseCliResult(operation: string, res: HerdrCommandResult): any {
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`herdr ${operation} failed (exit ${res.exitCode}): ${firstLine(res.stderr || res.stdout) || "no output"}`);
  }
  if (parsed && typeof parsed === "object" && parsed.error) {
    const error = new Error(
      `herdr ${operation} failed: ${parsed.error.code ?? "error"}${parsed.error.message ? `: ${parsed.error.message}` : ""}`,
    );
    (error as any).herdrCode = parsed.error.code;
    throw error;
  }
  if (res.exitCode !== 0) {
    throw new Error(`herdr ${operation} failed (exit ${res.exitCode}): ${firstLine(res.stderr || res.stdout) || "no output"}`);
  }
  return parsed?.result ?? parsed;
}

/** Error codes that mean the pane (or its agent) no longer exists. */
const HERDR_NOT_FOUND_CODES = new Set(["pane_not_found", "agent_not_found"]);

function isHerdrNotFound(error: unknown): boolean {
  return HERDR_NOT_FOUND_CODES.has((error as any)?.herdrCode);
}

/**
 * Whether a confirmed agentPrompt failed because Herdr never observed the
 * pane leave idle within its submission-stall window. This is Herdr's own
 * documented signal for a possibly-lost submission (e.g. the trailing Enter
 * keystroke swallowed by a still-initializing child) — not proof that
 * nothing was sent, which is why callers must not resubmit blindly.
 */
export function isHerdrPromptStalled(error: unknown): boolean {
  return (error as any)?.herdrCode === "agent_prompt_stalled";
}

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * The surface of Herdr the Herdr backend needs. Declared as an interface so
 * the backend can be tested against a fake without spawning anything.
 */
export interface HerdrClient {
  /**
   * Split the calling pane into a new pane. `--no-focus` is always sent: a
   * spawned subagent must never steal keyboard focus from the parent.
   */
  paneSplit(options: { direction: "right" | "down"; cwd: string; env: Record<string, string> }): Promise<{ paneId: string }>;
  /**
   * Start a pi agent in an existing pane and wait until it is interactive-ready.
   * Rejects if the agent never becomes ready (the pane stays usable for cleanup).
   */
  agentStart(name: string, paneId: string, agentArgs: string[], timeoutMs: number): Promise<void>;
  /**
   * Type a prompt into the agent's terminal and press Enter.
   *
   * Without `options.confirmWithinMs`, this returns as soon as Herdr accepts
   * the command — the fire-and-forget mode used for mid-task steering, where
   * the child is already running and the submission race below cannot occur.
   *
   * With `options.confirmWithinMs`, waits for Herdr to observe the agent
   * leave `idle` (into `working` or `blocked`) within that many
   * milliseconds, confirming the submission actually took effect. Rejects
   * with `herdrCode: "agent_prompt_stalled"` when it does not — Herdr's own
   * signal that the text may have landed without the trailing Enter taking
   * effect. Herdr's docs are explicit that this does not prove nothing was
   * sent, so callers must not resubmit blindly.
   */
  agentPrompt(target: string, text: string, options?: { confirmWithinMs?: number }): Promise<void>;
  /** Send raw terminal keys (e.g. "enter") into an agent's interactive UI, bypassing bracketed-paste typing. */
  agentSendKeys(target: string, keys: string[]): Promise<void>;
  /** Pane state including agent_status (idle/working/blocked); throws on unexpected errors. */
  paneGet(paneId: string): Promise<{ state: "exists" | "gone"; agentStatus?: string }>;
  /** Close a pane (kills its process). Tolerates an already-closed pane. */
  paneClose(paneId: string): Promise<void>;
  /** Pane rectangles for the tab containing paneId, used to pick a split direction. */
  paneLayout(paneId: string): Promise<Array<{ paneId: string; width?: number; height?: number }>>;
}

export class HerdrCli implements HerdrClient {
  constructor(private readonly run: HerdrCommandRunner = createHerdrCommandRunner()) {}

  async paneSplit(options: { direction: "right" | "down"; cwd: string; env: Record<string, string> }): Promise<{ paneId: string }> {
    const args = [
      "pane", "split", "--current",
      "--direction", options.direction,
      "--ratio", "0.5",
      "--cwd", options.cwd,
      "--no-focus",
    ];
    for (const [key, value] of Object.entries(options.env)) {
      args.push("--env", `${key}=${value}`);
    }
    const result = parseCliResult("pane split", await this.run(args, DEFAULT_COMMAND_TIMEOUT_MS));
    const paneId = result?.pane?.pane_id;
    if (typeof paneId !== "string" || !paneId) {
      throw new Error("herdr pane split returned no pane id");
    }
    return { paneId };
  }

  async agentStart(name: string, paneId: string, agentArgs: string[], timeoutMs: number): Promise<void> {
    // The CLI's own --timeout bounds the wait for interactive readiness; the
    // runner timeout adds slack for process startup and transport.
    const result = parseCliResult(
      "agent start",
      await this.run(
        ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(timeoutMs), "--", ...agentArgs],
        timeoutMs + 10_000,
      ),
    );
    if (!result?.agent) throw new Error("herdr agent start returned no agent");
  }

  async agentPrompt(target: string, text: string, options?: { confirmWithinMs?: number }): Promise<void> {
    // Fire-and-forget mode: completion is decided by the session watcher, not
    // by Herdr's idle/done status, which is a UI-seen state rather than task
    // semantics. parseCliResult surfaces agent_blocked and other server errors.
    const args = ["agent", "prompt", target, text];
    let timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
    if (options?.confirmWithinMs) {
      // Confirm mode: ask Herdr itself to verify the pane left idle. This is
      // narrowly about "did the submission take effect", not about task
      // completion — --until stops the wait the moment the turn begins,
      // instead of waiting for the whole turn to settle.
      args.push("--wait", "--until", "working", "--until", "blocked", "--timeout", String(options.confirmWithinMs));
      // The CLI's own --timeout bounds the wait; the runner timeout adds
      // slack for process startup and transport, matching agentStart's pattern.
      timeoutMs = options.confirmWithinMs + DEFAULT_COMMAND_TIMEOUT_MS;
    }
    parseCliResult("agent prompt", await this.run(args, timeoutMs));
  }

  async agentSendKeys(target: string, keys: string[]): Promise<void> {
    parseCliResult("agent send-keys", await this.run(["agent", "send-keys", target, ...keys], DEFAULT_COMMAND_TIMEOUT_MS));
  }

  async paneGet(paneId: string): Promise<{ state: "exists" | "gone"; agentStatus?: string }> {
    try {
      const result = parseCliResult("pane get", await this.run(["pane", "get", paneId], DEFAULT_COMMAND_TIMEOUT_MS));
      const pane = result?.pane ?? result;
      const agentStatus = typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
      return { state: "exists", agentStatus };
    } catch (error) {
      if (isHerdrNotFound(error)) return { state: "gone" };
      throw error;
    }
  }

  async paneClose(paneId: string): Promise<void> {
    try {
      parseCliResult("pane close", await this.run(["pane", "close", paneId], DEFAULT_COMMAND_TIMEOUT_MS));
    } catch (error) {
      // An already-closed pane is the normal outcome when the child exited on
      // its own first; anything else is a real failure.
      if (!isHerdrNotFound(error)) throw error;
    }
  }

  async paneLayout(paneId: string): Promise<Array<{ paneId: string; width?: number; height?: number }>> {
    const result = parseCliResult("pane layout", await this.run(["pane", "layout", "--pane", paneId], DEFAULT_COMMAND_TIMEOUT_MS));
    const panes = result?.layout?.panes;
    if (!Array.isArray(panes)) return [];
    return panes
      .filter((pane: any) => typeof pane?.pane_id === "string")
      .map((pane: any) => ({
        paneId: pane.pane_id as string,
        width: typeof pane.rect?.width === "number" ? pane.rect.width : undefined,
        height: typeof pane.rect?.height === "number" ? pane.rect.height : undefined,
      }));
  }
}