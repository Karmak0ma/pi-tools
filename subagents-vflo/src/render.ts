/**
 * Rendering of the subagent tool rows (subagent, subagent_continue,
 * subagent_wait) and of the pushed background results message.
 *
 * Layout (agreed with mockups docs/mockups/tool-render-v2.html):
 *
 *   [subagent]
 *   ◆ 2 TASKS · 1 done · 1 running                  9 turns  ↑109k ↓6.0k  $0.053
 *
 *    DONE  explore  haiku-4-5   ██░░░░░░░░  22%     4 turns  ↑38k ↓2.1k  $0.012
 *    ⠋ RUN build    sonnet-4-5  ████░░░░░░  38%     5 turns  ↑71k ↓3.9k  $0.041
 *          └ $ npm test -- login
 *
 * Decisions from the user, and why they shape this file:
 * - One card on `customMessageBg` with a purple label, like pi-dcp and
 *   pi-advisor-flow. The tools use `renderShell: "self"`, so Pi does not put
 *   its own pending/success/error box around the card.
 * - The answer of a task is never shown, not even when expanded. The answer
 *   goes to the parent model; the user reads the parent's reply instead.
 * - Only running and failed (or stopped) tasks show their last tool call. A
 *   done task needs no activity line.
 * - The context bar is `usage.contextTokens / contextWindow`. When the window
 *   is unknown (model not in the registry, or a result stored before the
 *   field existed) the bar is left out.
 * - The spinner frame is taken from the clock. The redraws that make it turn
 *   come from a timer in index.ts (deliverTasks), not from here: the render
 *   functions stay pure and own no timers.
 */

import * as os from "node:os";
import {
  Box,
  Spacer,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  isTaskFailed,
  type LiveSubagentToolDetails,
  type PersistedSubagentToolDetails,
  type TaskUsage,
} from "./types.js";

// ─── Theme and context types ─────────────────────────────────────────────────

/**
 * Theme subset used here. Kept narrow on purpose so that tests can pass a
 * fake theme. `getBgAnsi` is needed to restore the card background after a
 * badge (see `badge`).
 */
export interface RenderTheme {
  fg(color: any, text: string): string;
  bg(color: any, text: string): string;
  bold(text: string): string;
  getBgAnsi(color: any): string;
}

/** Fields of Pi's ToolRenderContext that this file reads. All optional for tests. */
export interface RenderSlot {
  outputPad?: number;
  executionStarted?: boolean;
  // Narrowed to the one binding used here, so Pi's keyof-Keybindings signature fits.
  keyHint?: (keybinding: "app.tools.expand", description: string) => string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LABEL = "[subagent]";
/** Every badge is 6 cells wide, so agent names line up under each other. */
const BADGE_WIDTH = 6;
/** Indent of the lines under a task row: badge width plus one space. */
const INDENT = " ".repeat(BADGE_WIDTH + 1);
/** Context bar cells, plus 5 cells for " 100%". */
const BAR_CELLS = 10;
const BAR_WIDTH = BAR_CELLS + 5;
/** Caps for the agent and model columns, so one long name cannot push the stats off the row. */
const MAX_AGENT_WIDTH = 14;
const MAX_MODEL_WIDTH = 22;
/** Braille spinner, same frames as the mockup. One frame per SPINNER_MS. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_MS = 100;
/** Task previews shown in the call card while the model still streams the arguments. */
const CALL_PREVIEWS = 4;

// ─── Small helpers ───────────────────────────────────────────────────────────

/**
 * A component that builds its lines at render time, when the width is known.
 * The rows need the width to right-align the stats.
 */
class Lines implements Component {
  constructor(private readonly theme: RenderTheme, private readonly build: (width: number) => string[]) {}
  render(width: number): string[] {
    // truncateToWidth ends a cut line with a full SGR reset, which also
    // clears the card background for the padding Box adds after it. Switch
    // the card background on again after every line (no effect when uncut).
    const cardBg = this.theme.getBgAnsi("customMessageBg");
    return this.build(width).map((line) => truncateToWidth(line, width, "…") + cardBg);
  }
  invalidate(): void {}
}

function card(theme: RenderTheme, slot: RenderSlot): Box {
  return new Box(slot.outputPad ?? 1, 0, (text) => theme.bg("customMessageBg", text));
}

function label(theme: RenderTheme): string {
  return theme.fg("customMessageLabel", theme.bold(LABEL));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
  // Three decimals: subagent runs mostly cost cents. Very cheap runs keep a
  // fourth decimal so they do not read as free.
  return cost > 0 && cost < 0.001 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
}

/** Left part, then right part pushed to the right edge. Drops the right part when both do not fit. */
function leftRight(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return right && gap >= 2 ? left + " ".repeat(gap) + right : left;
}

/**
 * Pad or cut plain text (agent and model names) to a column width. Cut by
 * hand, not with truncateToWidth, whose SGR reset would clear the card
 * background in the middle of the row.
 */
function padTo(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible > width) return `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`;
  return text + " ".repeat(width - visible);
}

