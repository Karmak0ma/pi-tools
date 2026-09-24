/**
 * Deterministic, realistic-scale session used to measure and pin the request
 * path (`context` handler) of pi-dcp.
 *
 * Why synthetic: the real sessions that exposed the ~0.8 s per-request cost
 * contain private conversation data and are 10+ MB, so they cannot be
 * committed. This builder reproduces their SHAPE instead of their content:
 *
 * - about 1500 model-visible messages and more than 10 MB of JSON, dominated
 *   by large tool outputs, because hashing/cloning cost scales with bytes;
 * - repeated reads of the same file, so byte-identical tool outputs exist
 *   (the join must disambiguate repeated fingerprints, dedup can prune them);
 * - a persisted Pi 0.87 system message, which the system-free `context`
 *   event omits and the join must map around;
 * - one host `context_edit`, which Pi applies inside `buildSessionProjection`;
 * - active compression blocks, one of them nested, plus pruning and nudge
 *   operations, so the full replacement path runs instead of a raw fallback.
 *
 * Everything is derived from a seeded PRNG and fixed IDs/timestamps. The same
 * options always produce the same entries, so a hash of the transformed output
 * is a stable golden value: a performance change that alters output bytes is
 * a behavior change and must fail the golden test.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { OPERATION_CUSTOM_TYPE, type CreatedBlock, type DcpOperation, type OpEnvelope } from "../../src/state/operations.ts";
import { registerLifecycle } from "../../src/lifecycle.ts";
import { createRuntime, type DcpRuntime } from "../../src/runtime.ts";
import { reconstructFromBranch } from "../../src/state/reconstruct.ts";
import { currentHostSessionManager } from "./current-host.ts";

export interface SyntheticSessionOptions {
  /** Each turn contributes six messages: user, 3 assistant, 2 tool results. */
  turns: number;
  seed: number;
}

export const DEFAULT_SYNTHETIC_SESSION: SyntheticSessionOptions = { turns: 250, seed: 20260922 };

export interface SyntheticSession {
  entries: Record<string, unknown>[];
  leafId: string;
}

const SESSION_ID = "synthetic-session";
const BASE_TIME = 1_780_000_000_000;
/** Turns covered by each top-level compression block; the tail stays raw. */
const BLOCK_TURNS = 40;
const BLOCK_COUNT = 5;

/** mulberry32: tiny, fast, and fully deterministic across platforms. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["const", "return", "session", "entry", "projection", "message", "tool", "result", "block", "summary", "context", "export", "function", "await", "state", "index", "config", "value", "error", "unit"];

/** Build `bytes` of line-oriented, source-like text. */
function text(random: () => number, bytes: number, label: string): string {
  const lines: string[] = [];
  let size = 0;
  for (let line = 0; size < bytes; line++) {
    const words: string[] = [];
    const count = 4 + Math.floor(random() * 10);
    for (let word = 0; word < count; word++) words.push(WORDS[Math.floor(random() * WORDS.length)]!);
    const value = `${label}:${line} ${words.join(" ")};`;
    lines.push(value);
    size += value.length + 1;
  }
  return lines.join("\n");
}

