/** Parent-side presentation for blocking child extension UI dialogs. */

import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import {
  formatActiveChildToolCall,
  sanitizeTerminalText,
  type ChildExtensionUIDialogRequest,
} from "./rpc-extension-ui.js";
import type {
  ChildUIDialogDecision,
  ChildUIDialogPresenter,
  QueuedChildUIRequest,
} from "./extension-ui-broker.js";

export interface ExtensionUIDialogPresenterOptions {
  isInspectorActive?: () => boolean;
  isInspectorOverlayFocused?: () => boolean;
  onDiagnostic?: (message: string) => void;
  now?: () => number;
}

interface PresenterTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

const fallbackTheme: PresenterTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function initialSelectIndex(options: string[]): number {
  const deny = options.indexOf("Deny");
  return deny >= 0 ? deny : 0;
}

export function getSafeInitialSelectIndex(options: string[]): number {
  return initialSelectIndex(options);
}

export function safeDialogText(value: string): string {
  return sanitizeTerminalText(value);
}

function fitSafeLine(value: string, width: number): string {
  const safe = sanitizeTerminalText(value);
  if (visibleWidth(safe) <= width) return safe;
  let result = "";
  for (const character of safe) {
    if (visibleWidth(result + character) > width) break;
    result += character;
  }
  return result;
}

