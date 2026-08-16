import type {
  ExtensionAPI,
  ExtensionContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  collectToolComponents,
  findToolAt,
} from "./hit-test.js";
import {
  isUnmodifiedPrimaryPress,
  parseSgrMouseEvent,
} from "./mouse.js";
import { prioritizeInputListener } from "./input-priority.js";
import {
  clearExpansionState,
  createExpansionState,
  reconcileExpansionState,
  toggleToolExpansion,
  type ExpansionState,
} from "./state.js";

const HOOK_WIDGET_KEY = "tool-expansion-vflo-input-hook";

interface Runtime {
  ctx: ExtensionContext;
  state: ExpansionState;
  tui?: TUI;
  unsubscribeInput?: () => void;
  inputHandler: TerminalInputHandler;
  inputPriorityReady: boolean;
  compatibilityWarningShown: boolean;
  enabled: boolean;
  disposed: boolean;
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Private TUI compatibility work must never become an extension crash.
  }
}

function readGlobalExpanded(runtime: Runtime): boolean {
  try {
    return runtime.ctx.ui.getToolsExpanded();
  } catch {
    // Keep the last known value if a non-interactive/mock UI is incomplete.
    return runtime.state.globalExpanded;
  }
}

function currentLayout(tui: TUI): unknown {
  try {
    // `currentLayout` is intentionally private in pi-tui. Do not import its
    // implementation or assume a stable layout type across Pi releases.
    const frame = (tui as unknown as { currentLayout?: unknown }).currentLayout;
    if (typeof frame !== "object" || frame === null) return undefined;
    if (!("root" in frame)) return undefined;
    return frame;
  } catch {
    return undefined;
  }
}

function reconcileRuntime(runtime: Runtime, tui: TUI): void {
  try {
    const frame = currentLayout(tui);
    const tools = frame === undefined ? [] : collectToolComponents(frame);
    const changed = reconcileExpansionState(runtime.state, readGlobalExpanded(runtime), tools);
    if (changed) tui.requestRender();
  } catch {
    // A partially-updated private layout should only disable reconciliation for
    // this pass; Pi remains responsible for rendering and input handling.
  }
}

function warnCompatibilityOnce(runtime: Runtime): void {
  if (runtime.compatibilityWarningShown) return;
  runtime.compatibilityWarningShown = true;
  safely(() => runtime.ctx.ui.notify(
    "Per-tool mouse expansion is unavailable in this Pi fullscreen renderer",
    "warning",
  ));
}

function terminalPointIsUsable(tui: TUI, x: number, y: number): boolean {
  try {
    const terminal = tui.terminal as unknown as { columns?: unknown; rows?: unknown };
    if (typeof terminal.columns === "number" && Number.isFinite(terminal.columns) && x >= terminal.columns) {
      return false;
    }
    if (typeof terminal.rows === "number" && Number.isFinite(terminal.rows) && y >= terminal.rows) {
      return false;
    }
    return x >= 0 && y >= 0;
  } catch {
    return false;
  }
}

function handleTerminalInput(
  runtime: Runtime,
  data: string,
): ReturnType<TerminalInputHandler> {
  try {
    if (runtime.disposed || !runtime.enabled || !runtime.tui) return undefined;

    const tui = runtime.tui;
    // Ctrl+o is handled by Pi. Reconcile before inspecting this event so a
    // global change made by that key clears old local exceptions promptly.
    reconcileRuntime(runtime, tui);

    const event = parseSgrMouseEvent(data);
    if (!event || !isUnmodifiedPrimaryPress(event)) return undefined;
    if (tui.mode !== "fullscreen") return undefined;

    // A visible dialog or overlay owns the screen. The conservative public
    // guard avoids toggling a transcript component beneath it.
    if (typeof tui.hasOverlay !== "function" || tui.hasOverlay()) return undefined;

    if (!runtime.inputPriorityReady) {
      // Returning undefined is important: the normal viewport can still use
      // this click for selection, scrolling, hyperlinks, or right-click logic.
      warnCompatibilityOnce(runtime);
      return undefined;
    }

    if (!terminalPointIsUsable(tui, event.x, event.y)) return undefined;
    const frame = currentLayout(tui);
    if (frame === undefined) return undefined;
    const component = findToolAt(frame, event);
    if (!component) return undefined;

    // Only a matching header click is consumed. Body clicks and every other
    // mouse report remain available to Pi's viewport implementation.
    toggleToolExpansion(runtime.state, component);
    tui.requestRender();
    return { consume: true };
  } catch {
    // Mouse input is a compatibility boundary. Fail open so Pi retains it.
    return undefined;
  }
}

