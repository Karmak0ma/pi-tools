/**
 * A complete SGR mouse report decoded into zero-based terminal coordinates.
 *
 * StdinBuffer already owns escape-sequence buffering, so this parser is
 * intentionally stateless: it accepts one complete report and rejects
 * anything that is not one complete SGR report.
 */
export interface SgrMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
  motion: boolean;
  wheel: boolean;
  modified: boolean;
}

const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** Parse one SGR mouse report, converting its one-based coordinates to zero-based. */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  const match = SGR_MOUSE.exec(data);
  if (!match) return undefined;

  const button = Number(match[1]);
  const oneBasedX = Number(match[2]);
  const oneBasedY = Number(match[3]);
  if (![button, oneBasedX, oneBasedY].every(Number.isSafeInteger)) return undefined;
  if (button < 0 || oneBasedX < 1 || oneBasedY < 1) return undefined;

  return {
    button,
    x: oneBasedX - 1,
    y: oneBasedY - 1,
    release: match[4] === "m",
    motion: (button & 32) !== 0,
    wheel: (button & 64) !== 0,
    // SGR button bits 2, 3, and 4 represent shift, meta, and control.
    modified: (button & 28) !== 0,
  };
}

/** Whether an event is exactly an unmodified primary-button press. */
export function isUnmodifiedPrimaryPress(event: SgrMouseEvent): boolean {
  return event.button === 0 && !event.release && !event.motion && !event.wheel && !event.modified;
}