function editorTheme(theme: PresenterTheme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

function decisionValue(request: ChildExtensionUIDialogRequest, value: string): ChildUIDialogDecision {
  return request.method === "confirm"
    ? { kind: "cancelled", reason: "invalid presenter value" }
    : { kind: "value", value };
}

/**
 * A bounded custom component. It intentionally does not use child extension
 * components: those factories execute in the RPC child and cannot cross into
 * the parent's TUI.
 */
export class ChildUIDialogComponent implements Component {
  private readonly item: QueuedChildUIRequest;
  private readonly tui: any;
  private readonly theme: PresenterTheme;
  private readonly done: (decision: ChildUIDialogDecision) => void;
  private readonly now: () => number;
  private readonly editor: Editor | null;
  private readonly originalPrefill: string | undefined;
  private editorChanged = false;
  private selectedIndex = 0;
  private confirmValue = false;
  private contextOffset = 0;
  private cachedLines: string[] | null = null;
  private cachedWidth = -1;
  private completed = false;

  constructor(
    item: QueuedChildUIRequest,
    tui: any,
    theme: PresenterTheme,
    done: (decision: ChildUIDialogDecision) => void,
    now: () => number = Date.now,
  ) {
    this.item = item;
    this.tui = tui;
    this.theme = theme || fallbackTheme;
    this.done = done;
    this.now = now;
    this.selectedIndex = item.request.method === "select" ? initialSelectIndex(item.request.options) : 0;
    this.originalPrefill = item.request.method === "editor" ? item.request.prefill : undefined;

    if (item.request.method === "input" || item.request.method === "editor") {
      this.editor = new Editor(tui, editorTheme(this.theme));
      if (item.request.method === "editor" && item.request.prefill !== undefined) {
        this.editor.setText(item.request.prefill);
        this.editorChanged = false;
      }
      this.editor.onChange = () => {
        this.editorChanged = true;
        this.invalidate();
      };
      this.editor.onSubmit = (value) => {
        if (this.completed) return;
        const submitted = item.request.method === "editor" && !this.editorChanged
          ? this.originalPrefill || ""
          : value;
        this.complete(decisionValue(item.request, submitted));
      };
      this.editor.focused = true;
    } else {
      this.editor = null;
    }
  }

  get selectedOptionIndex(): number {
    return this.selectedIndex;
  }

  get confirmationValue(): boolean {
    return this.confirmValue;
  }

  get contextScrollOffset(): number {
    return this.contextOffset;
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  complete(decision: ChildUIDialogDecision): void {
    if (this.completed) return;
    this.completed = true;
    this.done(decision);
  }

  cancel(): void {
    this.complete({ kind: "cancelled", reason: "cancelled" });
  }

  handleInput(data: string): void {
    if (this.completed) return;

    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, "shift+up")) {
      this.contextOffset = Math.max(0, this.contextOffset - this.contextPageSize());
      this.invalidate();
      this.tui?.requestRender?.();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, "shift+down")) {
      this.contextOffset += this.contextPageSize();
      this.invalidate();
      this.tui?.requestRender?.();
      return;
    }

    if (this.editor) {
      // Editor.submitValue() trims before invoking onSubmit. Intercept the
      // submit key and read the editor before it resets so spaces and newlines
      // remain protocol data exactly as entered.
      if (matchesKey(data, Key.enter)) {
        const submitted = this.item.request.method === "editor" && !this.editorChanged
          ? this.originalPrefill || ""
          : this.editor.getExpandedText();
        this.complete(decisionValue(this.item.request, submitted));
        return;
      }
      this.editor.handleInput(data);
      this.invalidate();
      this.tui?.requestRender?.();
      return;
    }

    if (this.item.request.method === "select") {
      if (matchesKey(data, Key.up)) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.invalidate();
        this.tui?.requestRender?.();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.selectedIndex = Math.min(this.item.request.options.length - 1, this.selectedIndex + 1);
        this.invalidate();
        this.tui?.requestRender?.();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.complete({ kind: "value", value: this.item.request.options[this.selectedIndex] });
        return;
      }
      return;
    }

    if (this.item.request.method === "confirm") {
      if (matchesKey(data, "y") || matchesKey(data, "right")) {
        this.confirmValue = true;
        this.invalidate();
        this.tui?.requestRender?.();
        return;
      }
      if (matchesKey(data, "n") || matchesKey(data, "left")) {
        this.confirmValue = false;
        this.invalidate();
        this.tui?.requestRender?.();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.complete({ kind: "confirmed", confirmed: this.confirmValue });
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    const safeWidth = Math.max(12, width);
    const lines: string[] = [];
    const add = (text: string, color?: string) => {
      const rendered = color ? this.theme.fg(color, text) : text;
      lines.push(...wrapTextWithAnsi(rendered, safeWidth).map((line) => truncateToWidth(line, safeWidth, "")));
    };

    const bold = (text: string) => this.theme.bold ? this.theme.bold(text) : text;
    add(bold("Subagent requires input"), "accent");
    add(`Agent: ${safeDialogText(this.item.owner.agent)}  •  Instance: ${safeDialogText(this.item.owner.instanceId)}`, "dim");
    add(`cwd: ${safeDialogText(this.item.owner.cwd)}`, "dim");
    add(`Additional queued requests: ${this.itemQueueDepth()}`, "warning");
    if (this.item.deadline !== undefined) {
      const remaining = Math.max(0, this.item.deadline - this.now());
      add(`Timeout: ${(remaining / 1000).toFixed(1)}s remaining`, remaining < 1000 ? "error" : "dim");
    }
    lines.push("");

    const context = this.contextLines(safeWidth);
    const control = this.controlLines(safeWidth);
    const termRows = this.tui?.terminal?.rows || 24;
    const reserved = control.length + 7;
    const visibleContext = Math.max(1, termRows - reserved);
    const maxOffset = Math.max(0, context.length - visibleContext);
    this.contextOffset = Math.min(this.contextOffset, maxOffset);
    if (context.length > 0) {
      const contextEnd = Math.min(context.length, this.contextOffset + visibleContext);
      lines.push(...context.slice(this.contextOffset, contextEnd));
      if (this.contextOffset > 0 || contextEnd < context.length) {
        lines.push(this.theme.fg("dim", `  context ${this.contextOffset + 1}-${contextEnd}/${context.length} • PgUp/PgDn scroll`));
      }
    }
    lines.push("");
    lines.push(...control);
    lines.push(this.theme.fg("dim", "↑↓ choose • Enter submit • Esc cancel • PgUp/PgDn context"));

    // Sanitize before width handling: pi-tui may append a cursor or style
    // reset marker when it sees editor output, and escaped controls must count
    // toward the visible width just like any other displayed text.
    this.cachedLines = lines.map((line) => fitSafeLine(line, safeWidth));
    return this.cachedLines;
  }

  private itemQueueDepth(): number {
    // The presenter updates this text by replacing the item-local metadata
    // before each render; the broker-supplied depth is also rendered by the
    // production presenter header. Keep this component safe for direct tests.
    return this.item.queueDepth || 0;
  }

  private contextLines(width: number): string[] {
    const lines: string[] = [];
    const addWrapped = (prefix: string, value: string, color = "text") => {
      const safePrefix = safeDialogText(prefix);
      const prefixWidth = visibleWidth(safePrefix);
      const wrapped = wrapTextWithAnsi(safeDialogText(value), Math.max(1, width - prefixWidth));
      wrapped.forEach((line, index) => {
        const rendered = `${index === 0 ? safePrefix : " ".repeat(prefixWidth)}${line}`;
        lines.push(this.theme.fg(color, truncateToWidth(rendered, width, "")));
      });
    };

    addWrapped("Task: ", this.item.owner.task);
    addWrapped("Request: ", this.item.request.title, "accent");
    if (this.item.request.method === "confirm" && this.item.request.message !== undefined) {
      addWrapped("Message: ", this.item.request.message);
    }
    if (this.item.request.method === "input" && this.item.request.placeholder !== undefined) {
      addWrapped("Placeholder: ", this.item.request.placeholder, "muted");
    }
    if (this.item.activeToolCalls.length === 0) {
      addWrapped("Tools: ", "No active tool context was reported", "muted");
    } else {
      addWrapped("Tools: ", "Active child tool calls", "warning");
      for (const call of this.item.activeToolCalls) {
        const formatted = formatActiveChildToolCall(call);
        addWrapped("  Tool: ", `${formatted.toolName} (${formatted.toolCallId})`, "warning");
        if (formatted.command !== undefined) addWrapped("  Command: ", formatted.command, "accent");
        addWrapped("  Args: ", formatted.arguments);
      }
    }
    return lines;
  }

  private controlLines(width: number): string[] {
    const lines: string[] = [];
    const request = this.item.request;
    if (request.method === "select") {
      lines.push(this.theme.fg("accent", "Choose an option:"));
      request.options.forEach((option, index) => {
        const marker = index === this.selectedIndex ? ">" : " ";
        lines.push(truncateToWidth(` ${marker} ${safeDialogText(option)}`, width, ""));
      });
    } else if (request.method === "confirm") {
      lines.push(this.theme.fg("accent", "Confirm:"));
      lines.push(` ${this.confirmValue ? "[Yes]  No" : " Yes   [No]"}`);
      if (request.message) lines.push(this.theme.fg("muted", safeDialogText(request.message)));
    } else if (this.editor) {
      lines.push(this.theme.fg("accent", request.method === "editor" ? "Edit value:" : "Enter value:"));
      if (request.method === "input" && request.placeholder) {
        lines.push(this.theme.fg("muted", ` ${safeDialogText(request.placeholder)}`));
      }
      for (const line of this.editor.render(Math.max(1, width - 2))) {
        // Editor rendering includes a cursor marker. This modal is also a
        // security boundary for untrusted child text, so render that marker
        // (and any data controls) as inert escaped text rather than forwarding
        // terminal sequences from a child.
        lines.push(truncateToWidth(` ${sanitizeTerminalText(line)}`, width, ""));
      }
    }
    return lines;
  }

  private contextPageSize(): number {
    return Math.max(1, (this.tui?.terminal?.rows || 24) - 10);
  }
}