/** Wrap text under a task row, indented, with an optional colored prefix on the first line. */
function wrapIndented(text: string, width: number, prefix = ""): string[] {
  const room = Math.max(10, width - INDENT.length - visibleWidth(prefix));
  return wrapTextWithAnsi(text, room).map((line, index) =>
    INDENT + (index === 0 ? prefix : " ".repeat(visibleWidth(prefix))) + line);
}

/** "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5". The provider adds width, not meaning. */
function shortModel(model: string | undefined): string {
  if (!model) return "";
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function formatUsageStats(usage: TaskUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function aggregateUsage(summaries: Array<{ usage: TaskUsage }>): TaskUsage {
  const total: TaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  for (const s of summaries) {
    total.input += s.usage.input;
    total.output += s.usage.output;
    total.cacheRead += s.usage.cacheRead;
    total.cacheWrite += s.usage.cacheWrite;
    total.cost += s.usage.cost;
    total.turns += s.usage.turns;
  }
  return total;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(toolName: string, argsPreview: string, theme: RenderTheme): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsPreview.replace(/\.\.\.$/, ""));
  } catch {
    return theme.fg("accent", toolName) + theme.fg("dim", ` ${oneLine(argsPreview)}`);
  }
  const path = (fallback: string) => shortenPath(String(args.file_path || args.path || fallback));
  switch (toolName) {
    case "bash":
      return theme.fg("muted", "$ ") + theme.fg("toolOutput", oneLine(String(args.command || "...")));
    case "read":
    case "write":
    case "edit":
      return theme.fg("muted", `${toolName} `) + theme.fg("accent", path("..."));
    case "grep":
      return theme.fg("muted", "grep ") + theme.fg("accent", `/${args.pattern ?? ""}/`) + theme.fg("dim", ` in ${path(".")}`);
    case "find":
      return theme.fg("muted", "find ") + theme.fg("accent", String(args.pattern || "*")) + theme.fg("dim", ` in ${path(".")}`);
    default:
      return theme.fg("accent", toolName) + theme.fg("dim", ` ${oneLine(argsPreview)}`);
  }
}

// ─── Task view model ─────────────────────────────────────────────────────────

/** What the badge says. "stop" = cancelled by the parent; "fail" = any other failure. */
type Kind = "done" | "fail" | "run" | "wait" | "stop";

/** The fields of a live or persisted summary that the renderer reads. */
interface TaskView {
  agent: string;
  task: string;
  model?: string;
  warnings?: string[];
  status?: string;
  lifecycle?: string;
  stopReason?: string;
  errorMessage?: string;
  stderrPreview?: string;
  failed?: boolean;
  cancelledByParent?: boolean;
  toolCalls?: Array<{ name: string; argsPreview: string }>;
  usage?: TaskUsage;
  contextWindow?: number;
}

function kindOf(task: TaskView, live: boolean): Kind {
  // Persisted summaries have no `status`; only live rows can run or wait.
  if (live && task.status === "running") return "run";
  if (live && task.status === "queued") return "wait";
  if (task.cancelledByParent || task.status === "aborted") return "stop";
  return isTaskFailed(task as Parameters<typeof isTaskFailed>[0]) ? "fail" : "done";
}

/** The kinds that show the last tool call (user choice: not for done or queued tasks). */
const SHOWS_ACTIVITY: ReadonlySet<Kind> = new Set(["run", "fail", "stop"]);

/**
 * Status badge. Its background is a theme color, so after it the card
 * background must be switched on again: `theme.bg` ends with "reset to the
 * terminal default", which would leave the rest of the line uncolored.
 */
function badge(kind: Kind, theme: RenderTheme): string {
  const spin = SPINNER[Math.floor(Date.now() / SPINNER_MS) % SPINNER.length];
  const [bg, fg, text] = {
    done: ["toolSuccessBg", "success", " DONE "],
    fail: ["toolErrorBg", "error", " FAIL "],
    run: ["toolPendingBg", "warning", ` ${spin} RUN`],
    wait: ["selectedBg", "muted", " WAIT "],
    stop: ["toolPendingBg", "muted", " STOP "],
  }[kind];
  return theme.getBgAnsi(bg) + theme.fg(fg, theme.bold(text)) + theme.getBgAnsi("customMessageBg");
}

