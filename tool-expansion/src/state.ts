/** The only operation state reconciliation needs from a tool component. */
export interface ExpandableToolComponent {
  setExpanded(expanded: boolean): void;
}

export interface ExpansionState {
  globalExpanded: boolean;
  overrides: WeakMap<ExpandableToolComponent, boolean>;
  applied: WeakMap<ExpandableToolComponent, boolean>;
  /**
   * The components that carry a local override, so reconciliation can find
   * them without searching the transcript.
   *
   * Why this exists: `overrides` is a WeakMap and cannot be enumerated. The
   * previous design compensated by walking Pi's private layout on every frame
   * and every input byte, and that walk re-rendered every tool block in the
   * session. Measured on a 878-tool session it turned 506 Box renders per frame
   * into 7455, which is 10 ms per keystroke against 97 ms.
   *
   * WeakRef, not a plain Set: a strong reference here would keep whole tool
   * components alive after Pi removed them from the transcript. Dead entries
   * are pruned lazily while iterating, which is the only moment they matter.
   */
  tracked: Set<WeakRef<ExpandableToolComponent>>;
}

export function createExpansionState(globalExpanded: boolean): ExpansionState {
  return {
    globalExpanded,
    overrides: new WeakMap(),
    applied: new WeakMap(),
    tracked: new Set(),
  };
}

/**
 * Discard component-local state while retaining Pi's current global setting.
 * WeakMaps are replaced rather than cleared because WeakMap has no clear API.
 */
export function clearExpansionState(state: ExpansionState, globalExpanded = state.globalExpanded): void {
  state.globalExpanded = globalExpanded;
  state.overrides = new WeakMap();
  state.applied = new WeakMap();
  // The tracking set mirrors `overrides`, so it must be dropped with it.
  // Keeping stale refs would make reconciliation revisit components whose
  // override no longer exists.
  state.tracked = new Set();
}

/**
 * Synchronize local overrides after a render or input event.
 *
 * Untouched tools deliberately receive no call here: Pi applies its global
 * expansion value to newly-created tools itself. Only a local exception needs
 * reapplication, which also prevents an unstable/private layout from causing
 * a render request loop.
 *
 * Only components with an override can need work, and this state object knows
 * exactly which those are. Visibility is deliberately NOT consulted: applying
 * an override to an off-screen component is idempotent and costs one call,
 * while deciding whether it is on screen would cost a full layout walk.
 *
 * Returns true when at least one component was updated and another render may
 * be needed to show that update.
 */
export function reconcileExpansionState(
  state: ExpansionState,
  globalExpanded: boolean,
): boolean {
  if (state.globalExpanded !== globalExpanded) {
    clearExpansionState(state, globalExpanded);
  }

  let changed = false;
  for (const ref of state.tracked) {
    const component = ref.deref();
    if (component === undefined) {
      // Pi dropped the component; the WeakMap entries are already gone.
      state.tracked.delete(ref);
      continue;
    }
    const override = state.overrides.get(component);
    if (override === undefined) {
      state.tracked.delete(ref);
      continue;
    }
    if (state.applied.get(component) === override) continue;
    component.setExpanded(override);
    state.applied.set(component, override);
    changed = true;
  }
  return changed;
}

/** Toggle one component and apply the result immediately. */
export function toggleToolExpansion(
  state: ExpansionState,
  component: ExpandableToolComponent,
): boolean {
  const current = state.overrides.get(component) ?? state.globalExpanded;
  const next = !current;
  // First override for this component: start tracking it. `overrides` is the
  // authority on membership, so the check cannot drift from the WeakMap.
  if (!state.overrides.has(component)) state.tracked.add(new WeakRef(component));
  state.overrides.set(component, next);
  state.applied.set(component, next);
  component.setExpanded(next);
  return next;
}
