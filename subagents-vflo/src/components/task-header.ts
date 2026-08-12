/**
 * TaskHeaderComponent — renders the pinned task metadata section.
 *
 * Shows: agent name + status, model, cwd, thinking effort, tools, warnings, task prompt.
 * Uses UserMessageComponent for the task prompt to achieve parity with main UI.
 * Variable height (parity-first) — renders at natural height, no artificial cap.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { UserMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { RuntimeSubagentInstance } from "../tracker.js";
import type { TuiTheme } from "./types.js";
import type { TaskStatus } from "../types.js";

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
  private taskComponent: UserMessageComponent | null = null;
  private cachedLines: string[] | null = null;
  private cachedWidth: number = -1;
  private lastInstanceId: string | null = null;
  private lastStatus: TaskStatus | null = null;
  private lastModel: string | undefined = undefined;
  private lastCwd: string = "";
  private lastWarningsKey: string = "";

  constructor(theme: TuiTheme) {
    this.theme = theme;
  }

  setInstance(instance: RuntimeSubagentInstance | null): void {
    if (!instance) {
      this.instance = null;
      this.taskComponent = null;
      this.cachedLines = null;
      this.lastInstanceId = null;
      this.lastStatus = null;
      this.lastModel = undefined;
      this.lastCwd = "";
      this.lastWarningsKey = "";
      return;
    }

    const warningsKey = instance.warnings.join("|");

    if (instance.id !== this.lastInstanceId) {
      // New instance — full rebuild
      this.instance = instance;
      this.lastInstanceId = instance.id;
      this.lastStatus = instance.status;
      this.lastModel = instance.model;
      this.lastCwd = instance.cwd;
      this.lastWarningsKey = warningsKey;
      this.taskComponent = new UserMessageComponent(instance.task, getMarkdownTheme());
      this.cachedLines = null;
    } else if (
      instance.status !== this.lastStatus ||
      instance.model !== this.lastModel ||
      instance.cwd !== this.lastCwd ||
      warningsKey !== this.lastWarningsKey
    ) {
      // Same instance, but rendered fields changed
      this.instance = instance;
      this.lastStatus = instance.status;
      this.lastModel = instance.model;
      this.lastCwd = instance.cwd;
      this.lastWarningsKey = warningsKey;
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

    // Warnings
    for (const w of inst.warnings.slice(0, 3)) {
      lines.push(truncateToWidth(this.theme.fg("warning", ` ⚠ ${w}`), width));
    }

    lines.push(""); // Spacer before task

    // Task prompt — rendered via UserMessageComponent for parity
    if (this.taskComponent) {
      const taskLines = this.taskComponent.render(Math.max(1, width - 2));
      for (const tl of taskLines) {
        lines.push("  " + tl);
      }
    }

    lines.push(""); // Spacer after task

    this.cachedLines = lines;
    return this.cachedLines;
  }
}
