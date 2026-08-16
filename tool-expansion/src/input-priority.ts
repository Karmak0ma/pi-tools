import type { TUI } from "@earendil-works/pi-tui";

export type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

/**
 * Move an extension listener before Pi's fullscreen viewport listener.
 *
 * `inputListeners` is private in pi-tui. The public extension subscription is
 * still used for registration and cleanup; this narrow feature check only
 * adjusts Set insertion order when the current fullscreen implementation
 * exposes the expected shape. Returning false makes the caller fail closed.
 */
export function prioritizeInputListener(tui: TUI | unknown, listener: InputListener): boolean {
  try {
    const candidate = tui as { mode?: unknown; inputListeners?: unknown };
    if (candidate?.mode !== "fullscreen") return false;

    const listeners = candidate.inputListeners;
    if (!(listeners instanceof Set) || !listeners.has(listener)) return false;
    if ([...listeners][0] === listener) return true;

    const existing = [...listeners];
    listeners.clear();
    listeners.add(listener);
    for (const existingListener of existing) {
      if (existingListener !== listener) listeners.add(existingListener);
    }
    return [...listeners][0] === listener;
  } catch {
    // A future TUI may expose a different private shape. Never break Pi input.
    return false;
  }
}
