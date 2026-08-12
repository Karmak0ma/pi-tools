/**
 * FallbackTextComponent — error resilience wrapper.
 *
 * Renders pre-built text lines, used when a standard component fails to construct.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export class FallbackTextComponent implements Component {
  private lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(width: number): string[] {
    return this.lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {
    // Static content — nothing to invalidate
  }
}