function disposeRuntime(runtime: Runtime): void {
  if (runtime.disposed) return;
  runtime.disposed = true;

  // Unsubscribe first: no handler may retain the session while the widget is
  // being removed. Both operations are intentionally idempotent/best effort.
  const unsubscribe = runtime.unsubscribeInput;
  runtime.unsubscribeInput = undefined;
  safely(() => unsubscribe?.());
  safely(() => runtime.ctx.ui.setWidget(HOOK_WIDGET_KEY, undefined));

  runtime.tui = undefined;
  clearExpansionState(runtime.state);
  runtime.inputPriorityReady = false;
}

function isCurrent(runtime: Runtime | undefined, ctx: ExtensionContext): runtime is Runtime {
  return runtime !== undefined && !runtime.disposed && runtime.ctx.sessionManager === ctx.sessionManager;
}

export default function toolExpansion(pi: ExtensionAPI): void {
  let current: Runtime | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (current) disposeRuntime(current);
    current = undefined;

    // The hook and raw input subscription are deliberately absent outside the
    // interactive TUI mode. RPC/JSON/print must remain entirely untouched.
    if (ctx.mode !== "tui") return;

    let initialGlobalExpanded = false;
    safely(() => {
      initialGlobalExpanded = ctx.ui.getToolsExpanded();
    });
    const runtime: Runtime = {
      ctx,
      state: createExpansionState(initialGlobalExpanded),
      tui: undefined,
      unsubscribeInput: undefined,
      inputHandler: undefined as unknown as TerminalInputHandler,
      inputPriorityReady: false,
      compatibilityWarningShown: false,
      enabled: true,
      disposed: false,
    };
    runtime.inputHandler = (data) => handleTerminalInput(runtime, data);
    current = runtime;

    try {
      runtime.unsubscribeInput = ctx.ui.onTerminalInput(runtime.inputHandler);

      ctx.ui.setWidget(
        HOOK_WIDGET_KEY,
        (tui) => {
          runtime.tui = tui;
          // Pi rebinds extension listeners when switching renderers. Re-run
          // this check both here and in render(), after that rebind completes.
          runtime.inputPriorityReady = prioritizeInputListener(tui, runtime.inputHandler);
          reconcileRuntime(runtime, tui);

          return {
            render() {
              if (runtime.disposed) return [];
              runtime.tui = tui;
              runtime.inputPriorityReady = prioritizeInputListener(tui, runtime.inputHandler);
              reconcileRuntime(runtime, tui);
              return [];
            },
            invalidate() {},
          };
        },
        { placement: "belowEditor" },
      );

      // The TUI may already exist when a widget is registered. This immediate
      // retry is harmless and catches that case without changing Set order from
      // inside the input callback.
      if (runtime.tui) {
        runtime.inputPriorityReady = prioritizeInputListener(runtime.tui, runtime.inputHandler);
        runtime.tui.requestRender();
      }
    } catch {
      // If a host lacks either public hook, leave no partially-installed state.
      disposeRuntime(runtime);
      current = undefined;
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!isCurrent(current, ctx)) return;
    clearExpansionState(current.state, readGlobalExpanded(current));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isCurrent(current, ctx)) return;
    disposeRuntime(current);
    current = undefined;
  });
}
