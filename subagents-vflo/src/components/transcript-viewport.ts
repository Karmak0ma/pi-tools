/**
 * TranscriptViewport — utility/service for virtual scrolling.
 *
 * NOT a Component (Component.render() only takes width, not height).
 * Called directly by InspectorComponent with both width and height.
 *
 * Maintains a virtual document (all children rendered) and slices
 * to the visible viewport. Caches the virtual doc until marked dirty.
 */

import type { Component } from "@earendil-works/pi-tui";

export class TranscriptViewport {
  private children: Component[] = [];
  private cachedVirtualDoc: string[] = [];
  private dirty: boolean = true;
  private lastWidth: number = -1;
  private _scrollOffset: number = 0;
  private _viewportHeight: number = 20;
  private _pinnedToBottom: boolean = true;  // Auto-scroll to bottom during streaming

  get scrollOffset(): number {
    return this._scrollOffset;
  }

  get pinnedToBottom(): boolean {
    return this._pinnedToBottom;
  }

  get pageSize(): number {
    return Math.max(1, this._viewportHeight - 1);
  }

  get totalLines(): number {
    return this.cachedVirtualDoc.length;
  }

  setChildren(children: Component[]): void {
    // Only mark dirty if the child list actually changed (by identity)
    if (children.length !== this.children.length || children.some((c, i) => c !== this.children[i])) {
      this.children = children;
      this.dirty = true;
    }
  }

  addChild(child: Component): void {
    this.children.push(child);
    this.dirty = true;
  }

  setScrollOffset(offset: number): void {
    const maxScroll = this.getMaxScroll();
    this._scrollOffset = Math.max(0, Math.min(offset, maxScroll));
    // Only pin to bottom when explicitly at maxScroll AND there's content to scroll
    this._pinnedToBottom = (this._scrollOffset >= maxScroll && maxScroll > 0);
  }

  scrollBy(delta: number): void {
    const prevOffset = this._scrollOffset;
    this.setScrollOffset(this._scrollOffset + delta);
    // Re-pin if scrolling down reached the bottom
    const maxScroll = this.getMaxScroll();
    if (delta > 0 && this._scrollOffset >= maxScroll && maxScroll > 0) {
      this._pinnedToBottom = true;
    }
  }

  /** Explicitly pin to bottom (e.g. on tab switch). */
  pinToBottom(): void {
    this._pinnedToBottom = true;
    this._scrollOffset = this.getMaxScroll();
  }

  getMaxScroll(): number {
    return Math.max(0, this.cachedVirtualDoc.length - this._viewportHeight);
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Get the visible lines for the current viewport.
   *
   * Rebuilds the virtual document from all children if dirty or width changed.
   * Then slices to the viewport height and pads to fill.
   */
  getVisibleLines(width: number, viewportHeight: number): string[] {
    this._viewportHeight = viewportHeight;

    // Rebuild virtual doc if needed
    if (this.dirty || this.lastWidth !== width) {
      this.cachedVirtualDoc = [];
      for (const child of this.children) {
        const childLines = child.render(width);
        this.cachedVirtualDoc.push(...childLines);
      }
      this.dirty = false;
      this.lastWidth = width;

      // Auto-scroll to bottom when pinned (streaming content)
      if (this._pinnedToBottom) {
        const maxScroll = this.getMaxScroll();
        this._scrollOffset = maxScroll;
      }
    }

    // Clamp scroll offset
    const maxScroll = this.getMaxScroll();
    if (this._scrollOffset > maxScroll) {
      this._scrollOffset = maxScroll;
    }

    // Slice to viewport
    const visible = this.cachedVirtualDoc.slice(
      this._scrollOffset,
      this._scrollOffset + viewportHeight,
    );

    // Pad to fill viewport height (prevents ghost rows from content shrinkage)
    while (visible.length < viewportHeight) {
      visible.push("");
    }

    return visible;
  }
}