function contextBar(task: TaskView, theme: RenderTheme): string {
  const window = task.contextWindow;
  if (!window || window <= 0) return " ".repeat(BAR_WIDTH);
  const percent = Math.min(100, Math.round(((task.usage?.contextTokens ?? 0) / window) * 100));
  const filled = Math.round((percent / 100) * BAR_CELLS);
  // Same thresholds as the context gauges elsewhere in this setup.
  const color = percent > 60 ? "error" : percent > 40 ? "warning" : "accent";
  return theme.fg(color, "█".repeat(filled)) +
    theme.fg("borderMuted", "█".repeat(BAR_CELLS - filled)) +
    theme.fg("muted", `${String(percent).padStart(4)}%`);
}

function usageText(usage: TaskUsage, theme: RenderTheme, boldCost: boolean): string {
  if (!usage.turns && !usage.input && !usage.output && !usage.cost) return "";
  const turns = `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`;
  const tokens = `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
  const cost = formatCost(usage.cost);
  return theme.fg("muted", `${turns}  ${tokens}  `) + theme.fg("text", boldCost ? theme.bold(cost) : cost);
}

// ─── renderCall ──────────────────────────────────────────────────────────────

/**
 * The top of the card: the label, and what the call asks for. Task previews
 * show only until execution starts; after that the result rows list the
 * tasks, and the full task text is in the expanded view.
 */
export function renderCall(
  toolName: "subagent" | "subagent_continue" | "subagent_wait",
  args: any,
  theme: RenderTheme,
  slot: RenderSlot = {},
): Component {
  const box = card(theme, slot);
  box.addChild(new Spacer(1));
  const input = args && typeof args === "object" ? args : {};
  const lines: string[] = [];

  if (toolName === "subagent_continue") {
    const id = typeof input.taskId === "string" ? input.taskId : "…";
    lines.push(`${label(theme)} ${theme.fg("text", "Continue")} ${theme.fg("accent", id)}`);
    if (!slot.executionStarted && typeof input.task === "string") {
      lines.push(`  ${theme.fg("dim", `"${oneLine(input.task)}"`)}`);
    }
  } else if (toolName === "subagent_wait") {
    const ids = Array.isArray(input.ids) ? input.ids.filter((id: unknown) => typeof id === "string") : [];
    const target = ids.length > 0 ? theme.fg("accent", ids.join(", ")) : theme.fg("muted", "all background tasks");
    lines.push(`${label(theme)} ${theme.fg("text", "Wait for")} ${target}`);
  } else {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    lines.push(`${label(theme)} ${theme.fg("text", "Delegate")} ${theme.fg("muted", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`)}`);
    if (!slot.executionStarted) {
      for (const t of tasks.slice(0, CALL_PREVIEWS)) {
        const agent = typeof t?.agent === "string" ? t.agent : "…";
        const task = typeof t?.task === "string" ? oneLine(t.task) : "";
        lines.push(`  ${theme.fg("accent", agent)} ${theme.fg("dim", `"${task}"`)}`);
      }
      if (tasks.length > CALL_PREVIEWS) lines.push(theme.fg("dim", `  … ${tasks.length - CALL_PREVIEWS} more`));
    }
  }

  box.addChild(new Lines(theme, () => lines));
  return box;
}

// ─── renderResult ────────────────────────────────────────────────────────────

/**
 * The rest of the card: header with totals, one row per task, and the
 * activity or error lines. `title` is set only by the background results
 * message, which has no call card above it.
 */
