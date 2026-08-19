import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingLevelMap,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const AGENT_ID = "pi-model";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STDERR_LIMIT = 20_000;
const TOOL_REPAIR_ATTEMPTS = 1;
const TOOL_OUTPUT_PREVIEW_LIMIT = 4_000;

const DEFAULT_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-super-free",
  "opencode/big-pickle",
];

let registeredModels: string[] = [];
let registeredVariants: Map<string, string[]> = new Map();
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

function opencodeBin(): string {
  return process.env.OPENCODE_PI_BIN?.trim() || "opencode";
}

function configuredModels(): string[] | undefined {
  const raw = process.env.OPENCODE_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((model) => (model.includes("/") ? model : `opencode/${model}`));
}

function modelDisplayName(model: string): string {
  const [, id = model] = model.split(/\/(.*)/s);
  return `OpenCode ${id}`;
}

function contextWindowFor(model: string): number {
  if (model.includes("big-pickle")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensFor(model: string): number {
  if (model.includes("big-pickle")) return 32_000;
  return DEFAULT_MAX_TOKENS;
}

function looksFree(model: string): boolean {
  return /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(model);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function thinkingLevelMapFor(
  variants: string[],
): ThinkingLevelMap | undefined {
  if (variants.length === 0) return undefined;
  const available = new Set(variants);
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    // null excludes a level from pi's supported list; undefined does not.
    map[level] = available.has(level) ? level : null;
  }
  return map as ThinkingLevelMap;
}

function providerModelFor(
  model: string,
  thinkingMap: ThinkingLevelMap | undefined,
) {
  return {
    id: model,
    name: `${modelDisplayName(model)} (OpenCode CLI)`,
    reasoning: thinkingMap !== undefined,
    thinkingLevelMap: thinkingMap,
    input: ["text"] as ("text" | "image")[],
    contextWindow: contextWindowFor(model),
    maxTokens: maxTokensFor(model),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function runCapture(
  args: string[],
  input?: string,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opencodeBin(), args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`opencode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    if (input !== undefined) {
      child.stdin!.end(input);
    }
  });
}

function parseVerboseModels(stdout: string): Map<string, string[]> {
  const variantsByModel = new Map<string, string[]>();
  const lines = stdout.split(/\r?\n/);
  let currentModel: string | undefined;
  let jsonLines: string[] = [];
  const flush = () => {
    if (!currentModel || jsonLines.length === 0) return;
    try {
      const record = JSON.parse(jsonLines.join("\n"));
      const variants = record?.variants;
      if (variants && typeof variants === "object" && !Array.isArray(variants)) {
        const names = Object.keys(variants);
        if (names.length > 0) variantsByModel.set(currentModel, names);
      }
    } catch {
      // Malformed records degrade gracefully: the model stays reasoning:false.
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^opencode\/\S+$/.test(trimmed)) {
      flush();
      currentModel = trimmed;
      jsonLines = [];
    } else if (currentModel) {
      jsonLines.push(line);
    }
  }
  flush();
  return variantsByModel;
}

async function discoverModels(): Promise<{
  models: string[];
  variantsByModel: Map<string, string[]>;
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  if (configured?.length) {
    lastDiscoveryError = undefined;
    return {
      models: dedupe(configured),
      variantsByModel: new Map(),
      time: Date.now(),
      error: undefined,
    };
  }

  try {
    // --verbose exposes each model's variants map; older opencode builds may
    // reject the flag, so fall back to the plain list (no variant data).
    const verbose = await runCapture(["models", "opencode", "--verbose"]);
    const result =
      verbose.code !== 0 || !verbose.stdout.trim()
        ? await runCapture(["models", "opencode"])
        : verbose;
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `opencode models exited with code ${result.code}`,
      );
    }
    const discovered = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("opencode/"))
      .filter(looksFree);
    const variantsByModel =
      result === verbose ? parseVerboseModels(result.stdout) : new Map();
    lastDiscoveryError = undefined;
    return {
      models: dedupe(discovered.length > 0 ? discovered : DEFAULT_FREE_MODELS),
      variantsByModel,
      time: Date.now(),
      error: undefined,
    };
  } catch (error) {
    lastDiscoveryError = error instanceof Error ? error.message : String(error);
    return {
      models: DEFAULT_FREE_MODELS,
      variantsByModel: new Map(),
      time: Date.now(),
      error: lastDiscoveryError,
    };
  }
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
  const previousModels = new Set(registeredModels);
  const { models, variantsByModel, time, error } = await discoverModels();
  registeredModels = models;
  registeredVariants = variantsByModel;
  lastDiscoveryTime = time;

  // Re-register the provider with the updated model list
  const providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] = {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: models.map((model) =>
      providerModelFor(model, thinkingLevelMapFor(variantsByModel.get(model) ?? [])),
    ),
    streamSimple: streamOpenCode,
  };

  try {
    pi.registerProvider(PROVIDER_ID, providerConfig);
  } catch {
    // registerProvider may reject if already registered; the models array is already updated.
  }

  const newModels = models.filter((m) => !previousModels.has(m));

  let msg = `opencode-pi: refreshed ${models.length} model(s).`;
  if (newModels.length > 0) {
    msg += ` ${newModels.length} new: ${newModels.slice(0, 5).join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
  }
  if (error) msg += ` Discovery issue: ${error}`;
  ctx.ui.notify(msg, "info");
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function setEstimatedUsage(
  model: Model<Api>,
  output: AssistantMessage,
  prompt: string,
  text: string,
) {
  if (output.usage.totalTokens > 0) return;
  output.usage.input = estimateTokens(prompt);
  output.usage.output = estimateTokens(text);
  output.usage.totalTokens = output.usage.input + output.usage.output;
  calculateCost(model, output.usage);
}

function contentToText(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image omitted: ${item.mimeType}, ${item.data.length} base64 chars]`;
    })
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeMessage(message: Message): string {
  if (message.role === "user") {
    return `USER:\n${contentToText(message.content)}`;
  }

  if (message.role === "toolResult") {
    return [
      `PI TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content),
    ].join("\n");
  }

  const parts = message.content.map(
    (part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking")
        return `<thinking>${part.thinking}</thinking>`;
      return `<pi_tool_call>${safeJson({ name: part.name, arguments: part.arguments })}</pi_tool_call>`;
    },
  );
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
  if (!tools || tools.length === 0)
    return "No Pi tools are available for this turn.";
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function buildPrompt(context: Context): string {
  const sections: string[] = [];
  sections.push(`# Pi/OpenCode bridge instructions

You are being used as the model backend for Pi Coding Agent through the OpenCode CLI.
Pi tools are enabled and available through the bridge below. Use them whenever the task requires file access, commands, edits, searches, or any other listed capability.
OpenCode's separate built-in tools are disabled because Pi executes the bridged tool calls itself. This does not restrict your access to the Pi tools listed below.

When a tool is needed, emit one or more Pi tool-call blocks and no surrounding prose:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only the exact tool names and parameters listed in the "Available Pi tools" section.
- The JSON inside each marker must contain a "name" string and an "arguments" object.
- Always nest every tool parameter inside "arguments". Example: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>
- Emit compact valid JSON: no Markdown fences, comments, trailing commas, XML escaping, or explanatory text inside the marker.
- Do not put parameters beside "name", and do not prefix parameter names with dashes.
- Use an empty object when a tool has no parameters: "arguments":{}.
- If you can answer without a tool, answer normally in plain text without mentioning this protocol.
- After Pi returns tool results, continue from the transcript and either answer or emit the next Pi tool call.`);

  if (context.systemPrompt?.trim()) {
    sections.push(`# Pi system prompt

${context.systemPrompt}`);
  }

  sections.push(`# Available Pi tools

${serializeTools(context.tools)}`);

  if (context.messages.length > 0) {
    sections.push(`# Conversation transcript

${context.messages.map(serializeMessage).join("\n\n---\n\n")}`);
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for Pi.");
  return sections.join("\n\n---\n\n");
}

type ParsedToolCall = {
  name: string;
  arguments: Record<string, any>;
};

type ParsedToolResult = {
  calls: ParsedToolCall[];
  detected: boolean;
  issue?: string;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, value: string) => {
      const radix = value.toLowerCase().startsWith("x") ? 16 : 10;
      const digits = value.toLowerCase().startsWith("x") ? value.slice(1) : value;
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match;
    });
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJson(text: string): string | undefined {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;

    const stack: string[] = [];
    let inString = false;
    let quote = "";
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          inString = false;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        inString = true;
        quote = char;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
        continue;
      }
      if (char !== "}" && char !== "]") continue;
      if (stack[stack.length - 1] !== char) break;
      stack.pop();
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function extractLeadingBalancedJson(text: string): string | undefined {
  const firstJsonStart = text.search(/[\{\[]/);
  if (firstJsonStart < 0) return undefined;
  const fromRoot = text.slice(firstJsonStart);
  const balanced = extractBalancedJson(fromRoot);
  // extractBalancedJson may skip an unbalanced outer object and find a nested one;
  // only a payload rooted at the first JSON delimiter completes the marker.
  return balanced && fromRoot.startsWith(balanced) ? balanced : undefined;
}

function convertSingleQuotedStrings(text: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of text) {
    if (inSingle) {
      if (escaped) {
        result += char === '"' ? '\\"' : char === "'" ? "'" : `\\${char}`;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'") {
        result += '"';
        inSingle = false;
      } else if (char === '"') {
        result += '\\"';
      } else {
        result += char;
      }
      continue;
    }

    if (inDouble) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inDouble = false;
      continue;
    }

    if (char === "'") {
      result += '"';
      inSingle = true;
    } else {
      result += char;
      if (char === '"') inDouble = true;
    }
  }
  if (escaped) result += "\\";
  if (inSingle) result += '"';
  return result;
}

function repairJsonLike(text: string): string {
  let repaired = convertSingleQuotedStrings(text);
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_$][\w$.-]*)\s*:/g, '$1"$2":');
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