export class ExtensionUIDialogPresenter implements ChildUIDialogPresenter {
  private readonly ctx: any;
  private readonly options: ExtensionUIDialogPresenterOptions;
  private readonly now: () => number;

  constructor(ctx: any, options: ExtensionUIDialogPresenterOptions = {}) {
    this.ctx = ctx;
    this.options = options;
    this.now = options.now || Date.now;
  }

  async present(
    item: QueuedChildUIRequest,
    signal: AbortSignal,
    queueDepth: number,
  ): Promise<ChildUIDialogDecision> {
    if (signal.aborted) return { kind: "cancelled", reason: "aborted" };
    if (!this.ctx?.hasUI || typeof this.ctx?.ui?.custom !== "function") {
      this.diagnostic("Parent UI is unavailable; child extension dialog was cancelled");
      return { kind: "cancelled", reason: "parent UI unavailable" };
    }

    if (this.options.isInspectorActive?.() && !this.options.isInspectorOverlayFocused?.()) {
      this.diagnostic("Subagent inspector is not focused; child extension dialog was cancelled");
      return { kind: "cancelled", reason: "inspector focus unavailable" };
    }

    let finish: ((decision: ChildUIDialogDecision) => void) | null = null;
    let abortedBeforeFactory = false;
    const abort = () => {
      if (finish) finish({ kind: "cancelled", reason: "aborted" });
      else abortedBeforeFactory = true;
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      const result = await this.ctx.ui.custom(
        (tui: any, theme: PresenterTheme, _keybindings: any, done: (value: ChildUIDialogDecision) => void) => {
          const actualTheme = theme || fallbackTheme;
          const itemForPresenter = { ...item, queueDepth };
          const component = new ChildUIDialogComponent(
            itemForPresenter,
            tui,
            actualTheme,
            (decision) => done(decision),
            this.now,
          );
          finish = (decision) => done(decision);
          if (abortedBeforeFactory || signal.aborted) finish({ kind: "cancelled", reason: "aborted" });
          return component;
        },
        // This is intentionally a temporary non-overlay custom UI. The
        // inspector remains the owner of its overlay handle and regains focus
        // when Pi closes this component.
        { overlay: false },
      );
      if (!result) return { kind: "cancelled", reason: "closed" };
      return result as ChildUIDialogDecision;
    } catch (error) {
      this.diagnostic(
        `Unable to present child extension dialog: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: "cancelled", reason: "presenter failure" };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private diagnostic(message: string): void {
    try {
      this.ctx?.ui?.notify?.(message, "warning");
    } catch {
      // A notification failure must not turn a safe cancellation into a child
      // runner failure.
    }
    this.options.onDiagnostic?.(message);
  }
}

export function createExtensionUIDialogPresenter(
  ctx: any,
  options?: ExtensionUIDialogPresenterOptions,
): ExtensionUIDialogPresenter {
  return new ExtensionUIDialogPresenter(ctx, options);
}
