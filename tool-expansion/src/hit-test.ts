import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface TerminalPoint {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function readRect(value: unknown): Rect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof width !== "number" || !Number.isFinite(width) ||
    typeof height !== "number" || !Number.isFinite(height)
  ) {
    return undefined;
  }
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function contains(rect: Rect, point: TerminalPoint): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function intersects(first: Rect, second: Rect): boolean {
  return (
    Math.max(first.x, second.x) < Math.min(first.x + first.width, second.x + second.width) &&
    Math.max(first.y, second.y) < Math.min(first.y + first.height, second.y + second.height)
  );
}

/**
 * Identify a real ToolExecutionComponent, with a deliberately narrow fallback
 * for duplicate package instances where `instanceof` crosses module copies.
 */
export function isToolExecutionComponent(value: unknown): value is ToolExecutionComponent {
  if (!isRecord(value)) return false;
  try {
    if (value instanceof ToolExecutionComponent) return true;
  } catch {
    // Continue to the strict structural check below.
  }

  const constructor = value.constructor;
  const constructorName = typeof constructor === "function" && typeof constructor.name === "string"
    ? constructor.name
    : undefined;
  return (
    constructorName === "ToolExecutionComponent" &&
    typeof value.setExpanded === "function" &&
    typeof value.render === "function"
  );
}

function renderLines(component: unknown, width: number): string[] | undefined {
  if (!isRecord(component) || typeof component.render !== "function") return undefined;
  try {
    const lines = component.render(width);
    return Array.isArray(lines) && lines.every((line) => typeof line === "string") ? lines : undefined;
  } catch {
    return undefined;
  }
}

