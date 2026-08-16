/** The only operation state reconciliation needs from a tool component. */
export interface ExpandableToolComponent {
  setExpanded(expanded: boolean): void;
}

export interface ExpansionState {
  globalExpanded: boolean;
  overrides: WeakMap<ExpandableToolComponent, boolean>;
  applied: WeakMap<ExpandableToolComponent, boolean>;
}

export function createExpansionState(globalExpanded: boolean): ExpansionState {
  return {
    globalExpanded,
    overrides: new WeakMap(),
    applied: new WeakMap(),
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
}

/**
 * Synchronize local overrides after a render or input event.
 *
 * Untouched tools deliberately receive no call here: Pi applies its global
 * expansion value to newly-created tools itself. Only a local exception needs
 * reapplication, which also prevents an unstable/private layout from causing
 * a render request loop.
 *
 * Returns true when at least one component was updated and another render may
 * be needed to show that update.
 */
export function reconcileExpansionState(
  state: ExpansionState,
  globalExpanded: boolean,
  visibleTools: Iterable<ExpandableToolComponent>,
): boolean {
  if (state.globalExpanded !== globalExpanded) {
    clearExpansionState(state, globalExpanded);
  }

  let changed = false;
  for (const component of visibleTools) {
    const override = state.overrides.get(component);
    if (override === undefined || state.applied.get(component) === override) continue;
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
  state.overrides.set(component, next);
  state.applied.set(component, next);
  component.setExpanded(next);
  return next;
}
