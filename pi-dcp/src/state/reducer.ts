import type { BlockId, RunId } from "../identity/types.ts";
import { hashJson } from "../util/hash.ts";
import { isOperationEnvelope, type DcpOperation, type CreatedBlock, type OpEnvelope, type NudgeRequested } from "./operations.ts";
import { addSavingsTotals, cloneSavingsTotals, emptySavingsTotals, savingsFromOperation, type SavingsTotals } from "../stats.ts";

export interface ReducedBlock extends CreatedBlock {
  runId: RunId;
  createdByOpId: string;
  active: boolean;
  available: boolean;
  userDecompressed: boolean;
  parentBlockIds: BlockId[];
}
/**
 * A pruning decision for one field of one tool call. It is recorded when it is
 * decided, and its savings are counted then. Whether it already changes the
 * outgoing request is a separate question, answered by outgoingPrune.
 */
export interface PruneClaim { opId: string; operationIndex: number; estimatedTokens: number; }
export interface ReducedToolPrune {
  /** immediate: a sweep switched this output on, so it applies without a compression. */
  output?: PruneClaim & { kind: "dedup-output" | "sweep-output"; immediate?: true };
  oldErrorInput?: PruneClaim;
  questionInput?: PruneClaim;
}
/** Delivery is derived from branch custom_message entries, not mutable reducer state. */
export interface ReducedNudge extends NudgeRequested { requestedByOpId: string; }
export interface ReducedState {
  schema: 2;
  blocks: Map<BlockId, ReducedBlock>;
  runs: Map<RunId, BlockId[]>;
  toolPrunes: Map<string, ReducedToolPrune>;
  /**
   * operationIndex of the latest reduced compression.created, or -1 before any.
   * A pruning claim reaches the request only once a compression committed after
   * it, so the ordering lives here and replays the same way (see outgoingPrune).
   */
  lastCompressionOperationIndex: number;
  /**
   * Tool-call IDs of compress calls that actually produced blocks. The authored
   * summary text is stored in the block, so keeping the identical text in the
   * tool-call arguments charges the user twice for it forever - the arguments
   * live after the compressed range and can never be covered by a block.
   * See applyPersistedRedactions in transform/tools.ts.
   */
  compressToolCallIds: Set<string>;
  nudges: Map<string, ReducedNudge>;
  manualMode: boolean;
  savings: SavingsTotals;
  appliedOpIds: Set<string>;
  requestKeys: Map<string, string>;
  operationCount: number;
  corruptReason?: "state_schema_unknown" | "state_conflict";
  opPayloads?: Map<string, string>;
}

export function emptyState(): ReducedState {
  return {
    schema: 2,
    blocks: new Map(),
    runs: new Map(),
    toolPrunes: new Map(),
    lastCompressionOperationIndex: -1,
    compressToolCallIds: new Set(),
    nudges: new Map(),
    manualMode: false,
    savings: emptySavingsTotals(),
    appliedOpIds: new Set(),
    requestKeys: new Map(),
    operationCount: 0,
    opPayloads: new Map(),
  };
}

export function cloneState(state: ReducedState): ReducedState {
  return {
    schema: 2,
    blocks: new Map([...state.blocks].map(([id, block]) => [id, {
      ...block,
      coverage: {
        ...block.coverage,
        directEntryIds: [...block.coverage.directEntryIds],
        effectiveEntryIds: [...block.coverage.effectiveEntryIds],
        directToolCallIds: [...block.coverage.directToolCallIds],
        effectiveToolCallIds: [...block.coverage.effectiveToolCallIds],
      },
      anchor: { ...block.anchor },
      consumedBlockIds: [...block.consumedBlockIds],
      parentBlockIds: [...block.parentBlockIds],
    }])),
    runs: new Map([...state.runs].map(([id, blocks]) => [id, [...blocks]])),
    toolPrunes: new Map([...state.toolPrunes].map(([id, prune]) => [id, { ...prune }])),
    lastCompressionOperationIndex: state.lastCompressionOperationIndex,
    compressToolCallIds: new Set(state.compressToolCallIds || []),
    nudges: new Map([...state.nudges].map(([key, nudge]) => [key, { ...nudge }])),
    manualMode: state.manualMode,
    savings: cloneSavingsTotals(state.savings || emptySavingsTotals()),
    appliedOpIds: new Set(state.appliedOpIds),
    requestKeys: new Map(state.requestKeys),
    operationCount: state.operationCount,
    corruptReason: state.corruptReason,
    opPayloads: new Map(state.opPayloads || []),
  };
}