function firstNonEmptySourceLine(lines: unknown): number | undefined {
  if (!Array.isArray(lines)) return undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (typeof line !== "string") continue;
    try {
      if (stripTerminalSequences(line).trim().length > 0) return index;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function lineOffset(box: RecordLike): number {
  return typeof box.lineOffset === "number" && Number.isFinite(box.lineOffset)
    ? Math.trunc(box.lineOffset)
    : 0;
}

function visibleToolBox(box: RecordLike): { component: ToolExecutionComponent; rect: Rect; clip: Rect } | undefined {
  const component = box.component;
  const rect = readRect(box.rect);
  const clip = readRect(box.clip);
  if (!isToolExecutionComponent(component) || !rect || !clip || !intersects(rect, clip)) return undefined;
  return { component, rect, clip };
}

function layoutChildren(value: RecordLike): unknown[] {
  return Array.isArray(value.children) ? value.children : [];
}

/**
 * The current pi-tui layout creates a leaf LayoutBox for ordinary Container
 * instances. Pi's chat and document containers hold ToolExecutionComponents in
 * their public `children` arrays, but those children are flattened into the
 * container's `lines` instead of receiving LayoutBoxes of their own. Walk that
 * specific, concatenating Container shape so the feature works with the real
 * 0.84 layout while remaining fail-closed for arbitrary components.
 */
function flattenedContainerChildren(component: unknown): unknown[] | undefined {
  if (!isRecord(component) || typeof component.render !== "function") return undefined;
  const constructor = component.constructor;
  if (typeof constructor !== "function" || constructor.name !== "Container") return undefined;
  return Array.isArray(component.children) ? component.children : undefined;
}

function screenRowForSourceLine(box: RecordLike, sourceStart: number, sourceIndex: number): number | undefined {
  const rect = readRect(box.rect);
  if (!rect) return undefined;
  return rect.y + sourceStart + sourceIndex - lineOffset(box);
}

function pointCanHitBox(box: RecordLike, point: TerminalPoint): boolean {
  const rect = readRect(box.rect);
  const clip = readRect(box.clip);
  return rect !== undefined && clip !== undefined && intersects(rect, clip) && contains(rect, point) && contains(clip, point);
}

function toolAtRenderedLines(
  box: RecordLike,
  component: ToolExecutionComponent,
  lines: string[],
  sourceStart: number,
  point: TerminalPoint,
): ToolExecutionComponent | undefined {
  if (!pointCanHitBox(box, point)) return undefined;
  const sourceIndex = firstNonEmptySourceLine(lines);
  if (sourceIndex === undefined) return undefined;
  const screenRow = screenRowForSourceLine(box, sourceStart, sourceIndex);
  return screenRow !== undefined && point.y === screenRow ? component : undefined;
}

function toolIsVisibleInRenderedSpan(box: RecordLike, sourceStart: number, lineCount: number): boolean {
  if (lineCount <= 0) return false;
  const rect = readRect(box.rect);
  const clip = readRect(box.clip);
  if (!rect || !clip || !intersects(rect, clip)) return false;
  const top = rect.y + sourceStart - lineOffset(box);
  const bottom = top + lineCount;
  return bottom > clip.y && top < clip.y + clip.height;
}

function findFlattenedTool(
  box: RecordLike,
  point: TerminalPoint,
  visitedComponents: Set<object>,
): ToolExecutionComponent | undefined {
  const children = flattenedContainerChildren(box.component);
  if (!children || !Array.isArray(box.lines)) return undefined;

  const width = readRect(box.rect)?.width;
  if (width === undefined) return undefined;
  let sourceStart = 0;
  for (const child of children) {
    if (!isRecord(child) || visitedComponents.has(child)) {
      continue;
    }
    visitedComponents.add(child);
    const lines = renderLines(child, width);
    if (lines === undefined) return undefined;

    if (isToolExecutionComponent(child)) {
      const match = toolAtRenderedLines(box, child, lines, sourceStart, point);
      if (match) return match;
    } else {
      const nested = findFlattenedToolInComponent(box, child, lines, sourceStart, point, visitedComponents);
      if (nested) return nested;
    }
    sourceStart += lines.length;
  }
  return undefined;
}

function findFlattenedToolInComponent(
  box: RecordLike,
  component: unknown,
  renderedLines: string[],
  sourceStart: number,
  point: TerminalPoint,
  visitedComponents: Set<object>,
): ToolExecutionComponent | undefined {
  const children = flattenedContainerChildren(component);
  if (!children) return undefined;

  let childStart = sourceStart;
  for (const child of children) {
    if (!isRecord(child) || visitedComponents.has(child)) continue;
    visitedComponents.add(child);
    const lines = renderLines(child, readRect(box.rect)?.width ?? 0);
    if (lines === undefined) return undefined;
    if (isToolExecutionComponent(child)) {
      const match = toolAtRenderedLines(box, child, lines, childStart, point);
      if (match) return match;
    } else {
      const nested = findFlattenedToolInComponent(box, child, lines, childStart, point, visitedComponents);
      if (nested) return nested;
    }
    childStart += lines.length;
  }

  // `renderedLines` is intentionally accepted by this helper to document that
  // child offsets are relative to the already-rendered parent span. The parent
  // render result is otherwise authoritative for clipping and lineOffset.
  void renderedLines;
  return undefined;
}

function collectFlattenedTools(
  box: RecordLike,
  result: ToolExecutionComponent[],
  seenTools: Set<ToolExecutionComponent>,
  visitedComponents: Set<object>,
): void {
  const children = flattenedContainerChildren(box.component);
  if (!children || !Array.isArray(box.lines)) return;
  const width = readRect(box.rect)?.width;
  if (width === undefined) return;

  let sourceStart = 0;
  for (const child of children) {
    if (!isRecord(child) || visitedComponents.has(child)) continue;
    visitedComponents.add(child);
    const lines = renderLines(child, width);
    if (lines === undefined) return;

    if (isToolExecutionComponent(child)) {
      if (toolIsVisibleInRenderedSpan(box, sourceStart, lines.length) && !seenTools.has(child)) {
        seenTools.add(child);
        result.push(child);
      }
    } else {
      collectFlattenedToolsInComponent(box, child, lines, sourceStart, result, seenTools, visitedComponents);
    }
    sourceStart += lines.length;
  }
}

function collectFlattenedToolsInComponent(
  box: RecordLike,
  component: unknown,
  renderedLines: string[],
  sourceStart: number,
  result: ToolExecutionComponent[],
  seenTools: Set<ToolExecutionComponent>,
  visitedComponents: Set<object>,
): void {
  const children = flattenedContainerChildren(component);
  if (!children) return;
  const width = readRect(box.rect)?.width;
  if (width === undefined) return;

  let childStart = sourceStart;
  for (const child of children) {
    if (!isRecord(child) || visitedComponents.has(child)) continue;
    visitedComponents.add(child);
    const lines = renderLines(child, width);
    if (lines === undefined) return;

    if (isToolExecutionComponent(child)) {
      if (toolIsVisibleInRenderedSpan(box, childStart, lines.length) && !seenTools.has(child)) {
        seenTools.add(child);
        result.push(child);
      }
    } else {
      collectFlattenedToolsInComponent(box, child, lines, childStart, result, seenTools, visitedComponents);
    }
    childStart += lines.length;
  }
  void renderedLines;
}

/**
 * Find the first tool whose first non-empty rendered line contains a point.
 * Layout coordinates are already screen-relative, including scroll translation.
 */
export function findToolAt(frame: unknown, point: TerminalPoint): ToolExecutionComponent | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  if (!isRecord(frame)) return undefined;

  const visitedBoxes = new Set<object>();
  const visitedComponents = new Set<object>();
  const visit = (value: unknown): ToolExecutionComponent | undefined => {
    if (!isRecord(value) || visitedBoxes.has(value)) return undefined;
    visitedBoxes.add(value);

    const tool = visibleToolBox(value);
    if (tool && contains(tool.rect, point) && contains(tool.clip, point)) {
      const sourceIndex = firstNonEmptySourceLine(value.lines);
      if (sourceIndex !== undefined) {
        const screenRow = tool.rect.y + sourceIndex - lineOffset(value);
        if (point.y === screenRow) return tool.component;
      }
    }

    const children = layoutChildren(value);
    if (children.length > 0) {
      for (const child of children) {
        const match = visit(child);
        if (match) return match;
      }
    } else {
      const flattened = findFlattenedTool(value, point, visitedComponents);
      if (flattened) return flattened;
    }
    return undefined;
  };

  return visit(frame.root);
}

/**
 * Collect visible tool components for state reconciliation. Components are
 * returned once even if a malformed layout repeats a box or creates a cycle.
 */
export function collectToolComponents(frame: unknown): ToolExecutionComponent[] {
  if (!isRecord(frame)) return [];

  const visitedBoxes = new Set<object>();
  const visitedComponents = new Set<object>();
  const seenTools = new Set<ToolExecutionComponent>();
  const result: ToolExecutionComponent[] = [];
  const visit = (value: unknown): void => {
    if (!isRecord(value) || visitedBoxes.has(value)) return;
    visitedBoxes.add(value);

    const tool = visibleToolBox(value);
    if (tool && !seenTools.has(tool.component)) {
      seenTools.add(tool.component);
      result.push(tool.component);
    }

    const children = layoutChildren(value);
    if (children.length > 0) {
      for (const child of children) visit(child);
    } else {
      collectFlattenedTools(value, result, seenTools, visitedComponents);
    }
  };

  visit(frame.root);
  return result;
}