function parseJsonLike(raw: string): { value?: any; error?: string } {
  const cleaned = stripCodeFence(decodeHtmlEntities(raw));
  const candidates = [cleaned];
  const extracted = extractBalancedJson(cleaned);
  if (extracted && extracted !== cleaned) candidates.push(extracted);

  let lastError = "invalid JSON";
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    try {
      return { value: JSON.parse(repairJsonLike(candidate)) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: lastError };
}

function extractMarkerBodies(text: string): {
  bodies: string[];
  detected: boolean;
  incomplete: boolean;
} {
  const decoded = decodeHtmlEntities(text);
  const bodies: string[] = [];
  let cursor = 0;
  let detected = false;
  let incomplete = false;

  while (cursor < decoded.length) {
    const opening = /<\s*pi_tool_call\s*>/i.exec(decoded.slice(cursor));
    if (!opening || opening.index === undefined) break;
    detected = true;
    const bodyStart = cursor + opening.index + opening[0].length;
    const closing = /<\s*\/\s*pi_tool_call\s*>/i.exec(decoded.slice(bodyStart));
    if (!closing || closing.index === undefined) {
      const unterminatedBody = decoded.slice(bodyStart);
      const balancedPayload = extractLeadingBalancedJson(unterminatedBody);
      // The opening marker establishes tool intent; a balanced payload is a complete
      // protocol unit even when a model substitutes its own DSML closing token.
      bodies.push(balancedPayload ?? unterminatedBody);
      incomplete = balancedPayload === undefined;
      break;
    }
    bodies.push(decoded.slice(bodyStart, bodyStart + closing.index));
    cursor = bodyStart + closing.index + closing[0].length;
  }

  if (!detected && /<\s*\/\s*pi_tool_call\s*>/i.test(decoded)) {
    detected = true;
    incomplete = true;
  }
  return { bodies, detected, incomplete };
}

function normalizeToolArguments(candidate: any): Record<string, any> | undefined {
  const functionValue = candidate?.function;
  let args =
    candidate?.arguments ??
    candidate?.args ??
    candidate?.input ??
    candidate?.parameters ??
    functionValue?.arguments ??
    functionValue?.input;

  // Tolerate models that put tool parameters beside the tool name.
  if (args === undefined && candidate && typeof candidate === "object") {
    args = Object.fromEntries(
      Object.entries(candidate).filter(
        ([key]) => !["name", "tool", "type", "function"].includes(key),
      ),
    );
  }

  if (typeof args === "string") {
    const parsed = parseJsonLike(args);
    if (parsed.value !== undefined) args = parsed.value;
    else return undefined;
  }
  if (args === undefined) args = {};
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return undefined;

  const normalized: Record<string, any> = {};
  for (const [rawKey, value] of Object.entries(args)) {
    const key = rawKey.trim().replace(/^-+/, "");
    if (key && !(key in normalized)) normalized[key] = value;
  }
  return normalized;
}

function toolName(candidate: any): string | undefined {
  if (typeof candidate?.name === "string") return candidate.name.trim();
  if (typeof candidate?.tool === "string") return candidate.tool.trim();
  if (typeof candidate?.function?.name === "string")
    return candidate.function.name.trim();
  return undefined;
}

function parseToolCallJson(raw: string): {
  calls: ParsedToolCall[];
  issue?: string;
} {
  const parsed = parseJsonLike(raw);
  if (parsed.value === undefined)
    return { calls: [], issue: `invalid tool-call JSON (${parsed.error})` };

  const value = parsed.value;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(value?.tool_calls)
      ? value.tool_calls
      : [value];
  const calls: ParsedToolCall[] = [];
  const issues: string[] = [];
  for (const candidate of candidates) {
    const name = toolName(candidate);
    const args = normalizeToolArguments(candidate);
    if (!name) {
      issues.push("tool call is missing a name");
      continue;
    }
    if (!args) {
      issues.push(`tool ${name} has invalid arguments; expected an object`);
      continue;
    }
    calls.push({ name, arguments: args });
  }
  return { calls, issue: issues.length > 0 ? issues.join("; ") : undefined };
}

function validateToolCall(call: ParsedToolCall, tools: Tool[]): string | undefined {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return `unknown Pi tool ${JSON.stringify(call.name)}`;

  const schema = tool.parameters as any;
  if (!schema || schema.type !== "object") return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in call.arguments))
      return `tool ${call.name} is missing required argument ${JSON.stringify(key)}`;
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    const unknown = Object.keys(call.arguments).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
      return `tool ${call.name} received unknown argument(s): ${unknown.join(", ")}`;
  }
  return undefined;
}

