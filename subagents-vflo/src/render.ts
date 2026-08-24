/**
 * Rendering helpers for the subagent tool.
 *
 * Phase 1/2: Tool-row rendering only.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  isTaskFailed,
  type LiveSubagentToolDetails,
  type PersistedSubagentToolDetails,
  type PersistedTaskSummary,
  type TaskUsage,
} from "./types.js";

// ─── Render Cache ────────────────────────────────────────────────────────────

/**
 * Cache for expensive rendered components.
 * Key: composite of task content hash + expanded state.
 * Prevents re-creating Markdown instances on every render frame.
 */
interface RenderCacheEntry {
  container: any;
  contentKey: string;
}

const renderCache = new Map<string, RenderCacheEntry>();
const MAX_CACHE_SIZE = 20;

function computeContentKey(details: PersistedSubagentToolDetails): string {
  // Hash based on: task count, each task's final output length, error messages, usage
  const parts: string[] = [`tc:${details.taskCount}`];
  for (const s of details.summaries) {
    const ps = s as PersistedTaskSummary;
    parts.push(`${ps.agent}:${ps.finalOutput?.length ?? 0}:${ps.errorMessage ?? ''}:${ps.usage?.output ?? 0}`);
  }
  return parts.join('|');
}

function getCachedResult(cacheKey: string, contentKey: string): any | undefined {
  const entry = renderCache.get(cacheKey);
  if (entry && entry.contentKey === contentKey) return entry.container;
  return undefined;
}

function setCachedResult(cacheKey: string, contentKey: string, container: any): void {
  if (renderCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    const firstKey = renderCache.keys().next().value;
    if (firstKey) renderCache.delete(firstKey);
  }
  renderCache.set(cacheKey, { container, contentKey });
}

/** Clear the render cache (for testing or when tool rows are disposed). */
export function clearRenderCache(): void {
  renderCache.clear();
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
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

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(
  toolName: string,
  argsPreview: string,
  themeFg: (color: any, text: string) => string,
): string {
  // Try to parse args for better formatting
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsPreview.replace(/\.\.\.$/,""));
  } catch {
    return themeFg("accent", toolName) + themeFg("dim", ` ${argsPreview}`);
  }

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "read ") + themeFg("accent", shortenPath(rawPath));
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default:
      return themeFg("accent", toolName) + themeFg("dim", ` ${argsPreview}`);
  }
}

// ─── Aggregate Usage ─────────────────────────────────────────────────────────

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

// ─── renderCall ──────────────────────────────────────────────────────────────

export function renderCall(args: any, theme: any): any {
  const tasks = args.tasks as Array<{ agent: string; task: string }> | undefined;
  if (!tasks || tasks.length === 0) {
    return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("muted", "(no tasks)"), 0, 0);
  }

  let text = theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", `tasks (${tasks.length})`);

  for (const t of tasks.slice(0, 4)) {
    const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
    text += `\n  ${theme.fg("accent", t.agent.padEnd(8))} ${theme.fg("dim", `"${preview}"`)}`;
  }
  if (tasks.length > 4) {
    text += `\n  ${theme.fg("muted", `... +${tasks.length - 4} more`)}`;
  }

  return new Text(text, 0, 0);
}

// ─── renderResult ────────────────────────────────────────────────────────────

