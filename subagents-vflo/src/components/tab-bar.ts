/**
 * TabBarComponent — renders the horizontal tab list with status icons.
 *
 * Supports wrapping to max 2 lines and a sliding window algorithm
 * to ensure the selected tab is always visible.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

export class TabBarComponent implements Component {
  private instances: RuntimeSubagentInstance[] = [];
  private selectedIndex: number = 0;
  private theme: TuiTheme;
  private cachedLines: string[] | null = null;
  private cachedWidth: number = -1;

  constructor(theme: TuiTheme) {
    this.theme = theme;
  }

  setInstances(instances: RuntimeSubagentInstance[]): void {
    this.instances = instances;
    this.cachedLines = null;
  }

  setSelected(index: number): void {
    if (this.selectedIndex !== index) {
      this.selectedIndex = index;
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

    if (this.instances.length === 0) {
      this.cachedLines = [this.theme.fg("muted", " No subagents")];
      return this.cachedLines;
    }

    const separator = this.theme.fg("dim", " │ ");
    const separatorWidth = 3; // " │ "
    const maxLines = 2;

    // Build tab labels
    const tabs: Array<{ label: string; width: number }> = [];
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i];
      const icon = statusIcon(inst.status, this.theme);
      const name = inst.agent;
      const isSelected = i === this.selectedIndex;

      let label: string;
      if (isSelected) {
        label = this.theme.bg("selectedBg", ` ${icon} ${this.theme.fg("accent", this.theme.bold(name))} `);
      } else {
        label = ` ${icon} ${this.theme.fg("muted", name)} `;
      }
      tabs.push({ label, width: visibleWidth(label) });
    }

    // Try simple rendering first: all tabs left-to-right with wrap
    const lines: string[] = [];
    let currentLine = "";
    let currentLineWidth = 0;

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const needsSep = currentLineWidth > 0;
      const addedWidth = tab.width + (needsSep ? separatorWidth : 0);

      if (currentLineWidth + addedWidth > width && currentLineWidth > 0) {
        lines.push(truncateToWidth(currentLine, width));
        if (lines.length >= maxLines) break;
        currentLine = tab.label;
        currentLineWidth = tab.width;
      } else {
        currentLine = needsSep ? currentLine + separator + tab.label : tab.label;
        currentLineWidth += addedWidth;
      }
    }
    if (currentLine && lines.length < maxLines) {
      lines.push(truncateToWidth(currentLine, width));
    }

    // Check if selected tab is visible in rendered lines
    // If we have many tabs and the selected one was truncated (lines >= maxLines before we got to it),
    // use a sliding window centered around the selected tab
    const selectedTab = tabs[this.selectedIndex];
    const allRendered = lines.join("");
    if (selectedTab && !allRendered.includes(this.instances[this.selectedIndex].agent)) {
      // Sliding window: start from selected tab and expand outward
      return this.renderSlidingWindow(tabs, width, maxLines, separator, separatorWidth);
    }

    this.cachedLines = lines.length > 0 ? lines : [" "];
    return this.cachedLines;
  }

  private renderSlidingWindow(
    tabs: Array<{ label: string; width: number }>,
    width: number,
    maxLines: number,
    separator: string,
    separatorWidth: number,
  ): string[] {
    const ellipsis = this.theme.fg("dim", " …");
    const ellipsisWidth = 2;

    // Start from selected, expand left and right
    const selected = this.selectedIndex;
    let startIdx = selected;
    let endIdx = selected;

    // Calculate width of selected tab
    let usedWidth = tabs[selected].width;
    const maxWidth = width * maxLines; // Total available across lines

    // Expand window
    while (true) {
      let expanded = false;
      if (startIdx > 0) {
        const cost = tabs[startIdx - 1].width + separatorWidth;
        if (usedWidth + cost + ellipsisWidth * 2 <= maxWidth) {
          startIdx--;
          usedWidth += cost;
          expanded = true;
        }
      }
      if (endIdx < tabs.length - 1) {
        const cost = tabs[endIdx + 1].width + separatorWidth;
        if (usedWidth + cost + ellipsisWidth * 2 <= maxWidth) {
          endIdx++;
          usedWidth += cost;
          expanded = true;
        }
      }
      if (!expanded) break;
    }

    // Render the window
    const lines: string[] = [];
    let currentLine = startIdx > 0 ? ellipsis : "";
    let currentLineWidth = startIdx > 0 ? ellipsisWidth : 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const tab = tabs[i];
      const needsSep = currentLineWidth > 0;
      const addedWidth = tab.width + (needsSep ? separatorWidth : 0);

      if (currentLineWidth + addedWidth > width && currentLineWidth > 0) {
        lines.push(truncateToWidth(currentLine, width));
        if (lines.length >= maxLines) break;
        currentLine = tab.label;
        currentLineWidth = tab.width;
      } else {
        currentLine = needsSep ? currentLine + separator + tab.label : tab.label;
        currentLineWidth += addedWidth;
      }
    }
    if (currentLine && lines.length < maxLines) {
      if (endIdx < tabs.length - 1) {
        currentLine += ellipsis;
      }
      lines.push(truncateToWidth(currentLine, width));
    }

    this.cachedLines = lines.length > 0 ? lines : [" "];
    return this.cachedLines;
  }
}