export function parseToolCalls(text: string, tools: Tool[]): ParsedToolResult {
  const markers = extractMarkerBodies(text);
  const trimmed = decodeHtmlEntities(text).trim();
  let bodies = markers.bodies;
  let detected = markers.detected;
  let issue = markers.incomplete ? "tool-call marker is missing its closing tag" : undefined;

  if (bodies.length === 0 && !detected) {
    // Markerless fallback is deliberately narrow: ordinary JSON answers must stay
    // text, while a root JSON object/array carrying tool-call keys is recoverable.
    const startsWithJson = /^[\s`]*(?:\{|\[)/.test(trimmed);
    const hasToolCallEnvelope = /["']tool_calls["']\s*:/.test(trimmed);
    const hasToolIdentity = /["'](?:name|tool|function)["']\s*:/.test(trimmed);
    const hasArgumentEnvelope =
      /["'](?:arguments|args|input|parameters)["']\s*:/.test(trimmed);
    const looksLikeToolJson =
      startsWithJson &&
      (hasToolCallEnvelope || (hasToolIdentity && hasArgumentEnvelope));
    if (looksLikeToolJson) {
      bodies = [trimmed];
      detected = true;
    }
  }
  if (!detected) return { calls: [], detected: false };

  const parsedCalls: ParsedToolCall[] = [];
  for (const body of bodies) {
    const parsed = parseToolCallJson(body);
    if (parsed.issue) issue = issue ? `${issue}; ${parsed.issue}` : parsed.issue;
    parsedCalls.push(...parsed.calls);
  }
  const validCalls: ParsedToolCall[] = [];
  for (const call of parsedCalls) {
    const validationIssue = validateToolCall(call, tools);
    if (validationIssue) issue = issue ? `${issue}; ${validationIssue}` : validationIssue;
    else validCalls.push(call);
  }
  if (validCalls.length === 0 && !issue) issue = "no valid Pi tool call was found";
  return { calls: validCalls, detected: true, issue };
}

async function createTempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-pi-"));
  const agentsDir = join(dir, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, `${AGENT_ID}.md`),
    `---
description: Pi bridge agent. OpenCode-native tools are denied; Pi executes bridged calls.
mode: primary
permission:
  read: deny
  edit: deny
  glob: deny
  grep: deny
  list: deny
  bash: deny
  task: deny
  external_directory: deny
  todowrite: deny
  webfetch: deny
  websearch: deny
  lsp: deny
  skill: deny
  question: deny
  doom_loop: deny
---
Use the Pi tools listed in the user prompt, not OpenCode-native tools. When a Pi tool is needed, emit only compact valid JSON inside <pi_tool_call>...</pi_tool_call>, with exact name and nested arguments. Do not use Markdown fences or surrounding prose.
`, 
    "utf8",
  );
  return dir;
}

type OpenCodeTurnResult = {
  text: string;
  reasoning: string;
  stderr: string;
  code: number | null;
  toolUse?: string;
};

async function runOpenCodeTurn(
  model: Model<Api>,
  tempDir: string,
  prompt: string,
  signal: AbortSignal | undefined,
  output: AssistantMessage,
  variant?: string,
): Promise<OpenCodeTurnResult> {
  let accumulatedText = "";
  let accumulatedReasoning = "";
  let stderr = "";
  let stdoutRemainder = "";
  let opencodeToolUse: string | undefined;
  const args = [
    "run",
    "--pure",
    "-m",
    model.id,
    "--agent",
    AGENT_ID,
    "--format",
    "json",
    "--dir",
    tempDir,
  ];
  if (variant) args.push("--variant", variant, "--thinking");
  const child = spawn(opencodeBin(), args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
  });

  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  child.stdin!.end(prompt);
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      stderr = (stderr + `\n${line}`).slice(-STDERR_LIMIT);
      return;
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      accumulatedText += event.part.text;
      return;
    }
    if (event.type === "reasoning" && typeof event.part?.text === "string") {
      accumulatedReasoning += event.part.text;
      return;
    }
    if (event.type === "step_finish" && event.part?.tokens) {
      const tokens = event.part.tokens;
      output.usage.input = Number(tokens.input ?? 0);
      output.usage.output =
        Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
      output.usage.cacheRead = Number(tokens.cache?.read ?? 0);
      output.usage.cacheWrite = Number(tokens.cache?.write ?? 0);
      output.usage.totalTokens = Number(
        tokens.total ??
          output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite,
      );
      calculateCost(model, output.usage);
      return;
    }
    if (event.type === "tool_use") {
      opencodeToolUse = event.part?.tool ? String(event.part.tool) : "unknown";
      return;
    }
    if (event.type === "error")
      stderr = (stderr + `\n${safeJson(event)}`).slice(-STDERR_LIMIT);
  };

  child.stdout!.on("data", (chunk: string) => {
    stdoutRemainder += chunk;
    const lines = stdoutRemainder.split(/\r?\n/);
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  signal?.removeEventListener("abort", abort);
  if (stdoutRemainder.trim()) handleLine(stdoutRemainder);
  return {
    text: accumulatedText,
    reasoning: accumulatedReasoning,
    stderr,
    code,
    toolUse: opencodeToolUse,
  };
}

function streamOpenCode(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let tempDir: string | undefined;
    const prompt = buildPrompt(context);
    const reasoning = options?.reasoning;
    const variant = reasoning
      ? model.thinkingLevelMap?.[reasoning] ?? undefined
      : undefined;

    try {
      stream.push({ type: "start", partial: output });
      tempDir = await createTempAgentDir();

      let result: OpenCodeTurnResult | undefined;
      let parsed: ParsedToolResult | undefined;
      let requestPrompt = prompt;
      for (let attempt = 0; attempt <= TOOL_REPAIR_ATTEMPTS; attempt += 1) {
        result = await runOpenCodeTurn(
          model,
          tempDir,
          requestPrompt,
          options?.signal,
          output,
          variant,
        );
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        if (result.code !== 0)
          throw new Error(
            result.stderr.trim() || `opencode exited with code ${result.code}`,
          );
        if (result.toolUse)
          throw new Error(
            `OpenCode attempted to use its own tool (${result.toolUse}). ${PROVIDER_ID} disables OpenCode tools; use Pi tool-call markers only.`,
          );

        parsed = parseToolCalls(result.text, context.tools ?? []);
        // Never discard executable calls because a malformed sibling or harmless
        // terminator also produced a diagnostic; repair is only for zero-call intent.
        if (parsed.calls.length > 0 || !parsed.issue || !parsed.detected) break;
        if (attempt === TOOL_REPAIR_ATTEMPTS) {
          const preview = result.text.trim().slice(0, TOOL_OUTPUT_PREVIEW_LIMIT);
          throw new Error(
            `OpenCode produced an invalid Pi tool call after ${attempt + 1} attempt(s): ${parsed.issue}. Output: ${preview}`,
          );
        }
        requestPrompt = `${prompt}

Your previous response could not be converted into a Pi tool call: ${parsed.issue}.
Retry now. Emit only one compact, valid <pi_tool_call>{"name":"exact_tool_name","arguments":{}}</pi_tool_call> marker. Use an exact tool name from Available Pi tools, nest all parameters under arguments, and do not use prose, Markdown, comments, trailing commas, or XML entities.`;
      }

      const accumulatedText = result?.text ?? "";
      const toolCalls = parsed?.calls ?? [];
      setEstimatedUsage(model, output, prompt, accumulatedText);

      const reasoningText = result?.reasoning ?? "";
      if (reasoningText) {
        const contentIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: reasoningText });
        stream.push({
          type: "thinking_start",
          contentIndex,
          partial: output,
        });
        stream.push({
          type: "thinking_delta",
          contentIndex,
          delta: reasoningText,
          partial: output,
        });
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: reasoningText,
          partial: output,
        });
      }

      if (toolCalls.length > 0) {
        output.stopReason = "toolUse";
        for (const call of toolCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `opencode_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({
            type: "toolcall_start",
            contentIndex,
            partial: output,
          });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: safeJson(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall,
            partial: output,
          });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      const contentIndex = output.content.length;
      output.content.push({ type: "text", text: accumulatedText });
      stream.push({ type: "text_start", contentIndex, partial: output });
      if (accumulatedText) {
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: accumulatedText,
          partial: output,
        });
      }
      stream.push({
        type: "text_end",
        contentIndex,
        content: accumulatedText,
        partial: output,
      });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  })();

  return stream;
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `OpenCode binary: ${opencodeBin()}`,
    `OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "check PATH with /opencode-pi test" : "no"}`,
    `Registered models: ${registeredModels.length}`,
    `Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
  ];
  if (lastDiscoveryError)
    lines.push(`Discovery fallback: ${lastDiscoveryError}`);
  lines.push("");
  for (const model of registeredModels) {
    const variants = registeredVariants.get(model);
    const variantLabel =
      variants && variants.length > 0 ? ` (variants: ${variants.join(", ")})` : "";
    lines.push(`  - ${PROVIDER_ID}/${model}${variantLabel}`);
  }
  lines.push("");
  lines.push(
    "OpenCode login is not required for the bundled free OpenCode models.",
  );
  lines.push(
    "Pi tools are enabled through prompt-level tool-call markers; only OpenCode-native tools are disabled.",
  );
  lines.push(
    "Run /opencode-pi update to refresh the model list from opencode.",
  );
  return lines;
}

export default async function opencodePiExtension(pi: ExtensionAPI) {
  const { models, variantsByModel, time } = await discoverModels();
  registeredModels = models;
  registeredVariants = variantsByModel;
  lastDiscoveryTime = time;

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map((model) =>
      providerModelFor(
        model,
        thinkingLevelMapFor(variantsByModel.get(model) ?? []),
      ),
    ),
    streamSimple: streamOpenCode,
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `opencode-pi: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
    if (lastDiscoveryError) {
      ctx.ui.notify(
        `opencode-pi: model discovery used fallback (${lastDiscoveryError})`,
        "warning",
      );
    }
  });

  pi.registerCommand("opencode-pi", {
    description: "OpenCode CLI bridge status and setup help",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels) {
          const variants = registeredVariants.get(model);
          const variantLabel =
            variants && variants.length > 0
              ? ` (variants: ${variants.join(", ")})`
              : "";
          ctx.ui.notify(`${PROVIDER_ID}/${model}${variantLabel}`, "info");
        }
        ctx.ui.notify(
          `Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0] ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `OpenCode check: ${opencodeBin()} run -m ${registeredModels[0] ?? DEFAULT_FREE_MODELS[0]} --format json "Reply OK"`,
          "info",
        );
        return;
      }
      if (sub === "update") {
        await refreshModels(pi, ctx);
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(
          "Usage: /opencode-pi [status|models|test|update|help]",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_BIN to override the opencode executable.",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_MODELS to register a custom comma-separated model list.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Unknown /opencode-pi subcommand: ${sub}. Try /opencode-pi help`,
        "warning",
      );
    },
  });
}
