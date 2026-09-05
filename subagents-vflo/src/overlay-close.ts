/**
 * Safe teardown for an extension overlay opened with `ctx.ui.custom()`.
 *
 * ── The defect this works around ─────────────────────────────────────────────
 *
 * Pi closes an overlay custom UI inside `showExtensionCustom`'s `close()` with
 * `ui.hideOverlay()`. That method pops the TOPMOST overlay, not the entry that
 * belongs to the custom UI which just finished. Pi does create the correct
 * handle and hands it to us through `onHandle`, but its own teardown ignores it.
 *
 * So when two extension overlays are open and the LOWER one closes first, pi
 * destroys the UPPER one. The owner of the upper overlay never learns about it:
 * its promise is still pending, but its component is no longer in any render
 * tree. Keyboard focus can then land on that orphaned component, and the
 * terminal looks completely frozen — nothing repaints and no key does anything.
 *
 * A proven sequence, replayed against real pi-tui:
 *   1. The subagent inspector is open.       stack: [sidebar, inspector]
 *   2. The agent calls ask_user_question.    stack: [sidebar, inspector, question]
 *   3. The user collapses the questionnaire. It calls `setHidden(true)` on its
 *      own overlay, so pi-tui hands keyboard focus to the inspector below it.
 *   4. The user closes the inspector. Pi's blind pop removes the QUESTION entry.
 *   5. Every later action makes it worse until focus rests on a component that
 *      no render tree contains. The session is unusable.
 *
 * ── The workaround ───────────────────────────────────────────────────────────
 *
 * Remove our own entry through our own handle, then neutralise the blind pop
 * for the duration of the synchronous `done()` call. Pi's `close()` runs
 * `hideOverlay`, `resolve` and `dispose` synchronously, so restoring the method
 * immediately afterwards is safe: no foreign code can observe the stub.
 *
 * NOTE: sibling copies of this file exist in `sidebar-vflo` and `pi-dcp`. The
 * packages are loaded independently by pi, so they cannot share a module. Keep
 * the three copies in step.
 */

/** Minimal shape of the overlay handle pi passes to `onHandle`. */
interface OverlayHandleLike {
  hide?: () => void;
}

/** Minimal shape of the pi-tui instance passed to a custom UI factory. */
interface TuiLike {
  hideOverlay?: () => void;
}

/**
 * Close an overlay custom UI without disturbing other extensions' overlays.
 *
 * @param tui    The TUI instance handed to the `ctx.ui.custom()` factory.
 * @param handle The overlay handle captured through `onHandle`.
 * @param done   Pi's `done` callback for this custom UI.
 */
export function closeOverlayCustomUi(
  tui: TuiLike | null | undefined,
  handle: OverlayHandleLike | null | undefined,
  done: () => void,
): void {
  const canSelfRemove = typeof handle?.hide === "function" && typeof tui?.hideOverlay === "function";
  if (!canSelfRemove) {
    // An older or partial host. A wrong pop is bad, but a UI that can never be
    // closed is worse, so fall back to pi's own teardown.
    done();
    return;
  }

  // `hideOverlay` normally lives on the TUI prototype. Track whether an own
  // property already existed so the stub is deleted rather than left behind as
  // a permanent shadow of the prototype method.
  const target = tui as Record<string, unknown>;
  const hadOwnHideOverlay = Object.prototype.hasOwnProperty.call(target, "hideOverlay");
  const previousOwnHideOverlay = hadOwnHideOverlay ? target.hideOverlay : undefined;

  try {
    // Removes exactly this overlay, retargets other entries that pointed at it
    // for focus restore, and hands focus to the next visible capturing overlay
    // or to whatever was focused before this overlay opened.
    handle.hide!();
    target.hideOverlay = () => {};
    done();
  } finally {
    if (hadOwnHideOverlay) target.hideOverlay = previousOwnHideOverlay;
    else delete target.hideOverlay;
  }
}
