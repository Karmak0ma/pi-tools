/**
 * InspectorComponent — top-level component for the subagent inspector overlay.
 *
 * Architecture:
 * - Renders header, tab bar, divider, task header, transcript viewport, footer
 * - Uses standard pi-coding-agent components (AssistantMessageComponent, ToolExecutionComponent)
 * - Event processing pipeline creates/updates components from child process events
 * - Virtual scroll via TranscriptViewport
 * - Force full redraw on tab switch via tui.requestRender(true)
 * - No frameMarker — output stability guaranteed by component caching
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { RuntimeSubagentInstance } from "../tracker.js";
import type { SubagentTracker } from "../tracker.js";
import type { TuiTheme } from "./types.js";
import { TabBarComponent } from "./tab-bar.js";
import { TaskHeaderComponent } from "./task-header.js";
import { StatusFooterComponent } from "./status-footer.js";
import { TranscriptViewport } from "./transcript-viewport.js";
import { FallbackTextComponent } from "./fallback-text.js";
import { formatUsageStats } from "../render.js";

// ─── Per-Tab State ───────────────────────────────────────────────────────────

interface TabState {
  components: Component[];
  lastProcessedEventIndex: number;
  activeAssistantMessage: AssistantMessageComponent | null;
  activeToolExecutions: Map<string, ToolExecutionComponent>;
  dirty: boolean;
  finalized: boolean;
}

function createTabState(): TabState {
  return {
    components: [],
    lastProcessedEventIndex: 0,
    activeAssistantMessage: null,
    activeToolExecutions: new Map(),
    dirty: true,
    finalized: false,
  };
}

// ─── Event Processing ────────────────────────────────────────────────────────

function processNewEvents(
  instance: RuntimeSubagentInstance,
  tab: TabState,
  tui: TUI,
  cwd: string,
  theme: TuiTheme,
): void {
  if (tab.finalized) return;

  const events = instance.events;
  for (let i = tab.lastProcessedEventIndex; i < events.length; i++) {
    const event = events[i];
    try {
      switch (event.type) {
        case "message_start": {
          // Create new AssistantMessageComponent
          const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
          tab.activeAssistantMessage = component;
          tab.components.push(component);
          tab.dirty = true;
          break;
        }

        case "message_update": {
          // Update active assistant message with partial
          if (event.assistantMessageEvent?.partial && tab.activeAssistantMessage) {
            tab.activeAssistantMessage.updateContent(event.assistantMessageEvent.partial);
            tab.dirty = true;
          }
          break;
        }

        case "message_end": {
          // Finalize assistant message
          const msg = event.message;
          if (msg?.role === "assistant") {
            // Check if message has visible text content (not just tool calls)
            const hasVisibleContent =
              Array.isArray(msg.content) &&
              msg.content.some((p: any) =>
                p && (
                  (p.type === "text" && p.text) ||
                  (p.type === "thinking" && p.thinking)
                ),
              );

            if (tab.activeAssistantMessage) {
              if (hasVisibleContent) {
                tab.activeAssistantMessage.updateContent(msg);
              } else {
                // Remove empty assistant component (tool-call-only message)
                const idx = tab.components.indexOf(tab.activeAssistantMessage);
                if (idx >= 0) tab.components.splice(idx, 1);
              }
              tab.activeAssistantMessage = null;
            } else if (hasVisibleContent) {
              // Fallback: message_start was missed, but we have visible content
              const component = new AssistantMessageComponent(msg, false, getMarkdownTheme());
              tab.components.push(component);
            }

            // Create ToolExecutionComponents for each tool call
            if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part?.type === "toolCall") {
                  const toolCallId = part.toolCallId || part.id || `unknown-${Date.now()}`;
                  try {
                    const toolComp = new ToolExecutionComponent(
                      part.name,
                      toolCallId,
                      part.arguments || {},
                      { showImages: false },
                      undefined,
                      tui,
                      cwd,
                    );
                    toolComp.setArgsComplete();
                    tab.activeToolExecutions.set(toolCallId, toolComp);
                    tab.components.push(toolComp);
                  } catch (err) {
                    tab.components.push(new FallbackTextComponent([
                      theme.fg("error", `  ⚠ Failed to create tool component: ${part.name}`),
                    ]));
                  }
                }
              }
            }
            tab.dirty = true;
          }
          break;
        }

        case "tool_execution_start": {
          const toolCallId = event.toolCallId;
          if (toolCallId && tab.activeToolExecutions.has(toolCallId)) {
            tab.activeToolExecutions.get(toolCallId)!.markExecutionStarted();
            tab.dirty = true;
          } else if (toolCallId) {
            // Late-arriving tool event — create component
            try {
              const toolComp = new ToolExecutionComponent(
                event.toolName || "unknown",
                toolCallId,
                event.args || {},
                { showImages: false },
                undefined,
                tui,
                cwd,
              );
              toolComp.setArgsComplete();
              toolComp.markExecutionStarted();
              tab.activeToolExecutions.set(toolCallId, toolComp);
              tab.components.push(toolComp);
              tab.dirty = true;
            } catch (err) {
              tab.components.push(new FallbackTextComponent([
                theme.fg("error", `  ⚠ Failed to create tool: ${event.toolName}`),
              ]));
              tab.dirty = true;
            }
          }
          break;
        }

        case "tool_execution_update": {
          const toolCallId = event.toolCallId;
          if (toolCallId && tab.activeToolExecutions.has(toolCallId)) {
            const comp = tab.activeToolExecutions.get(toolCallId)!;
            if (event.partialResult) {
              comp.updateResult(event.partialResult, true);
              tab.dirty = true;
            }
          } else if (toolCallId && event.partialResult) {
            // Late-arriving update — create component on the fly
            try {
              const toolComp = new ToolExecutionComponent(
                event.toolName || "unknown",
                toolCallId,
                event.args || {},
                { showImages: false },
                undefined,
                tui,
                cwd,
              );
              toolComp.setArgsComplete();
              toolComp.markExecutionStarted();
              toolComp.updateResult(event.partialResult, true);
              tab.activeToolExecutions.set(toolCallId, toolComp);
              tab.components.push(toolComp);
              tab.dirty = true;
            } catch (err) {
              // Silently ignore — best effort for late events
            }
          }
          break;
        }

        case "tool_execution_end": {
          const toolCallId = event.toolCallId;
          if (toolCallId && tab.activeToolExecutions.has(toolCallId)) {
            const comp = tab.activeToolExecutions.get(toolCallId)!;
            if (event.result) {
              comp.updateResult(event.result, false);
            }
            tab.activeToolExecutions.delete(toolCallId);
            tab.dirty = true;
          } else if (toolCallId && event.result) {
            // Late-arriving end — create component with final result
            try {
              const toolComp = new ToolExecutionComponent(
                event.toolName || "unknown",
                toolCallId,
                event.args || {},
                { showImages: false },
                undefined,
                tui,
                cwd,
              );
              toolComp.setArgsComplete();
              toolComp.markExecutionStarted();
              toolComp.updateResult(event.result, false);
              tab.components.push(toolComp);
              tab.dirty = true;
            } catch (err) {
              tab.components.push(new FallbackTextComponent([
                theme.fg("error", `  ⚠ Failed to render tool result: ${event.toolName || "unknown"}`),
              ]));
              tab.dirty = true;
            }
          }
          break;
        }

        case "tool_result_end": {
          // Fallback: only if tool_execution_end didn't already finalize
          const toolCallId = event.toolCallId || event.message?.toolCallId;
          if (toolCallId && tab.activeToolExecutions.has(toolCallId)) {
            const comp = tab.activeToolExecutions.get(toolCallId)!;
            const msg = event.message;
            if (msg && Array.isArray(msg.content)) {
              comp.updateResult({
                content: msg.content,
                details: msg.details,
                isError: !!msg.isError,
              }, false);
            }
            tab.activeToolExecutions.delete(toolCallId);
            tab.dirty = true;
          }
          break;
        }
      }
    } catch (err) {
      // Error resilience: never crash on malformed events
      tab.components.push(new FallbackTextComponent([
        theme.fg("error", `  ⚠ Event processing error: ${String(err)}`),
      ]));
      tab.dirty = true;
    }
  }

  tab.lastProcessedEventIndex = events.length;

  // Mark finalized if instance is done
  if (instance.status !== "running" && instance.status !== "queued") {
    tab.finalized = true;
  }
}

// ─── StderrComponent ─────────────────────────────────────────────────────────

class StderrComponent implements Component {
  private stderr: string;
  private theme: TuiTheme;
  private cachedLines: string[] | null = null;
  private cachedWidth: number = -1;

  constructor(stderr: string, theme: TuiTheme) {
    this.stderr = stderr;
    this.theme = theme;
  }

  setStderr(stderr: string): void {
    if (stderr !== this.stderr) {
      this.stderr = stderr;
      this.cachedLines = null;
    }
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;

    if (!this.stderr) {
      this.cachedLines = [];
      return this.cachedLines;
    }

    const lines: string[] = [];
    lines.push(this.theme.fg("error", "  ⚠ stderr:"));
    const stderrLines = this.stderr.split("\n").slice(0, 5);
    for (const sl of stderrLines) {
      lines.push("    " + this.theme.fg("error", truncateToWidth(sl, Math.max(1, width - 8))));
    }
    const totalLines = this.stderr.split("\n").length;
    if (totalLines > 5) {
      lines.push(this.theme.fg("dim", `    ... (${totalLines - 5} more lines)`));
    }
    lines.push("");

    this.cachedLines = lines;
    return this.cachedLines;
  }
}

// ─── Empty State / Waiting Component ─────────────────────────────────────────

class PlaceholderComponent implements Component {
  private text: string;
  private theme: TuiTheme;

  constructor(text: string, theme: TuiTheme) {
    this.text = text;
    this.theme = theme;
  }

  render(_width: number): string[] {
    return [this.theme.fg("muted", `  ${this.text}`)];
  }

  invalidate(): void {}
}

// ─── Inspector Component ─────────────────────────────────────────────────────

export interface InspectorCallbacks {
  onClose: () => void;
  onAbort: (instance: RuntimeSubagentInstance) => void;
}

export class InspectorComponent {
  private tracker: SubagentTracker;
  private tui: TUI;
  private theme: TuiTheme;
  private callbacks: InspectorCallbacks;

  // Sub-components
  private tabBar: TabBarComponent;
  private taskHeader: TaskHeaderComponent;
  private footer: StatusFooterComponent;
  private viewport: TranscriptViewport;

  // State
  private selectedIndex: number = 0;
  private tabStates: Map<string, TabState> = new Map();
  private stderrComponents: Map<string, StderrComponent> = new Map();
  private lastTranscriptComponents: Component[] | null = null;

  constructor(
    tracker: SubagentTracker,
    tui: TUI,
    theme: TuiTheme,
    callbacks: InspectorCallbacks,
  ) {
    this.tracker = tracker;
    this.tui = tui;
    this.theme = theme;
    this.callbacks = callbacks;

    this.tabBar = new TabBarComponent(theme);
    this.taskHeader = new TaskHeaderComponent(theme);
    this.footer = new StatusFooterComponent(theme);
    this.viewport = new TranscriptViewport();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Set selected tab index. */
  setSelectedIndex(index: number): void {
    this.selectedIndex = index;
  }

  /** Get selected tab index. */
  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  // ─── Component Interface ─────────────────────────────────────────────────

  render(width: number): string[] {
    // Use tui.terminal.rows (respects compositor cluster height) instead of process.stdout.rows
    const termHeight = this.tui?.terminal?.rows || process.stdout.rows || 24;
    const lines: string[] = [];

    const instances = this.tracker.getOrdered();

    // Clamp selected index
    if (instances.length > 0) {
      if (this.selectedIndex >= instances.length) this.selectedIndex = instances.length - 1;
      if (this.selectedIndex < 0) this.selectedIndex = 0;
    }

    const selectedInstance = instances.length > 0 ? instances[this.selectedIndex] : undefined;

    // Header (2 lines)
    lines.push(this.theme.fg("accent", this.theme.bold(" ◆ Subagent Inspector")));
    lines.push(this.theme.fg("dim", " " + "═".repeat(Math.min(Math.max(1, width - 2), 60))));

    // Tab bar
    this.tabBar.setInstances(instances);
    this.tabBar.setSelected(this.selectedIndex);
    lines.push(...this.tabBar.render(width));

    // Divider
    lines.push(this.theme.fg("dim", " " + "─".repeat(Math.min(Math.max(1, width - 2), 60))));

    // Task header
    this.taskHeader.setInstance(selectedInstance || null);
    lines.push(...this.taskHeader.render(width));

    // Footer height is always 3
    const footerHeight = 3;
    const usedHeight = lines.length + footerHeight;
    const viewportHeight = Math.max(3, termHeight - usedHeight);

    // Process events and build transcript for selected instance
    if (selectedInstance) {
      const tab = this.getTabState(selectedInstance);

      // Only rebuild the component list if tab state changed
      if (tab.dirty || !this.lastTranscriptComponents) {
        const transcriptComponents: Component[] = [...tab.components];

        // Add stderr component if present
        if (selectedInstance.stderr) {
          let stderrComp = this.stderrComponents.get(selectedInstance.id);
          if (!stderrComp) {
            stderrComp = new StderrComponent(selectedInstance.stderr, this.theme);
            this.stderrComponents.set(selectedInstance.id, stderrComp);
          } else {
            stderrComp.setStderr(selectedInstance.stderr);
          }
          transcriptComponents.push(stderrComp);
        }

        // Add usage/error summary at end for completed instances
        if (selectedInstance.status !== "running" && selectedInstance.status !== "queued") {
          const usageLine = formatUsageStats(selectedInstance.summary.usage, selectedInstance.summary.model);
          const summaryLines: string[] = [];
          if (usageLine) {
            summaryLines.push(this.theme.fg("dim", "  " + "─".repeat(Math.min(Math.max(1, width - 6), 40))));
            summaryLines.push(this.theme.fg("dim", `  ${usageLine}`));
          }
          if (selectedInstance.summary.errorMessage) {
            summaryLines.push(this.theme.fg("error", `  ✗ Error: ${selectedInstance.summary.errorMessage}`));
          }
          if (summaryLines.length > 0) {
            transcriptComponents.push(new FallbackTextComponent(summaryLines));
          }
        }

        // Add placeholder if no components yet
        if (transcriptComponents.length === 0) {
          if (selectedInstance.status === "queued") {
            transcriptComponents.push(new PlaceholderComponent("○ queued — waiting to start", this.theme));
          } else if (selectedInstance.status === "running") {
            transcriptComponents.push(new PlaceholderComponent("⏳ waiting for output...", this.theme));
          } else {
            transcriptComponents.push(new PlaceholderComponent("(no output)", this.theme));
          }
        }

        this.lastTranscriptComponents = transcriptComponents;
        this.viewport.setChildren(transcriptComponents);
        // Force viewport rebuild — component content may have changed even if
        // child identities haven't (e.g. streaming updates to AssistantMessageComponent)
        this.viewport.markDirty();
        tab.dirty = false;
      }
    } else {
      if (!this.lastTranscriptComponents || this.lastTranscriptComponents.length !== 1) {
        const placeholder = [new PlaceholderComponent("(no task selected)", this.theme)];
        this.lastTranscriptComponents = placeholder;
        this.viewport.setChildren(placeholder);
      }
    }

    // Transcript viewport (fills remaining space)
    lines.push(...this.viewport.getVisibleLines(width, viewportHeight));

    // Footer
    this.footer.update({
      total: instances.length,
      running: instances.filter((i) => i.status === "running").length,
      completed: instances.filter((i) => i.status === "completed").length,
      errored: instances.filter((i) => i.status === "error").length,
      scrollOffset: this.viewport.scrollOffset,
      maxScroll: this.viewport.getMaxScroll(),
      selectedRunning: selectedInstance?.status === "running",
    });
    lines.push(...this.footer.render(width));

    // Pad to terminal height
    while (lines.length < termHeight) {
      lines.push("");
    }

    // Truncate to terminal height and width — belt and suspenders
    return lines.slice(0, termHeight).map((l) => truncateToWidth(l, width));
  }

  handleInput(data: string): void {
    const instances = this.tracker.getOrdered();

    if (matchesKey(data, "escape")) {
      const selected = instances[this.selectedIndex];
      if (selected?.status === "running") {
        this.callbacks.onAbort(selected);
      } else {
        this.callbacks.onClose();
      }
      return;
    }

    if (matchesKey(data, "ctrl+up")) {
      this.callbacks.onClose();
      return;
    }

    if (matchesKey(data, "left")) {
      if (instances.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + instances.length) % instances.length;
        this.viewport.pinToBottom();
        this.viewport.markDirty();
        this.lastTranscriptComponents = null; // Force rebuild for new tab
        this.tui.requestRender(true); // Force full redraw on tab switch
      }
      return;
    }

    if (matchesKey(data, "right")) {
      if (instances.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % instances.length;
        this.viewport.pinToBottom();
        this.viewport.markDirty();
        this.lastTranscriptComponents = null; // Force rebuild for new tab
        this.tui.requestRender(true); // Force full redraw on tab switch
      }
      return;
    }

    if (matchesKey(data, "up")) {
      this.viewport.scrollBy(-1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.viewport.scrollBy(1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "pageup" as any)) {
      this.viewport.scrollBy(-this.viewport.pageSize);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "pagedown" as any)) {
      this.viewport.scrollBy(this.viewport.pageSize);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      this.viewport.setScrollOffset(0);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      this.viewport.setScrollOffset(Infinity);
      this.tui.requestRender();
      return;
    }
  }

  invalidate(): void {
    this.tabBar.invalidate();
    this.taskHeader.invalidate();
    this.footer.invalidate();
    this.viewport.markDirty();
    this.lastTranscriptComponents = null;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private getTabState(instance: RuntimeSubagentInstance): TabState {
    let tab = this.tabStates.get(instance.id);
    if (!tab) {
      tab = createTabState();
      this.tabStates.set(instance.id, tab);
    }
    if (!tab.finalized) {
      processNewEvents(instance, tab, this.tui, instance.cwd, this.theme);
    }
    return tab;
  }
}
