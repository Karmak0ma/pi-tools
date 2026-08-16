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
 * - Ctrl+O: toggle tool output expansion
 * - Left/Right: cycle between tabs
 * - Up/Down/PgUp/PgDn/Home/End: scroll transcript
 * - t: enter message mode; Enter steers the active subagent
 * - x: abort selected running subagent, or exit if completed
 * - Escape: cancel message entry only
 */

import { isKeyRelease } from "@earendil-works/pi-tui";
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

// pi-tui keeps input listeners in a Set and dispatches them before the focused
// component. In fullscreen mode, TuiAltScreen's built-in viewport listener
// consumes PgUp/PgDn, so the inspector must be placed ahead of that listener.
// Keep this local rather than depending on a private pi-tui type.
type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

function prioritizeInputListener(tui: any, listener: InputListener): void {
  if (tui?.mode !== "fullscreen") return;

  const listeners = tui.inputListeners;
  if (!(listeners instanceof Set) || !listeners.delete(listener)) return;

  const existingListeners = [...listeners];
  listeners.clear();
  listeners.add(listener);
  for (const existingListener of existingListeners) listeners.add(existingListener);
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
  private removePageNavigationListener: (() => void) | null = null;
  private readonly abortHandler?: (instance: RuntimeSubagentInstance) => void;

  constructor(
    tracker: SubagentTracker,
    abortHandler?: (instance: RuntimeSubagentInstance) => void,
  ) {
    this.tracker = tracker;
    this.abortHandler = abortHandler;
  }

  get isActive(): boolean {
    return this._active;
  }

  get isAvailable(): boolean {
    return this._available;
  }

  /** Whether a temporary parent dialog may safely return focus to the inspector. */
  get isOverlayFocusedVisible(): boolean {
    if (!this._active || !this.overlayHandle) return false;
    if (typeof this.overlayHandle.isFocused !== "function") return false;
    return !!this.overlayHandle.isFocused();
  }

  /**
   * Route abort through the extension-level helper so a waiting child dialog
   * is cancelled before the child process receives SIGTERM.
   */
  abort(instance: RuntimeSubagentInstance): void {
    this.abortInstance(instance);
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
            onMessage: (instance, text) => this.sendMessage(instance, text),
          },
          _keybindings,
          {
            getToolsExpanded: () => ctx.ui.getToolsExpanded(),
            setToolsExpanded: (expanded) => ctx.ui.setToolsExpanded(expanded),
          },
        );
        inspector.setSelectedIndex(initialIndex);
        this.inspectorComponent = inspector;

        // TuiAltScreen handles PgUp/PgDn in an input listener registered by
        // the host before it dispatches to the focused overlay. Register a
        // higher-priority listener so those keys scroll this inspector rather
        // than the main transcript. Arrow keys do not need this detour because
        // the host viewport listener does not consume them.
        this.clearPageNavigationListener();
        const pageNavigationListener: InputListener = (data) => {
          if (
            manager.overlayHandle &&
            typeof manager.overlayHandle.isFocused === "function" &&
            !manager.overlayHandle.isFocused()
          ) {
            return;
          }
          if (!inspector.isPageNavigationInput(data)) return;

          // Input listeners run before TuiBase filters Kitty key-release
          // events for focused components. Consume releases without scrolling
          // so a press/release pair cannot move two pages.
          if (!isKeyRelease(data)) inspector.handleInput(data);
          return { consume: true };
        };
        if (typeof tui.addInputListener === "function") {
          this.removePageNavigationListener = tui.addInputListener(pageNavigationListener);
          prioritizeInputListener(tui, pageNavigationListener);
        }

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
      this.clearPageNavigationListener();
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
    this.clearPageNavigationListener();
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

  private clearPageNavigationListener(): void {
    this.removePageNavigationListener?.();
    this.removePageNavigationListener = null;
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
   * Send a steering message to a selected active child session.
   */
  private async sendMessage(
    instance: RuntimeSubagentInstance,
    text: string,
  ): Promise<void> {
    if (instance.status !== "running" || !instance.control || !instance.process || instance.process.exitCode !== null) {
      instance.summary.errorMessage = "Subagent process is no longer available";
      instance.status = "error";
      instance.summary.status = "error";
      this.requestRender();
      return;
    }

    instance.summary.errorMessage = undefined;
    instance.summary.isPartial = true;
    this.requestRender();

    try {
      await instance.control.sendMessage(text, "steer");
    } catch (error) {
      instance.status = "error";
      instance.summary.status = "error";
      instance.summary.isPartial = false;
      instance.summary.errorMessage = error instanceof Error ? error.message : String(error);
      this.requestRender();
    }
  }

  /** Abort a specific subagent instance. */
  private abortInstance(instance: RuntimeSubagentInstance): void {
    if (instance.status !== "running" || !instance.control) return;
    if (this.abortHandler) {
      this.abortHandler(instance);
      return;
    }
    instance.control.abort();
    instance.status = "aborted";
    instance.summary.status = "aborted";
    instance.summary.isPartial = false;
    this.requestRender();
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
