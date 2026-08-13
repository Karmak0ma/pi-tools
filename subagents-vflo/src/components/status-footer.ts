/**
 * StatusFooterComponent — renders the footer with status and keyboard hints.
 *
 * Always renders exactly 3 lines: divider, status, hints.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { TuiTheme } from "./types.js";

export interface FooterMetrics {
  total: number;
  running: number;
  completed: number;
  errored: number;
  scrollOffset: number;
  maxScroll: number;
  selectedRunning: boolean;
  messageMode: boolean;
}

export class StatusFooterComponent implements Component {
  private theme: TuiTheme;
  private metrics: FooterMetrics = {
    total: 0,
    running: 0,
    completed: 0,
    errored: 0,
    scrollOffset: 0,
    maxScroll: 0,
    selectedRunning: false,
    messageMode: false,
  };
  private cachedLines: string[] | null = null;
  private cachedWidth: number = -1;

  constructor(theme: TuiTheme) {
    this.theme = theme;
  }

  update(metrics: FooterMetrics): void {
    // Only invalidate if something actually changed
    const m = this.metrics;
    if (
      m.total !== metrics.total ||
      m.running !== metrics.running ||
      m.completed !== metrics.completed ||
      m.errored !== metrics.errored ||
      m.scrollOffset !== metrics.scrollOffset ||
      m.maxScroll !== metrics.maxScroll ||
      m.selectedRunning !== metrics.selectedRunning ||
      m.messageMode !== metrics.messageMode
    ) {
      this.metrics = { ...metrics };
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

    const safeWidth = Math.max(10, width);
    const lines: string[] = [];

    // Line 1: Divider
    lines.push(this.theme.fg("dim", " " + "─".repeat(Math.min(safeWidth - 2, 60))));

    // Line 2: Status
    const statusParts: string[] = [];
    if (this.metrics.total > 0) {
      statusParts.push(`${this.metrics.total} tasks`);
      if (this.metrics.running > 0) statusParts.push(this.theme.fg("warning", `${this.metrics.running} running`));
      if (this.metrics.completed > 0) statusParts.push(this.theme.fg("success", `${this.metrics.completed} done`));
      if (this.metrics.errored > 0) statusParts.push(this.theme.fg("error", `${this.metrics.errored} failed`));
    }
    statusParts.push(
      this.metrics.maxScroll > 0
        ? `scroll ${this.metrics.scrollOffset}/${this.metrics.maxScroll}`
        : "scroll top",
    );
    lines.push(truncateToWidth(this.theme.fg("dim", " " + statusParts.join("  •  ")), safeWidth));

    // Line 3: Keyboard hints
    const hints: string[] = [];
    hints.push("←/→ switch");
    if (this.metrics.messageMode) {
      hints.push("Enter steer");
      hints.push("Esc cancel input");
    } else {
      hints.push("t talk");
      hints.push(this.metrics.selectedRunning ? "x abort" : "x close");
    }
    hints.push("↑/↓ scroll");
    hints.push("PgUp/PgDn page");
    lines.push(truncateToWidth(this.theme.fg("muted", " " + hints.join("  │  ")), safeWidth));

    this.cachedLines = lines;
    return this.cachedLines;
  }
}
