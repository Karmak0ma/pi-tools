/**
 * Subagent Inspector — TUI Mode Manager
 *
 * Provides the subagent inspector accessible via keyboard shortcuts or `/subagents`.
 * Uses ctx.ui.custom() in full-screen overlay mode with the new component-based
 * InspectorComponent architecture for stable, flicker-free rendering.
 *
 * Keyboard behavior:
 * - Ctrl+down: enter subagent inspector mode
 * - Ctrl+up: return to main view
 * - Left/Right: cycle between tabs
 * - Up/Down/PgUp/PgDn/Home/End: scroll transcript
 * - Escape: abort selected running subagent, or exit if completed
 */

import type { SubagentTracker, RuntimeSubagentInstance } from "./tracker.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubagentInspectorState {
  active: boolean;
  selectedIndex: number;
  scrollOffset: number;
}

// ─── Event channels ──────────────────────────────────────────────────────────

/** Event emitted when the subagent inspector opens or closes. */
export const INSPECTOR_VISIBILITY_CHANNEL = "subagent-inspector:visibility";

export interface InspectorVisibilityEvent {
  visible: boolean;
}

// ─── TUI Mode Manager ────────────────────────────────────────────────────────

/**
 * Manages the subagent inspector lifecycle.
 * Uses the InspectorComponent architecture for stable rendering.
 *
 * Key architectural decisions:
 * - No internal throttle layer — relies on pi-tui's 16ms minimum render interval
 * - Uses requestRender(force: true) on tab switches for clean full redraws
 * - Component caching via pi-tui's built-in AssistantMessageComponent/ToolExecutionComponent
 * - Dynamic import of InspectorComponent to avoid circular dependencies
 */
export class SubagentTuiManager {
  private tracker: SubagentTracker;
  private _active: boolean = false;
  private _available: boolean = true;
  private closeCallback: (() => void) | null = null;
  private tuiRef: any = null;
  private overlayHandle: any = null;
  private inspectorComponent: InstanceType<typeof import("./components/inspector.js").InspectorComponent> | null = null;

  constructor(tracker: SubagentTracker) {
    this.tracker = tracker;
  }

  get isActive(): boolean {
    return this._active;
  }

  get isAvailable(): boolean {
    return this._available;
  }

  /**
   * Check if TUI mode can be activated.
   * Returns false if:
   * - No instances in tracker
   * - Already active
   * - TUI API unavailable
   */
  canActivate(): boolean {
    if (!this._available) return false;
    if (this._active) return false;
    if (this.tracker.instances.size === 0) return false;
    return true;
  }

  /**
   * Enter subagent inspector mode using component architecture.
   * Requires ctx.ui.custom() API to be available.
   */
  async enter(ctx: any): Promise<void> {
    if (!this.canActivate()) return;

    if (!ctx?.ui?.custom) {
      this._available = false;
      return;
    }

    this._active = true;

    // Signal powerline-vflo compositor to yield scroll keys to the inspector
    (globalThis as any).__powerlineVflo_yieldScroll = true;

    // Select the most recent running task, or the last task
    const instances = this.tracker.getOrdered();
    const runningIdx = instances.findIndex((i) => i.status === "running");
    const initialIndex = runningIdx >= 0 ? runningIdx : Math.max(0, instances.length - 1);

    try {
      // Dynamic import to avoid circular dependencies
      const { InspectorComponent } = await import("./components/inspector.js");

      await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
        const manager = this;
        this.closeCallback = done;
        this.tuiRef = tui;

        const inspector = new InspectorComponent(
          this.tracker,
          tui,
          theme,
          {
            onClose: () => this.exit(),
            onAbort: (instance) => this.abortInstance(instance),
          },
        );
        inspector.setSelectedIndex(initialIndex);
        this.inspectorComponent = inspector;

        return {
          render: (width: number): string[] => {
            if (manager.overlayHandle && typeof manager.overlayHandle.isFocused === "function" && !manager.overlayHandle.isFocused()) {
              return [];
            }
            return inspector.render(width);
          },
          handleInput(data: string): void {
            inspector.handleInput(data);
          },
          invalidate(): void {
            inspector.invalidate();
          },
        };
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "top-left",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
        onHandle: (handle: any) => {
          this.overlayHandle = handle;
        },
      });
    } catch (err: any) {
      // If ctx.ui.custom throws, TUI mode is unavailable
      this._available = false;
    } finally {
      this._active = false;
      (globalThis as any).__powerlineVflo_yieldScroll = false;
      this.closeCallback = null;
      this.tuiRef = null;
      this.overlayHandle = null;
      this.inspectorComponent = null;
    }
  }

  /**
   * Exit subagent inspector mode.
   */
  exit(): void {
    if (!this._active) return;
    this._active = false;
    // Release scroll key ownership back to compositor
    (globalThis as any).__powerlineVflo_yieldScroll = false;
    if (this.closeCallback) {
      this.closeCallback();
      this.closeCallback = null;
    }
    this.tuiRef = null;
    this.overlayHandle = null;
    this.inspectorComponent = null;
  }

  /**
   * Request a re-render of the inspector.
   * No throttle layer — relies on pi-tui's built-in 16ms minimum interval.
   */
  requestRender(): void {
    if (!this._active || !this.tuiRef) return;
    this.tuiRef.requestRender();
  }

  /**
   * Abort a specific subagent instance.
   */
  private abortInstance(instance: RuntimeSubagentInstance): void {
    if (instance.status !== "running" || !instance.process) return;
    const proc = instance.process;
    proc.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (instance.process === proc && instance.status === "running") {
        proc.kill("SIGKILL");
      }
    }, 5000);
    proc.once("close", () => clearTimeout(timer));
  }

  /**
   * Get the current state (for testing).
   *
   * Note: `scrollOffset` is always 0 here — scroll state is encapsulated
   * within InspectorComponent and not exposed through this interface.
   * Use this for activation/selection state checks only.
   */
  getState(): SubagentInspectorState {
    return {
      active: this._active,
      selectedIndex: this.inspectorComponent?.getSelectedIndex() ?? 0,
      scrollOffset: 0,
    };
  }

  /**
   * Reset availability flag (for testing after fallback).
   */
  resetAvailability(): void {
    this._available = true;
  }
}
