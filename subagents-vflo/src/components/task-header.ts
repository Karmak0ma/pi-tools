/**
 * TaskHeaderComponent — renders the pinned task metadata section.
 *
 * Shows: agent name + status, model, cwd, thinking effort, tools, live token/context usage, and warnings.
 * The initial task is intentionally not rendered here: it is already the first
 * user message in the transcript, and repeating it in this pinned area would
 * let a large prompt consume the entire activity viewport.
 * Variable height (parity-first) — renders at natural height, no artificial cap.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { RuntimeSubagentInstance } from "../tracker.js";
import type { TuiTheme } from "./types.js";
import type { TaskStatus } from "../types.js";

/**
 * Keep the lazy-loaded inspector header self-contained. Importing this helper
 * from the tool-row renderer made the overlay depend on a named export that
 * is not guaranteed to exist in pi's runtime module loader.
 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function statusIcon(status: TaskStatus, theme: TuiTheme): string {
  switch (status) {
    case "queued":
      return theme.fg("dim", "○");
    case "running":
      return theme.fg("warning", "⏳");
    case "completed":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "aborted":
      return theme.fg("warning", "⊘");
    default:
      return theme.fg("dim", "?");
  }
}

export class TaskHeaderComponent implements Component {
  private instance: RuntimeSubagentInstance | null = null;
  private theme: TuiTheme;
  private cachedLines: string[] | null = null;
  private cachedWidth: number = -1;
  private lastInstanceId: string | null = null;
  private lastStatus: TaskStatus | null = null;
  private lastModel: string | undefined = undefined;
  private lastCwd: string = "";
  private lastWarningsKey: string = "";
  private lastUsageKey: string = "";
  private lastPendingUIRequestCount = 0;

  constructor(theme: TuiTheme) {
    this.theme = theme;
  }

  setInstance(instance: RuntimeSubagentInstance | null): void {
    if (!instance) {
      this.instance = null;
      this.cachedLines = null;
      this.lastInstanceId = null;
      this.lastStatus = null;
      this.lastModel = undefined;
      this.lastCwd = "";
      this.lastWarningsKey = "";
      this.lastUsageKey = "";
      this.lastPendingUIRequestCount = 0;
      return;
    }

    const warningsKey = instance.warnings.join("|");
    const usage = instance.summary.usage;
    const usageKey = [
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.contextTokens,
      instance.contextWindow ?? "",
    ].join("|");

    if (instance.id !== this.lastInstanceId) {
      // New instance — full rebuild
      this.instance = instance;
      this.lastInstanceId = instance.id;
      this.lastStatus = instance.status;
      this.lastModel = instance.model;
      this.lastCwd = instance.cwd;
      this.lastWarningsKey = warningsKey;
      this.lastUsageKey = usageKey;
      this.lastPendingUIRequestCount = instance.pendingUIRequestCount;
      this.cachedLines = null;
    } else if (
      instance.status !== this.lastStatus ||
      instance.model !== this.lastModel ||
      instance.cwd !== this.lastCwd ||
      warningsKey !== this.lastWarningsKey ||
      usageKey !== this.lastUsageKey ||
      instance.pendingUIRequestCount !== this.lastPendingUIRequestCount
    ) {
      // Same instance, but rendered fields changed
      this.instance = instance;
      this.lastStatus = instance.status;
      this.lastModel = instance.model;
      this.lastCwd = instance.cwd;
      this.lastWarningsKey = warningsKey;
      this.lastUsageKey = usageKey;
      this.lastPendingUIRequestCount = instance.pendingUIRequestCount;
      this.cachedLines = null;
    }
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedWidth = width;

    if (!this.instance) {
      this.cachedLines = [this.theme.fg("muted", " (no task selected)")];
      return this.cachedLines;
    }

    const inst = this.instance;
    const lines: string[] = [];

    // Agent name + status icon
    lines.push(truncateToWidth(
      this.theme.fg("accent", this.theme.bold(` ${inst.agent}`)) + " " + statusIcon(inst.status, this.theme),
      width,
    ));
    if (inst.pendingUIRequestCount > 0) {
      lines.push(truncateToWidth(
        this.theme.fg("warning", `  ⏸ waiting for input (${inst.pendingUIRequestCount})`),
        width,
      ));
    }

    // Metadata
    if (inst.model) {
      lines.push(truncateToWidth(this.theme.fg("dim", `  model: ${inst.model}`), width));
    }
    if (inst.cwd) {
      lines.push(truncateToWidth(this.theme.fg("dim", `  cwd: ${inst.cwd}`), width));
    }
    lines.push(truncateToWidth(
      this.theme.fg("dim", `  thinking: ${inst.thinking ?? "default"}`),
      width,
    ));
    if (inst.tools.length > 0) {
      lines.push(truncateToWidth(
        this.theme.fg("dim", `  tools: ${inst.tools.join(", ")}`),
        width,
      ));
    }

    // Usage is kept in the pinned header so it remains visible while the
    // transcript is scrolled. Cache reads and writes are intentionally shown
    // as one total because the request is interested in cached token volume,
    // not billing-category detail.
    const usage = inst.summary.usage;
    const cachedTokens = usage.cacheRead + usage.cacheWrite;
    lines.push(truncateToWidth(
      this.theme.fg(
        "dim",
        `  tokens: input ${formatTokens(usage.input)}  output ${formatTokens(usage.output)}  cached ${formatTokens(cachedTokens)}`,
      ),
      width,
    ));

    if (inst.contextWindow && inst.contextWindow > 0) {
      const contextPercent = (usage.contextTokens / inst.contextWindow) * 100;
      const contextColor = contextPercent > 90
        ? "error"
        : contextPercent > 70
          ? "warning"
          : "dim";
      lines.push(truncateToWidth(
        this.theme.fg(
          contextColor,
          `  context: ${formatTokens(usage.contextTokens)} / ${formatTokens(inst.contextWindow)} (${contextPercent.toFixed(1)}%)`,
        ),
        width,
      ));
    } else {
      // A queued task can be visible before model resolution finishes.
      lines.push(truncateToWidth(
        this.theme.fg("dim", `  context: ${formatTokens(usage.contextTokens)} / ?`),
        width,
      ));
    }

    // Warnings
    for (const w of inst.warnings.slice(0, 3)) {
      lines.push(truncateToWidth(this.theme.fg("warning", ` ⚠ ${w}`), width));
    }

    this.cachedLines = lines;
    return this.cachedLines;
  }
}