function usage(random: () => number): Record<string, unknown> {
  const input = 1000 + Math.floor(random() * 5000);
  const output = 50 + Math.floor(random() * 800);
  const cacheRead = 100_000 + Math.floor(random() * 50_000);
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Deterministic UUIDv4-shaped operation ID; the envelope guard requires the format. */
function opId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function buildSyntheticSession(options: SyntheticSessionOptions = DEFAULT_SYNTHETIC_SESSION): SyntheticSession {
  const random = prng(options.seed);
  const entries: Record<string, unknown>[] = [];
  let clock = 0;
  let operationIndex = 0;
  const push = (entry: Record<string, unknown>): string => {
    const id = entry.id as string;
    entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(BASE_TIME + clock * 1000).toISOString() });
    clock++;
    return id;
  };
  const pushMessage = (id: string, message: Record<string, unknown>): string => push({ type: "message", id, message: { ...message, timestamp: BASE_TIME + clock * 1000 } });
  const pushOperation = (operation: DcpOperation): void => {
    const index = operationIndex++;
    const envelope: OpEnvelope = { schema: 2, opId: opId(index), requestKey: `synthetic-request-${index}`, originSessionId: SESSION_ID, createdAt: BASE_TIME + clock * 1000, extensionVersion: "0.2.0", operation };
    push({ type: "custom", id: `op-${index}`, customType: OPERATION_CUSTOM_TYPE, data: envelope });
  };

  // Pi 0.87 persists prompt/tool state as a leading system message. The
  // `context` event never carries it, so the join must map around it.
  pushMessage("system-0", {
    role: "system",
    content: "",
    sections: { base: text(random, 12_000, "prompt"), pi_dcp_context_compression: text(random, 3_000, "dcp") },
    toolsAdded: ["read", "bash", "edit", "compress"].map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } })),
  });

  // A small pool of files, re-read across turns, produces byte-identical tool
  // outputs; repeated fingerprints are the join's hard case.
  const files = Array.from({ length: 40 }, (_, index) => ({ path: `src/module-${index}.ts`, content: text(random, 8_000 + Math.floor(random() * 48_000), `file${index}`) }));
  const turnIds: string[][] = [];
  const toolCallsByTurn: string[][] = [];
  const readFileByTurn: number[] = [];

  for (let turn = 0; turn < options.turns; turn++) {
    const ids: string[] = [];
    const file = Math.floor(random() * files.length);
    readFileByTurn.push(file);
    const readCall = `call-${turn}-read`;
    const bashCall = `call-${turn}-bash`;
    toolCallsByTurn.push([readCall, bashCall]);
    ids.push(pushMessage(`u${turn}`, { role: "user", content: text(random, 80 + Math.floor(random() * 600), `user${turn}`) }));
    ids.push(pushMessage(`a${turn}-read`, { role: "assistant", content: [
      { type: "thinking", thinking: text(random, 200 + Math.floor(random() * 600), `think${turn}`) },
      { type: "toolCall", id: readCall, name: "read", arguments: { path: files[file]!.path } },
    ], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5", usage: usage(random), stopReason: "toolUse" }));
    ids.push(pushMessage(`r${turn}-read`, { role: "toolResult", toolCallId: readCall, toolName: "read", content: [{ type: "text", text: files[file]!.content }], isError: false }));
    ids.push(pushMessage(`a${turn}-bash`, { role: "assistant", content: [
      { type: "toolCall", id: bashCall, name: "bash", arguments: { command: `npm test -- module-${file}` } },
    ], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5", usage: usage(random), stopReason: "toolUse" }));
    ids.push(pushMessage(`r${turn}-bash`, { role: "toolResult", toolCallId: bashCall, toolName: "bash", content: [{ type: "text", text: text(random, 1_000 + Math.floor(random() * 14_000), `bash${turn}`) }], isError: random() < 0.1 }));
    ids.push(pushMessage(`a${turn}-reply`, { role: "assistant", content: [{ type: "text", text: text(random, 100 + Math.floor(random() * 700), `reply${turn}`) }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5", usage: usage(random), stopReason: "stop" }));
    turnIds.push(ids);

    // Compressions are recorded shortly after the range they cover closes,
    // as the compress tool would, so operations interleave with messages.
    const closed = turn - 1;
    if (closed >= 0 && (closed + 1) % BLOCK_TURNS === 0 && (closed + 1) / BLOCK_TURNS <= BLOCK_COUNT) {
      const blockNumber = (closed + 1) / BLOCK_TURNS;
      const first = closed + 1 - BLOCK_TURNS;
      pushOperation(compression(`b${blockNumber}`, first, closed, [], 0));
    }
    // One nested compression consumes the first two blocks.
    if (turn === 2 * BLOCK_TURNS + 5) pushOperation(compression("nested-1", 0, 2 * BLOCK_TURNS - 1, ["b1", "b2"], 1));
    // Automatic dedup pruning in the raw tail: older reads of a file re-read later.
    if (turn === options.turns - 20) pushOperation(dedupDecisions(BLOCK_COUNT * BLOCK_TURNS, turn));
    if (turn % 60 === 59) pushOperation({ type: "nudge.requested", kind: "context", nudgeKey: `nudge-${turn}`, band: "soft", branchAnchor: `a${turn}-reply`, configGeneration: 0 });
  }

  // One host edit replaces a tail tool result, as Pi 0.87 context_edit does.
  const editedTurn = options.turns - 10;
  push({ type: "context_edit", id: "edit-0", targetId: `r${editedTurn}-bash`, replacement: { content: [{ type: "text", text: "[edited by host: output trimmed]" }] } });

  function compression(blockId: string, firstTurn: number, lastTurn: number, consumed: string[], nestedDepth: number): DcpOperation {
    const entryIds = turnIds.slice(firstTurn, lastTurn + 1).flat();
    const toolCallIds = toolCallsByTurn.slice(firstTurn, lastTurn + 1).flat();
    const block: CreatedBlock = {
      blockId,
      ordinal: 0,
      topic: `Synthetic work ${blockId}`,
      summary: text(random, 1_500, `summary-${blockId}`),
      authoredSummary: text(random, 1_500, `authored-${blockId}`),
      estimatedSummaryTokens: 400,
      estimatedSourceTokens: 200_000,
      estimatedSavingsTokens: 199_600,
      coverage: { directEntryIds: entryIds, effectiveEntryIds: entryIds, directToolCallIds: toolCallIds, effectiveToolCallIds: toolCallIds },
      anchor: { beforeEntryId: firstTurn === 0 ? "system-0" : turnIds[firstTurn - 1]!.at(-1), afterEntryId: `u${lastTurn + 1}` },
      consumedBlockIds: consumed,
      nestedDepth,
    };
    return { type: "compression.created", runId: `run-${blockId}`, mode: "range", toolCallId: `compress-${blockId}`, snapshotHash: `snapshot-${blockId}`, model: { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" }, blocks: [block] };
  }

  function dedupDecisions(firstTurn: number, beforeTurn: number): DcpOperation {
    const decisions = [];
    for (let turn = firstTurn; turn < beforeTurn; turn++) {
      const rereadLater = readFileByTurn.slice(turn + 1, beforeTurn).includes(readFileByTurn[turn]!);
      if (rereadLater) decisions.push({ toolCallId: toolCallsByTurn[turn]![0]!, kind: "dedup-output" as const, estimatedTokens: 5_000 });
    }
    return { type: "tools.pruned", decisions };
  }

  return { entries, leafId: entries.at(-1)!.id as string };
}

/**
 * The messages Pi 0.87 hands to an extension `context` handler: the projected
 * model context without system messages and without assistant turns that the
 * provider boundary drops.
 */
export function contextEventMessages(entries: readonly unknown[], leafId: string): AgentMessage[] {
  // Pi's ExtensionRunner.emitContext structured-clones the messages before any
  // handler runs. Clone here too: without it the input would share objects with
  // the session projection, and an identity-based shortcut would look faster in
  // the benchmark than it is in real Pi.
  return structuredClone(buildSessionProjection(entries as any, leafId).messages.filter((message) => message.role !== "system"
    && !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))));
}

export interface ContextHarness {
  runtime: DcpRuntime;
  incoming: AgentMessage[];
  /** One full request through the registered `context` handler. */
  run(): Promise<{ messages: AgentMessage[] }>;
}

/**
 * Drive the real lifecycle `context` handler, not only the pipeline, because
 * the handler owns work the pipeline does not (for example its own fallback
 * clone). `sessionManager` may be a real Pi SessionManager for a session file.
 */
export function createContextHarness(sessionManager: any, incoming: AgentMessage[]): ContextHarness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); } } as any;
  const runtime = createRuntime(pi);
  registerLifecycle(pi, runtime);
  runtime.sessionId = SESSION_ID;
  runtime.reduced = reconstructFromBranch(sessionManager.getBranch()).state;
  const ctx = {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages", contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 150_000, contextWindow: 1_000_000 }),
    sessionManager,
    ui: { notify: () => undefined },
  };
  const handler = handlers.get("context")!;
  return { runtime, incoming, run: async () => await handler({ messages: incoming }, ctx) as { messages: AgentMessage[] } };
}

/** Harness over the default synthetic session. */
export function createSyntheticHarness(options: SyntheticSessionOptions = DEFAULT_SYNTHETIC_SESSION): ContextHarness {
  const session = buildSyntheticSession(options);
  return createContextHarness(currentHostSessionManager(session.entries, session.leafId), contextEventMessages(session.entries, session.leafId));
}
