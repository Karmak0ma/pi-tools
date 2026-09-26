/**
 * Rate limiter for UI refreshes.
 *
 * Streaming child events (text deltas, stderr) arrive far faster than a
 * terminal can usefully redraw. Status transitions must still show at once.
 * `immediate()` emits now and cancels any pending emit; `throttled()` emits
 * at most once per interval and always emits the latest state at the end of
 * the interval (trailing edge), so the last delta is never lost.
 *
 * The emit callback reads current state when it runs; the throttle never
 * carries data. This is what lets one task manager feed several observers
 * (the tool row of a running call, the inspector) with independent rates.
 */
export class Throttle {
  private lastEmitTime = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: () => void,
    private readonly intervalMs = 150,
  ) {}

  /** Emit immediately — use for status transitions and completion events. */
  immediate(): void {
    this.cancel();
    this.lastEmitTime = Date.now();
    this.emit();
  }

  /** Throttled emit — use for high-rate streaming changes. */
  throttled(): void {
    const now = Date.now();
    const elapsed = now - this.lastEmitTime;
    if (elapsed >= this.intervalMs) {
      this.lastEmitTime = now;
      this.emit();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.lastEmitTime = Date.now();
        this.emit();
      }, this.intervalMs - elapsed);
    }
  }

  /** Emit a pending throttled change now, if there is one. */
  flush(): void {
    if (this.pendingTimer) {
      this.cancel();
      this.emit();
    }
  }

  /** Drop a pending throttled change without emitting it. */
  cancel(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }
}
