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
  /** Temporarily focus the inspector and return a callback that restores its prior focus state. */
  focusInspectorOverlayForDialog?: () => (() => void) | undefined;
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

/**
 * Layout budget for the parent-side modal.
 *
 * Pi puts a non-overlay `ctx.ui.custom()` component inside the editor dock
 * (`interactive-mode`: `editorContainer`), NOT on the whole screen. That dock
 * shares the terminal with the transcript, the status rows, the widgets and
 * the footer. When the child of a VStack is taller than the height it was
 * given, pi-tui keeps the TOP and drops the rest (`v-stack`:
 * `rendered.slice(0, size)`); in fullscreen mode there is no scrollback that
 * could bring the lost rows back.
 *
 * A component only receives a width in `render()`, so it can never learn its
 * real allocated height. Two rules follow, and both are load-bearing:
 *
 *  1. Reserve a chrome allowance instead of claiming the full terminal height.
 *  2. Draw the decision controls FIRST. Whatever gets clipped must be context,
 *     never the means to answer the dialog.
 *
 * A regression here is silent and severe: the user sees a screen full of child
 * text with no visible way to allow or deny, and the child blocks until the
 * request times out.
 */
const DOCK_CHROME_ROWS = 8;
const MIN_DIALOG_ROWS = 16;
/** Upper bound on simultaneously drawn options; a child may send any number. */
const MAX_VISIBLE_OPTIONS = 8;

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
    const budget = this.rowBudget();

    // Order is a safety property, not a style choice. See DOCK_CHROME_ROWS.
    const header = this.headerLines(safeWidth);
    const hint = [this.theme.fg("dim", this.hintText())];
    // Two blank separator rows plus the hint are fixed overhead; the control
    // block keeps whatever is left after one reserved context row.
    const controlBudget = Math.max(1, budget - header.length - hint.length - 3);
    const control = this.controlLines(safeWidth, controlBudget);

    const lines: string[] = [...header, "", ...control, ...hint, ""];

    // The context block is the only clippable region. It holds untrusted child
    // text (task, request title, tool arguments), so it is bounded and
    // scrollable rather than truncated.
    const context = this.contextLines(safeWidth);
    const contextBudget = Math.max(1, budget - lines.length);
    const scrollable = context.length > contextBudget;
    const visibleContext = scrollable ? Math.max(1, contextBudget - 1) : contextBudget;
    const maxOffset = Math.max(0, context.length - visibleContext);
    this.contextOffset = Math.min(this.contextOffset, maxOffset);
    if (context.length > 0) {
      const contextEnd = Math.min(context.length, this.contextOffset + visibleContext);
      lines.push(...context.slice(this.contextOffset, contextEnd));
      if (this.contextOffset > 0 || contextEnd < context.length) {
        lines.push(this.theme.fg("dim", `  context ${this.contextOffset + 1}-${contextEnd}/${context.length} • PgUp/PgDn scroll`));
      }
    }

    // Sanitize before width handling: pi-tui may append a cursor or style
    // reset marker when it sees editor output, and escaped controls must count
    // toward the visible width just like any other displayed text.
    this.cachedLines = lines.map((line) => fitSafeLine(line, safeWidth));
    return this.cachedLines;
  }

  /** Total rows this component may draw. Never the full terminal height. */
  private rowBudget(): number {
    const termRows = this.tui?.terminal?.rows || 24;
    return Math.max(MIN_DIALOG_ROWS, termRows - DOCK_CHROME_ROWS);
  }

  /**
   * Ownership header. Every value is drawn on exactly one row so a long cwd,
   * agent name or instance id can never push the controls out of view.
   */
  private headerLines(width: number): string[] {
    const bold = (text: string) => this.theme.bold ? this.theme.bold(text) : text;
    const lines = [
      this.theme.fg("accent", bold(fitSafeLine("Subagent requires input", width))),
      this.theme.fg("dim", fitSafeLine(`Agent: ${this.item.owner.agent}  •  Instance: ${this.item.owner.instanceId}`, width)),
      this.theme.fg("dim", fitSafeLine(`cwd: ${this.item.owner.cwd}`, width)),
    ];
    const queued = this.itemQueueDepth();
    if (queued > 0) {
      lines.push(this.theme.fg("warning", fitSafeLine(`Additional queued requests: ${queued}`, width)));
    }
    if (this.item.deadline !== undefined) {
      const remaining = Math.max(0, this.item.deadline - this.now());
      lines.push(this.theme.fg(
        remaining < 1000 ? "error" : "dim",
        fitSafeLine(`Timeout: ${(remaining / 1000).toFixed(1)}s remaining`, width),
      ));
    }
    return lines;
  }

  /** Key help for the active method, kept next to the controls it describes. */
  private hintText(): string {
    if (this.item.request.method === "select") {
      return "↑↓ choose • Enter submit • Esc cancel • PgUp/PgDn context";
    }
    if (this.item.request.method === "confirm") {
      return "←→/y/n choose • Enter submit • Esc cancel • PgUp/PgDn context";
    }
    return "Enter submit • Esc cancel • PgUp/PgDn context";
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

    // Ordered by decision value, most important first. The context block is
    // the region that gets clipped when the dock is short, and the task text
    // is both the longest and the least useful part for an allow/deny answer.
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
    addWrapped("Task: ", this.item.owner.task);
    return lines;
  }

  /**
   * The interactive block. It is capped at `budget` rows because a child can
   * send any number of options or a very long editor prefill, and an oversized
   * control block would be clipped by Pi exactly like an oversized dialog.
   */
  private controlLines(width: number, budget = Number.MAX_SAFE_INTEGER): string[] {
    const lines: string[] = [];
    const request = this.item.request;
    if (request.method === "select") {
      lines.push(this.theme.fg("accent", "Choose an option:"));
      // Keep the selected option inside the drawn window; a user must always
      // see what Enter would send.
      const window = Math.max(1, Math.min(MAX_VISIBLE_OPTIONS, budget - 1));
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(window / 2), request.options.length - window));
      const end = Math.min(request.options.length, start + window);
      if (start > 0) lines.push(this.theme.fg("dim", `   ↑ ${start} more`));
      for (let index = start; index < end; index++) {
        const marker = index === this.selectedIndex ? ">" : " ";
        lines.push(truncateToWidth(` ${marker} ${safeDialogText(request.options[index])}`, width, ""));
      }
      if (end < request.options.length) {
        lines.push(this.theme.fg("dim", `   ↓ ${request.options.length - end} more`));
      }
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
    // Last-resort guard. Every branch above should already fit, but a clipped
    // control block must not be able to push the key hint off the screen.
    return lines.length > budget ? lines.slice(0, budget) : lines;
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

    let finish: ((decision: ChildUIDialogDecision) => void) | null = null;
    let abortedBeforeFactory = false;
    let settled = false;
    let restoreInspectorFocus: (() => void) | undefined;
    const abort = () => {
      if (finish) finish({ kind: "cancelled", reason: "aborted" });
      else abortedBeforeFactory = true;
    };
    signal.addEventListener("abort", abort, { once: true });
    // AbortSignal does not replay an already-fired event to a new listener.
    if (signal.aborted) abort();

    try {
      if (abortedBeforeFactory || signal.aborted) {
        return { kind: "cancelled", reason: "aborted" };
      }

      let inspectorActive = false;
      let inspectorFocused = true;
      try {
        inspectorActive = !!this.options.isInspectorActive?.();
        inspectorFocused = !!this.options.isInspectorOverlayFocused?.();
      } catch (error) {
        // A status callback must not turn a recoverable UI prompt into an
        // invisible cancellation. Continue with the modal and explain the
        // lost focus-recovery guarantee to diagnostics.
        this.diagnostic(
          `Unable to inspect subagent overlay focus; presenting child extension dialog anyway: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (inspectorActive && !inspectorFocused) {
        try {
          restoreInspectorFocus = this.options.focusInspectorOverlayForDialog?.();
        } catch (error) {
          this.diagnostic(
            `Unable to focus subagent inspector; presenting child extension dialog anyway: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!restoreInspectorFocus) {
          this.diagnostic(
            "Subagent inspector focus could not be arranged; presenting child extension dialog without focus recovery",
          );
        }
      }

      if (abortedBeforeFactory || signal.aborted) {
        return { kind: "cancelled", reason: "aborted" };
      }

      const result = await this.ctx.ui.custom(
        (tui: any, theme: PresenterTheme, _keybindings: any, done: (value: ChildUIDialogDecision) => void) => {
          const settle = (decision: ChildUIDialogDecision): void => {
            if (settled) return;
            settled = true;
            done(decision);
          };
          finish = settle;
          const actualTheme = theme || fallbackTheme;
          const itemForPresenter = { ...item, queueDepth };
          const component = new ChildUIDialogComponent(
            itemForPresenter,
            tui,
            actualTheme,
            settle,
            this.now,
          );
          if (abortedBeforeFactory || signal.aborted) settle({ kind: "cancelled", reason: "aborted" });
          return component;
        },
        // This is intentionally a temporary non-overlay custom UI. The
        // inspector remains the owner of its overlay handle and regains focus
        // when Pi closes this component.
        { overlay: false },
      );
      if (!result) {
        return { kind: "cancelled", reason: signal.aborted ? "aborted" : "closed" };
      }
      return result as ChildUIDialogDecision;
    } catch (error) {
      this.diagnostic(
        `Unable to present child extension dialog: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: "cancelled", reason: "presenter failure" };
    } finally {
      try {
        restoreInspectorFocus?.();
      } catch (error) {
        // The answer already belongs to the user. A stale or failing overlay
        // handle must not replace it with a presenter error.
        try {
          this.diagnostic(
            `Unable to restore subagent inspector focus after child extension dialog: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch {
          // Diagnostics are best-effort during teardown.
        }
      }
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
    try {
      this.options.onDiagnostic?.(message);
    } catch {
      // Diagnostics are best-effort and must not change the dialog decision.
    }
  }
}

export function createExtensionUIDialogPresenter(
  ctx: any,
  options?: ExtensionUIDialogPresenterOptions,
): ExtensionUIDialogPresenter {
  return new ExtensionUIDialogPresenter(ctx, options);
}
