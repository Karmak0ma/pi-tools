/**
 * Herdr detection and CLI client.
 *
 * This module is the single place in the extension that knows Herdr exists.
 * Everything else — the backends, the orchestration in index.ts — works
 * against the backend contract or the HerdrClient interface defined here.
 *
 * CLI behavior:
 * - Server errors arrive as JSON ({error:{code,message}}) with exit code 1;
 *   usage errors exit 2 as plain text. Both must be surfaced as failures.
 * - WHICH STREAM carries the error envelope is a herdr implementation detail
 *   and has already changed: it was documented as stdout for 0.8.2, but
 *   herdr 0.9.0 writes it to stderr and leaves stdout empty. Parsing stdout
 *   only meant every error lost its `herdrCode`, which silently disabled
 *   both prompt-error and pane-death classification in production while
 *   the unit tests (which fed envelopes on stdout) stayed green. That turned
 *   a recoverable startup condition into a hard subagent spawn failure.
 *   parseCliResult() therefore searches BOTH streams and never depends on
 *   which one is used, so this comment cannot rot back into a live bug.
 * - Success payloads are JSON on stdout with exit code 0.
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
 * Parse one blob as a herdr JSON envelope. Returns null for anything that is
 * not a JSON object, so callers can keep scanning instead of throwing.
 */
function parseEnvelope(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Find a matching envelope inside one stream.
 *
 * The whole stream is tried first because the normal shape is exactly one
 * JSON document. The line scan is the safety net: a single unrelated log or
 * warning line must never hide the envelope behind a whole-stream parse
 * failure, which is precisely how error classification silently died before
 * (see the transport note in this module's header).
 */
function findEnvelope(stream: string, matches: (envelope: any) => boolean): any | null {
  const whole = parseEnvelope(stream);
  if (whole && matches(whole)) return whole;
  for (const line of stream.split("\n")) {
    const parsed = parseEnvelope(line);
    if (parsed && matches(parsed)) return parsed;
  }
  return null;
}

const hasErrorPayload = (envelope: any): boolean => !!envelope.error && typeof envelope.error === "object";

/** Build the thrown error for an `{error:{code,message}}` payload. */
function envelopeError(operation: string, payload: any): Error {
  const error = new Error(
    `herdr ${operation} failed: ${payload.code ?? "error"}${payload.message ? `: ${payload.message}` : ""}`,
  );
  (error as any).herdrCode = payload.code;
  return error;
}

/**
 * Parse a herdr CLI response.
 *
 * Both streams are searched for the error envelope because which stream
 * carries it is a herdr implementation detail that has already changed once
 * (see this module's header). Classification must not depend on it: a lost
 * `herdrCode` silently disables every recovery path built on it.
 *
 * The parsed `result` payload is returned; an `error` payload is thrown with
 * its code attached so callers can classify stalled/not-found responses.
 * Usage errors (exit 2, plain text) and unparsable output become plain
 * errors carrying the first output line.
 */
function parseCliResult(operation: string, res: HerdrCommandResult): any {
  // stdout wins when both streams carry an envelope: older herdr versions put
  // errors there, and a stderr envelope alongside a stdout one would be log
  // noise rather than the command's own verdict.
  const errorEnvelope =
    findEnvelope(res.stdout, hasErrorPayload) ?? findEnvelope(res.stderr, hasErrorPayload);
  if (errorEnvelope) throw envelopeError(operation, errorEnvelope.error);

  // Success payloads stay stdout-only (verified live on 0.9.0: exit 0, JSON on
  // stdout, empty stderr). The line scan already tolerates a log line printed
  // before the payload; accepting a success payload from stderr instead would
  // risk returning an unrelated log object as a command result.
  const parsed = findEnvelope(res.stdout, () => true);
  if (!parsed || res.exitCode !== 0) {
    const failure = new Error(
      `herdr ${operation} failed (exit ${res.exitCode}): ${firstLine(res.stderr || res.stdout) || "no output"}`,
    );
    throw failure;
  }
  return parsed.result ?? parsed;
}

/** Error codes that mean the pane (or its agent) no longer exists. */
const HERDR_NOT_FOUND_CODES = new Set(["pane_not_found", "agent_not_found"]);

function isHerdrNotFound(error: unknown): boolean {
  return HERDR_NOT_FOUND_CODES.has((error as any)?.herdrCode);
}

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * The surface of Herdr the Herdr backend needs. Declared as an interface so
 * the backend can be tested against a fake without spawning anything.
 */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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
   * Wait until Herdr observes an agent state. The Herdr backend uses
   * `idle` before the first prompt only as the FALLBACK startup gate, when
   * the child runs without Pi's lifecycle hook. That gate is known to be
   * racy: see `agentGet` and docs/design-herdr-backend.md. It does not use
   * Herdr's prompt-confirmation stall mode because that fixed 5s observation
   * window races Pi's startup handshake.
   */
  agentWait(target: string, status: HerdrAgentStatus, timeoutMs: number): Promise<void>;
  /**
   * One snapshot of an agent's state as Herdr sees it.
   *
   * `lifecycleHookAuthority` is the readiness signal for the first prompt.
   * Herdr reports `idle` for a Pi agent long before Pi can take input: with
   * no hook report yet, it uses `default_known_agent_idle_fallback`, a guess.
   * A prompt typed during that window lands in the editor but is never
   * submitted. Pi's lifecycle hook sends its first report from Pi's
   * `session_start`, which Pi emits only after its real submit handler is
   * installed, so hook authority proves the editor accepts Enter.
   */
  agentGet(target: string): Promise<{ agentStatus?: string; lifecycleHookAuthority: boolean }>;
  /** Type a prompt into the agent's terminal and press Enter. */
  agentPrompt(target: string, text: string): Promise<void>;
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

  async agentWait(target: string, status: HerdrAgentStatus, timeoutMs: number): Promise<void> {
    // Herdr's wait command is a readiness gate only. Task completion remains
    // the child's session JSONL, not this UI-level state observation.
    parseCliResult(
      "agent wait",
      await this.run(
        ["agent", "wait", target, "--until", status, "--timeout", String(timeoutMs)],
        timeoutMs + DEFAULT_COMMAND_TIMEOUT_MS,
      ),
    );
  }

  async agentGet(target: string): Promise<{ agentStatus?: string; lifecycleHookAuthority: boolean }> {
    const result = parseCliResult("agent get", await this.run(["agent", "get", target], DEFAULT_COMMAND_TIMEOUT_MS));
    const agent = result?.agent ?? result;
    return {
      agentStatus: typeof agent?.agent_status === "string" ? agent.agent_status : undefined,
      // Verified live on herdr 0.9.0: this field is absent while Herdr uses
      // its idle fallback guess, and `true` once the hook owns the state
      // (`herdr agent explain` then shows
      // `screen_detection_skip_reason: full_lifecycle_hook_authority`). It is
      // not a documented contract. A strict `=== true` makes a renamed field
      // fail closed: startup times out with a clear error instead of typing
      // into a Pi that is not ready.
      lifecycleHookAuthority: agent?.screen_detection_skipped === true,
    };
  }

  async agentPrompt(target: string, text: string): Promise<void> {
    // Fire-and-forget mode: completion is decided by the session watcher, not
    // by Herdr's idle/done status, which is a UI-seen state rather than task
    // semantics. parseCliResult surfaces agent_blocked and other server errors.
    parseCliResult("agent prompt", await this.run(["agent", "prompt", target, text], DEFAULT_COMMAND_TIMEOUT_MS));
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