export function reduceEnvelope(state: ReducedState, envelope: unknown): ReducedState {
  if (state.corruptReason) return state;
  if (!isOperationEnvelope(envelope)) return { ...state, corruptReason: "state_schema_unknown" };
  const next = cloneState(state);
  const payloadHash = hashJson(envelope.operation);
  const priorOp = next.opPayloads?.get(envelope.opId);
  if (priorOp && priorOp !== payloadHash) { next.corruptReason = "state_conflict"; return next; }
  if (priorOp) return next;
  const prior = next.requestKeys.get(envelope.requestKey);
  if (prior && prior !== payloadHash) { next.corruptReason = "state_conflict"; return next; }
  if (next.appliedOpIds.has(envelope.opId)) return next;
  if (prior) {
    next.appliedOpIds.add(envelope.opId);
    next.opPayloads?.set(envelope.opId, payloadHash);
    return next;
  }
  if (!applyOperation(next, envelope.operation, envelope.opId, next.operationCount)) {
    next.corruptReason = "state_conflict";
    return next;
  }
  next.requestKeys.set(envelope.requestKey, payloadHash);
  next.opPayloads?.set(envelope.opId, payloadHash);
  next.appliedOpIds.add(envelope.opId);
  next.operationCount++;
  return next;
}

function applyOperation(state: ReducedState, operation: DcpOperation, opId: string, operationIndex: number): boolean {
  if (operation.type === "compression.created") {
    if (state.runs.has(operation.runId) || operation.blocks.length < 1 || operation.blocks.length > 16) return false;
    const ids: string[] = [];
    const covered = new Set<string>();
    const coveredTools = new Set<string>();
    for (const block of operation.blocks) {
      if ((block.anchor.beforeEntryId && block.coverage.effectiveEntryIds.includes(block.anchor.beforeEntryId))
        || (block.anchor.afterEntryId && block.coverage.effectiveEntryIds.includes(block.anchor.afterEntryId))
        || (block.anchor.beforeEntryId && block.anchor.beforeEntryId === block.anchor.afterEntryId)) return false;
      if (new Set(block.coverage.directEntryIds).size !== block.coverage.directEntryIds.length
        || new Set(block.coverage.effectiveEntryIds).size !== block.coverage.effectiveEntryIds.length
        || new Set(block.coverage.directToolCallIds).size !== block.coverage.directToolCallIds.length
        || new Set(block.coverage.effectiveToolCallIds).size !== block.coverage.effectiveToolCallIds.length
        || new Set(block.consumedBlockIds).size !== block.consumedBlockIds.length) return false;
      if (!block.coverage.directEntryIds.every((id) => block.coverage.effectiveEntryIds.includes(id))
        || !block.coverage.directToolCallIds.every((id) => block.coverage.effectiveToolCallIds.includes(id))) return false;
      if (block.coverage.effectiveEntryIds.some((id) => covered.has(id))
        || block.coverage.effectiveToolCallIds.some((id) => coveredTools.has(id))) return false;
      for (const id of block.coverage.effectiveToolCallIds) coveredTools.add(id);
      for (const entryId of block.coverage.effectiveEntryIds) covered.add(entryId);
      if (state.blocks.has(block.blockId) || block.ordinal !== ids.length || block.nestedDepth < 0 || block.consumedBlockIds.some((id) => !state.blocks.has(id))) return false;
      if (block.consumedBlockIds.some((id) => !state.blocks.get(id)?.active)) return false;
      for (const childId of block.consumedBlockIds) {
        const child = state.blocks.get(childId)!;
        if (!child.coverage.effectiveEntryIds.every((entryId) => block.coverage.effectiveEntryIds.includes(entryId))
          || block.nestedDepth < child.nestedDepth + 1 || child.userDecompressed) return false;
      }
      for (const [existingId, existing] of state.blocks) {
        if (existing.active && block.coverage.effectiveEntryIds.some((entryId) => existing.coverage.effectiveEntryIds.includes(entryId)) && !block.consumedBlockIds.includes(existingId)) return false;
      }
      state.blocks.set(block.blockId, { ...block, runId: operation.runId, createdByOpId: opId, active: true, available: true, userDecompressed: false, parentBlockIds: [] });
      ids.push(block.blockId);
    }
    for (const id of ids) {
      for (const childId of state.blocks.get(id)!.consumedBlockIds) {
        const child = state.blocks.get(childId)!;
        child.active = false;
        child.parentBlockIds = [...new Set([...child.parentBlockIds, id])];
      }
    }
    state.runs.set(operation.runId, ids);
    if (operation.toolCallId) state.compressToolCallIds.add(operation.toolCallId);
    // Set only after every check above has passed: a rejected envelope returns
    // false before this line, so it cannot activate earlier pruning claims.
    state.lastCompressionOperationIndex = operationIndex;
    addSavingsTotals(state.savings, savingsFromOperation(operation));
    return true;
  }
  if (operation.type === "blocks.activation.changed") {
    for (const id of operation.blockIds) {
      const block = state.blocks.get(id);
      if (!block || !block.available) return false;
      if (operation.active && (operation.cause !== "user-recompress" || !block.userDecompressed)) return false;
      if (!operation.active && (operation.cause !== "user-decompress" || !block.active)) return false;
    }
    for (const id of operation.blockIds) {
      const block = state.blocks.get(id)!;
      block.active = operation.active;
      block.userDecompressed = !operation.active && operation.cause === "user-decompress";
      if (operation.active) deactivateDescendants(state, block.blockId);
      else if (operation.cause === "user-decompress") activateEligibleDescendants(state, block.blockId);
    }
    return true;
  }
  if (operation.type === "tools.pruned") {
    const seen = new Set<string>();
    if (operation.decisions.some((decision) => {
      const key = `${decision.toolCallId}\0${decision.kind}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    })) return false;
    for (const decision of operation.decisions) {
      const current = state.toolPrunes.get(decision.toolCallId) || {};
      const claim: PruneClaim = { opId, operationIndex, estimatedTokens: decision.estimatedTokens };
      if (decision.kind === "dedup-output" || decision.kind === "sweep-output") {
        if (!current.output) current.output = { kind: decision.kind, ...claim, ...(decision.kind === "sweep-output" ? { immediate: true as const } : {}) };
        // A sweep can switch on an output that an earlier decision recorded and
        // that still waits for a compression. The claim keeps its operation and
        // its credit, so only its timing changes. The sweep adds no tokens.
        else if (decision.kind === "sweep-output") current.output = { ...current.output, immediate: true };
      } else if (decision.kind === "old-error-input") current.oldErrorInput ||= claim;
      else current.questionInput ||= claim;
      state.toolPrunes.set(decision.toolCallId, current);
    }
    addSavingsTotals(state.savings, savingsFromOperation(operation));
    return true;
  }
  if (operation.type === "manual.changed") { state.manualMode = operation.enabled; return true; }
  if (operation.type === "nudge.requested") {
    const existing = state.nudges.get(operation.nudgeKey);
    if (!existing) state.nudges.set(operation.nudgeKey, { ...operation, requestedByOpId: opId });
    return true;
  }
  return false;
}

/**
 * The pruning claims that change the outgoing request now, or undefined when none does.
 *
 * A claim waits until a compression that committed after it has been reduced.
 * That compression already rewrites history from its range start, so the pruned
 * bytes add no earlier cache break. Applying the claim where it was decided would
 * change bytes before every later assistant turn. That drops the signed thinking
 * of those turns and misses the prompt cache.
 *
 * `/dcp sweep` is the one exception. It is an explicit user request, so the
 * outputs it names apply at once, including an output claim that still waits
 * (see applyOperation).
 *
 * The result depends only on reducer order, so a restart or a fork that replays
 * the same entries builds the same request.
 */
export function outgoingPrune(state: ReducedState, toolCallId: string): ReducedToolPrune | undefined {
  const prune = state.toolPrunes.get(toolCallId);
  if (!prune) return undefined;
  const takesEffect = (claim: PruneClaim, immediate: boolean): boolean => immediate || claim.operationIndex < state.lastCompressionOperationIndex;
  const active: ReducedToolPrune = {};
  if (prune.output && takesEffect(prune.output, prune.output.immediate === true)) active.output = prune.output;
  if (prune.oldErrorInput && takesEffect(prune.oldErrorInput, false)) active.oldErrorInput = prune.oldErrorInput;
  if (prune.questionInput && takesEffect(prune.questionInput, false)) active.questionInput = prune.questionInput;
  return active.output || active.oldErrorInput || active.questionInput ? active : undefined;
}

// Both walks below recurse over consumedBlockIds. Recursion depth is bounded by
// MAX_NESTED_DEPTH, because nestedDepth strictly decreases from parent to child
// (see the invariant in applyOperation), so no walk can exceed that many frames.
function deactivateDescendants(state: ReducedState, blockId: string): void {
  const block = state.blocks.get(blockId);
  if (!block) return;
  for (const childId of block.consumedBlockIds) {
    const child = state.blocks.get(childId);
    if (child) { child.active = false; deactivateDescendants(state, childId); }
  }
}
function activateEligibleDescendants(state: ReducedState, blockId: string): void {
  const block = state.blocks.get(blockId);
  if (!block) return;
  for (const childId of block.consumedBlockIds) {
    const child = state.blocks.get(childId);
    if (child?.available && !child.userDecompressed) { child.active = true; activateEligibleDescendants(state, childId); }
  }
}

/**
 * @param unprojectedEntryIds Entries that are still on the branch but are no
 * longer projected into the model context (empty assistant messages left by a
 * failed request). They count as present for coverage, and any recorded anchor
 * that points at one is treated as an open boundary, because the anchor we can
 * recompute today can never name an entry that is not in the index anymore.
 * Without this, a block created next to - or over - a failed request would lose
 * its anchor match and deactivate itself forever.
 */
export function markAvailability(state: ReducedState, availableEntryIds: ReadonlySet<string>, validAnchors: ReadonlyMap<string, CreatedBlock["anchor"]>, unprojectedEntryIds: ReadonlySet<string> = new Set()): ReducedState {
  const next = cloneState(state);
  const present = (id: string): boolean => availableEntryIds.has(id) || unprojectedEntryIds.has(id);
  for (const block of next.blocks.values()) {
    const coverageAvailable = block.coverage.effectiveEntryIds.every(present);
    const before = block.anchor.beforeEntryId ? present(block.anchor.beforeEntryId) : true;
    const after = block.anchor.afterEntryId ? present(block.anchor.afterEntryId) : true;
    // A missing recorded side is an open boundary. A block created at the
    // tail has no afterEntryId, so a later append must not make its anchor
    // invalid merely because a new entry now exists after the block. Recorded
    // boundaries still protect against a branch edit or deleted neighbour.
    const currentAnchor = validAnchors.get(block.blockId);
    const anchorValid = validAnchors.size === 0 || (currentAnchor !== undefined && anchorMatches(block.anchor, currentAnchor, unprojectedEntryIds));
    block.available = coverageAvailable && before && after && anchorValid;
    if (!block.available) block.active = false;
  }
  return next;
}

function anchorMatches(recorded: CreatedBlock["anchor"], current: CreatedBlock["anchor"], unprojectedEntryIds: ReadonlySet<string>): boolean {
  const side = (recordedId: string | undefined, currentId: string | undefined): boolean =>
    recordedId === undefined || unprojectedEntryIds.has(recordedId) || recordedId === currentId;
  return side(recorded.beforeEntryId, current.beforeEntryId) && side(recorded.afterEntryId, current.afterEntryId);
}