export function renderResult(
  // Message content may be a plain string (custom messages); tool content is an array.
  result: { content?: string | Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; title?: string },
  theme: RenderTheme,
  slot: RenderSlot = {},
): Component {
  const box = card(theme, slot);
  if (options.title) {
    box.addChild(new Spacer(1));
    box.addChild(new Lines(theme, () => [`${label(theme)} ${theme.fg("text", options.title!)}`]));
  }

  const details = result.details as (LiveSubagentToolDetails | PersistedSubagentToolDetails) | undefined;
  const text = typeof result.content === "string"
    ? result.content
    : (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");

  // No task summaries: an async call's "started" note, a validation error,
  // or a wait that timed out before any task finished. Show the text as is.
  if (!details || !details.summaries || details.summaries.length === 0) {
    const failed = !!details && "overallFailed" in details && details.overallFailed;
    box.addChild(new Lines(theme, (width) => wrapTextWithAnsi(theme.fg(failed ? "error" : "muted", text || "(no output)"), width)));
    box.addChild(new Spacer(1));
    return box;
  }

  const live = "live" in details && details.live === true;
  const tasks = details.summaries as TaskView[];
  const kinds = tasks.map((task) => kindOf(task, live));
  const showBar = tasks.some((task) => task.contextWindow && task.contextWindow > 0);
  const agentWidth = Math.min(MAX_AGENT_WIDTH, Math.max(...tasks.map((t) => visibleWidth(t.agent))));
  const modelWidth = Math.min(MAX_MODEL_WIDTH, Math.max(0, ...tasks.map((t) => visibleWidth(shortModel(t.model)))));
  const waitNote = "waitNote" in details ? details.waitNote : undefined;
  const expandHint = !options.expanded && !live && slot.keyHint ? slot.keyHint("app.tools.expand", "to expand") : "";

  box.addChild(new Lines(theme, (width) => {
    const lines: string[] = [];

    // Header: count, per-kind counts, and totals on the right.
    const count = (kind: Kind) => kinds.filter((k) => k === kind).length;
    const parts: string[] = [];
    const addPart = (kind: Kind, word: string, color: string) => {
      if (count(kind) > 0) parts.push(theme.fg(color, `${count(kind)} ${word}`));
    };
    addPart("done", "done", "success");
    addPart("fail", "failed", "error");
    addPart("run", "running", "warning");
    addPart("wait", "queued", "muted");
    addPart("stop", "stopped", "muted");
    const title = theme.fg("accent", theme.bold(`◆ ${tasks.length} TASK${tasks.length === 1 ? "" : "S"}`));
    const header = [title, ...parts].join(theme.fg("muted", " · "));
    lines.push(leftRight(header, usageText(aggregateUsage(tasks.map((t) => ({ usage: t.usage ?? zeroUsage() }))), theme, !live), width));
    lines.push("");

    tasks.forEach((task, index) => {
      const kind = kinds[index];
      // Blank line between tasks only when expanded: collapsed stays compact.
      if (options.expanded && index > 0) lines.push("");

      const model = modelWidth > 0 ? ` ${theme.fg("muted", padTo(shortModel(task.model), modelWidth))}` : "";
      const bar = showBar ? ` ${contextBar(task, theme)}` : "";
      const left = `${badge(kind, theme)} ${theme.fg("accent", theme.bold(padTo(task.agent, agentWidth)))}${model}${bar}`;
      lines.push(leftRight(left, task.usage ? usageText(task.usage, theme, false) : "", width));

      if (options.expanded) lines.push(...wrapIndented(theme.fg("text", oneLine(task.task)), width, theme.fg("dim", "task ")));

      if (SHOWS_ACTIVITY.has(kind)) {
        const calls = task.toolCalls ?? [];
        const last = calls[calls.length - 1];
        // A running task always gets this line, even before its first tool
        // call: the row keeps the same height while the child streams.
        if (last) {
          const earlier = options.expanded && calls.length > 1 ? theme.fg("dim", `   +${calls.length - 1} earlier`) : "";
          lines.push(`${INDENT}${theme.fg("dim", "└ ")}${formatToolCall(last.name, last.argsPreview, theme)}${earlier}`);
        } else if (kind === "run") {
          lines.push(`${INDENT}${theme.fg("dim", "└ thinking…")}`);
        }
      }

      if (kind === "fail" || kind === "stop") {
        const message = task.errorMessage || (kind === "stop" ? "cancelled" : task.stopReason === "aborted" ? "aborted" : "unknown error");
        if (options.expanded) {
          lines.push(...wrapIndented(theme.fg("error", oneLine(message)), width, theme.fg("error", "✗ ")));
          if (task.stderrPreview) lines.push(...wrapIndented(theme.fg("dim", oneLine(task.stderrPreview)), width, theme.fg("dim", "stderr ")));
        } else {
          lines.push(`${INDENT}${theme.fg("error", `✗ ${oneLine(message)}`)}`);
        }
      }

      for (const warning of task.warnings ?? []) {
        if (options.expanded) lines.push(...wrapIndented(theme.fg("warning", oneLine(warning)), width, theme.fg("warning", "⚠ ")));
        else lines.push(`${INDENT}${theme.fg("warning", `⚠ ${oneLine(warning)}`)}`);
      }
    });

    if (waitNote) {
      lines.push("");
      for (const line of waitNote.split("\n")) lines.push(...wrapTextWithAnsi(theme.fg("muted", line), width));
    }
    if (expandHint) lines.push(leftRight("", theme.fg("dim", expandHint), width));
    return lines;
  }));
  box.addChild(new Spacer(1));
  return box;
}

function zeroUsage(): TaskUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