export function renderResult(result: any, options: { expanded: boolean }, theme: any): any {
  const details = result.details as (LiveSubagentToolDetails | PersistedSubagentToolDetails) | undefined;
  if (!details || details.taskCount === 0) {
    const text = result.content?.[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  const summaries = details.summaries;
  const mdTheme = getMarkdownTheme();

  // Determine overall status
  const completedCount = summaries.filter((s: any) => !isTaskFailed(s) && s.status !== "running" && s.status !== "queued").length;
  const errorCount = summaries.filter((s: any) => isTaskFailed(s)).length;
  const runningCount = "live" in details && details.live
    ? summaries.filter((s: any) => s.status === "running").length
    : 0;
  const isLive = runningCount > 0;

  const icon = isLive
    ? theme.fg("warning", "⏳")
    : errorCount > 0 && completedCount === 0
      ? theme.fg("error", "✗")
      : errorCount > 0
        ? theme.fg("warning", "◐")
        : theme.fg("success", "✓");

  const status = isLive
    ? `${completedCount + errorCount}/${summaries.length} done, ${runningCount} running`
    : `${completedCount}/${summaries.length}`;

  if (options.expanded && !isLive) {
    // Use cache: expanded views with Markdown are expensive to build
    const persistedDetails = details as PersistedSubagentToolDetails;
    const contentKey = computeContentKey(persistedDetails);
    const cacheKey = `expanded:${contentKey}`;
    const cached = getCachedResult(cacheKey, contentKey);
    if (cached) return cached;

    const container = new Container();
    container.addChild(new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold("tasks "))}${theme.fg("accent", status)}`,
      0, 0,
    ));

    for (const s of summaries as PersistedTaskSummary[]) {
      const isFailed = isTaskFailed(s);
      const sIcon = s.stopReason === "aborted"
        ? theme.fg("warning", "⊘")
        : isFailed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      container.addChild(new Spacer(1));
      container.addChild(new Text(
        `${theme.fg("muted", "─── ")}${theme.fg("accent", s.agent)} ${sIcon}`,
        0, 0,
      ));

      // Show tool calls
      for (const tc of s.toolCalls.slice(0, 10)) {
        container.addChild(new Text(
          theme.fg("muted", "  → ") + formatToolCall(tc.name, tc.argsPreview, theme.fg.bind(theme)),
          0, 0,
        ));
      }
      if (s.toolCalls.length > 10) {
        container.addChild(new Text(theme.fg("muted", `  ... +${s.toolCalls.length - 10} more`), 0, 0));
      }

      // Show final output as markdown
      if (s.finalOutput) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(s.finalOutput.trim(), 0, 0, mdTheme));
      }

      // Show error message
      if (s.errorMessage) {
        container.addChild(new Text(
          theme.fg("error", `  ✗ ${s.errorMessage}`),
          0, 0,
        ));
      }

      // Show stderr preview
      if (s.stderrPreview) {
        const preview = s.stderrPreview.length > 200 ? s.stderrPreview.slice(0, 200) + "..." : s.stderrPreview;
        container.addChild(new Text(
          theme.fg("dim", `  stderr: ${preview}`),
          0, 0,
        ));
      }

      // Warnings
      if (s.warnings.length > 0) {
        container.addChild(new Text(
          theme.fg("warning", `  ⚠ ${s.warnings.join("; ")}`),
          0, 0,
        ));
      }

      // Per-task usage
      const taskUsage = formatUsageStats(s.usage, s.model);
      if (taskUsage) container.addChild(new Text(theme.fg("dim", `  ${taskUsage}`), 0, 0));
    }

    // Total usage
    const totalUsage = formatUsageStats(aggregateUsage(summaries as PersistedTaskSummary[]));
    if (totalUsage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
    }

    setCachedResult(cacheKey, contentKey, container);
    return container;
  }

  // Collapsed view
  let text = `${icon} ${theme.fg("toolTitle", theme.bold("tasks "))}${theme.fg("accent", status)}`;

  // When live streaming, use a fixed-height compact format to prevent height changes
  if (isLive) {
    for (const s of summaries as any[]) {
      const isFailed = isTaskFailed(s);
      const sIcon = (s.status === "running")
        ? theme.fg("warning", "⏳")
        : (s.status === "aborted" || s.stopReason === "aborted")
          ? theme.fg("warning", "⊘")
          : isFailed
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");

      const toolCount = (s.toolCalls || []).length;
      const toolInfo = toolCount > 0 ? theme.fg("dim", ` (${toolCount} tool call${toolCount > 1 ? "s" : ""})`) : "";
      text += `\n${theme.fg("muted", "─── ")}${theme.fg("accent", s.agent)} ${sIcon}${toolInfo}`;
    }
    return new Text(text, 0, 0);
  }

  // Completed/static collapsed view — full detail
  for (const s of summaries as any[]) {
    const isFailed = isTaskFailed(s);
    const sIcon = (s.status === "running")
      ? theme.fg("warning", "⏳")
      : (s.status === "aborted" || s.stopReason === "aborted")
        ? theme.fg("warning", "⊘")
        : isFailed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");

    text += `\n${theme.fg("muted", "─── ")}${theme.fg("accent", s.agent)} ${sIcon}`;

    // Show tool calls (max 3)
    const toolCalls = s.toolCalls || [];
    for (const tc of toolCalls.slice(0, 3)) {
      text += `\n  ${theme.fg("muted", "→ ")}${formatToolCall(tc.name, tc.argsPreview, theme.fg.bind(theme))}`;
    }

    // Show output preview or error
    const output = s.finalOutput || s.latestOutput || "";
    if (isFailed) {
      const errMsg = s.errorMessage || (s.stopReason === "aborted" ? "(aborted)" : "(unknown error)");
      text += `\n  ${theme.fg("error", errMsg)}`;
      if (s.stderrPreview) {
        const stderrLine = s.stderrPreview.split("\n")[0];
        const truncStderr = stderrLine.length > 80 ? stderrLine.slice(0, 80) + "..." : stderrLine;
        text += `\n  ${theme.fg("dim", `stderr: ${truncStderr}`)}`;
      }
    } else if (output) {
      const preview = output.split("\n").slice(0, 2).join("\n");
      const truncated = preview.length > 100 ? preview.slice(0, 100) + "..." : preview;
      text += `\n  ${theme.fg("toolOutput", truncated)}`;
    } else if (s.status === "running") {
      text += `\n  ${theme.fg("muted", "(running...)")}`;
    }
  }

  // Warnings
  const allWarnings = summaries.flatMap((s: any) => s.warnings || []);
  if (allWarnings.length > 0) {
    text += `\n${theme.fg("warning", `⚠ ${allWarnings.join("; ")}`)}`;
  }

  // Total usage
  const totalUsage = formatUsageStats(aggregateUsage(summaries as any[]));
  if (totalUsage) text += `\n${theme.fg("dim", `Total: ${totalUsage}`)}`;

  if (!options.expanded && !isLive) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

  return new Text(text, 0, 0);
}
