import { describe, expect, it, vi } from "vitest";
import { ChildUIDialogComponent, ExtensionUIDialogPresenter, getSafeInitialSelectIndex } from "./extension-ui-presenter.js";
import type { QueuedChildUIRequest } from "./extension-ui-broker.js";
import type { ChildExtensionUIDialogRequest } from "./rpc-extension-ui.js";
import type { ChildExtensionUIChannel } from "./runner.js";
import { Container, ScrollView, VStack, visibleWidth } from "@earendil-works/pi-tui";
// Deep import: Pi's fullscreen host lays components out with this function but
// does not re-export it. The regression test below needs the real allocator to
// prove the dialog survives clipping.
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function item(request: ChildExtensionUIDialogRequest): QueuedChildUIRequest {
  return {
    key: `child:${request.id}`,
    owner: { instanceId: "child", agent: "worker", task: "inspect files", cwd: "/tmp" },
    request,
    activeToolCalls: [{
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "printf 'line 1\\nline 2'" },
      startedAt: 1,
    }],
    channel: {
      respond: () => true,
      forget: () => {},
      isOpen: () => true,
    } satisfies ChildExtensionUIChannel,
    receivedAt: 0,
    presenter: undefined as never,
  };
}

function tui() {
  return { terminal: { rows: 18, columns: 50 }, requestRender: vi.fn() };
}

describe("child extension UI presenter", () => {
  it("selects Deny without reordering options", () => {
    expect(getSafeInitialSelectIndex(["Allow once", "Deny", "Decline and stop"])).toBe(1);
    expect(getSafeInitialSelectIndex(["first", "second"])).toBe(0);
  });

  it("maps Enter to the exact selected value and Escape to cancellation", () => {
    const decisions: unknown[] = [];
    const component = new ChildUIDialogComponent(
      item({ type: "extension_ui_request", id: "s", method: "select", title: "title", options: ["Allow once", "Deny"] }),
      tui(),
      theme,
      (decision) => decisions.push(decision),
    );
    expect(component.selectedOptionIndex).toBe(1);
    component.handleInput("\r");
    expect(decisions).toEqual([{ kind: "value", value: "Deny" }]);

    const cancelled: unknown[] = [];
    const second = new ChildUIDialogComponent(
      item({ type: "extension_ui_request", id: "s2", method: "confirm", title: "title" }),
      tui(),
      theme,
      (decision) => cancelled.push(decision),
    );
    second.handleInput("\u001b");
    expect(cancelled).toEqual([{ kind: "cancelled", reason: "cancelled" }]);
  });

  it("preserves whitespace in input and keeps rendered lines bounded and inert", () => {
    const decisions: any[] = [];
    const component = new ChildUIDialogComponent(
      item({ type: "extension_ui_request", id: "i", method: "input", title: "unsafe \u001b[31m title" }),
      tui(),
      theme,
      (decision) => decisions.push(decision),
    );
    component.handleInput("a");
    component.handleInput(" ");
    component.handleInput(" ");
    component.handleInput("\r");
    expect(decisions[0].value).toBe("a  ");

    const lines = component.render(50);
    expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).toContain("printf");
  });

  /**
   * Regression: the modal used to size itself to the whole terminal and draw
   * the option list last. Pi puts a non-overlay custom component in the editor
   * dock and clips an oversized child at the bottom, so the user saw a screen
   * full of child task text with no way to answer, and the child blocked.
   */
  describe("dock layout safety", () => {
    const longTaskItem = (rows: number) => {
      const queued = item({
        type: "extension_ui_request",
        id: "danger",
        method: "select",
        title: "Dangerous command: recursive delete",
        options: ["Allow once", "Allow for session", "Deny", "Decline and stop"],
      });
      queued.owner.task = "Do the thing carefully. ".repeat(500);
      return new ChildUIDialogComponent(queued, { terminal: { rows, columns: 100 }, requestRender: vi.fn() }, theme, () => {});
    };

    it("never claims the whole terminal height", () => {
      for (const rows of [24, 30, 40, 50, 60, 120]) {
        const lines = longTaskItem(rows).render(100);
        // Budget is `rows - 8` with a floor of 16 rows.
        expect(lines.length).toBeLessThanOrEqual(Math.max(16, rows - 8));
      }
    });

    it("draws every option before any child-supplied context", () => {
      const lines = longTaskItem(50).render(100);
      const menu = lines.findIndex((line) => line.includes("Choose an option:"));
      const task = lines.findIndex((line) => line.includes("Task: "));
      expect(menu).toBeGreaterThanOrEqual(0);
      expect(lines[menu + 4]).toContain("Decline and stop");
      expect(task).toBeGreaterThan(menu);
    });

    it("keeps the menu on screen inside Pi's fullscreen dock", () => {
      const ROWS = 50;
      const COLS = 100;
      class Filler {
        constructor(private readonly count: number, private readonly tag: string) {}
        render(): string[] {
          return Array.from({ length: this.count }, (_, index) => `${this.tag}${index}`);
        }
        invalidate(): void {}
      }

      const editorContainer = new Container();
      editorContainer.addChild(longTaskItem(ROWS) as never);
      // Mirrors interactive-mode's fullscreen layout, with a realistic amount
      // of dock chrome (status row, widget rows, multi-line footer).
      const dock = new VStack([
        { component: new Filler(1, "status ") as never, shrink: 1, minSize: 0 },
        { component: new Filler(3, "widget ") as never, shrink: 1, minSize: 0 },
        { component: editorContainer, shrink: 1, minSize: 3 },
        { component: new Filler(3, "footer ") as never, shrink: 1, minSize: 1 },
      ]);
      const root = new VStack([
        { component: new ScrollView(new Filler(400, "transcript ") as never, { follow: "end", primary: true }) as never, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
      ]);

      const frame = (renderLayoutFrame as any)(root, COLS, ROWS, () => {});
      const text = (frame.lines as string[]).join("\n");
      expect(text).toContain("Choose an option:");
      expect(text).toContain("Allow once");
      expect(text).toContain("Decline and stop");
    });
  });

  it("presents an unfocused inspector dialog and returns the exact selected value", async () => {
    const events: string[] = [];
    const restore = vi.fn(() => events.push("restored"));
    const focusForDialog = vi.fn(() => {
      events.push("focused");
      return restore;
    });
    const custom = vi.fn(async (factory: any, options: any) => {
      expect(options).toEqual({ overlay: false });
      let result: unknown;
      const component = factory(tui(), theme, undefined, (decision: unknown) => {
        events.push("answered");
        result = decision;
      });
      events.push("presented");
      component.handleInput("\r");
      return result;
    });
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: true, ui: { custom } },
      {
        isInspectorActive: () => true,
        isInspectorOverlayFocused: () => false,
        focusInspectorOverlayForDialog: focusForDialog,
      },
    );

    const result = await presenter.present(
      item({
        type: "extension_ui_request",
        id: "focus-answer",
        method: "select",
        title: "permission",
        options: ["Allow once", "Deny"],
      }),
      new AbortController().signal,
      0,
    );

    expect(result).toEqual({ kind: "value", value: "Deny" });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["focused", "presented", "answered", "restored"]);
  });

  it("restores inspector focus after modal cancellation", async () => {
    const restore = vi.fn();
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory(tui(), theme, undefined, (decision: unknown) => {
        result = decision;
      });
      component.handleInput("\u001b");
      return result;
    });
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: true, ui: { custom } },
      {
        isInspectorActive: () => true,
        isInspectorOverlayFocused: () => false,
        focusInspectorOverlayForDialog: () => restore,
      },
    );

    const result = await presenter.present(
      item({ type: "extension_ui_request", id: "focus-cancel", method: "confirm", title: "permission" }),
      new AbortController().signal,
      0,
    );

    expect(result).toEqual({ kind: "cancelled", reason: "cancelled" });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("restores inspector focus when the modal is aborted", async () => {
    const controller = new AbortController();
    const restore = vi.fn();
    const custom = vi.fn((factory: any) => new Promise<any>((resolve) => {
      factory(tui(), theme, undefined, resolve);
    }));
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: true, ui: { custom } },
      {
        isInspectorActive: () => true,
        isInspectorOverlayFocused: () => false,
        focusInspectorOverlayForDialog: () => restore,
      },
    );

    const resultPromise = presenter.present(
      item({ type: "extension_ui_request", id: "focus-abort", method: "confirm", title: "permission" }),
      controller.signal,
      0,
    );
    await Promise.resolve();
    controller.abort();

    await expect(resultPromise).resolves.toEqual({ kind: "cancelled", reason: "aborted" });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("restores inspector focus when modal presentation throws", async () => {
    const restore = vi.fn();
    const custom = vi.fn(async () => {
      throw new Error("custom UI failed");
    });
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: true, ui: { custom } },
      {
        isInspectorActive: () => true,
        isInspectorOverlayFocused: () => false,
        focusInspectorOverlayForDialog: () => restore,
      },
    );

    await expect(presenter.present(
      item({ type: "extension_ui_request", id: "focus-throw", method: "confirm", title: "permission" }),
      new AbortController().signal,
      0,
    )).resolves.toEqual({ kind: "cancelled", reason: "presenter failure" });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("presents despite unavailable inspector focus and reports the degraded recovery", async () => {
    const diagnostics: string[] = [];
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory(tui(), theme, undefined, (decision: unknown) => {
        result = decision;
      });
      component.handleInput("\r");
      return result;
    });
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: true, ui: { custom } },
      {
        isInspectorActive: () => true,
        isInspectorOverlayFocused: () => false,
        onDiagnostic: (message) => diagnostics.push(message),
      },
    );

    const result = await presenter.present(
      item({
        type: "extension_ui_request",
        id: "focus-degraded",
        method: "select",
        title: "permission",
        options: ["Allow once", "Deny"],
      }),
      new AbortController().signal,
      0,
    );

    expect(result).toEqual({ kind: "value", value: "Deny" });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(diagnostics).toContain(
      "Subagent inspector focus could not be arranged; presenting child extension dialog without focus recovery",
    );
  });

  it("keeps a valid answer when inspector focus restoration throws", async () => {
    const diagnostics: string[] = [];
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory(tui(), theme, undefined, (decision: unknown) => {
        result = decision;
      });
      component.handleInput("\r");
      return result;
    });
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: true, ui: { custom } },
      {
        isInspectorActive: () => true,
        isInspectorOverlayFocused: () => false,
        focusInspectorOverlayForDialog: () => () => {
          throw new Error("overlay closed");
        },
        onDiagnostic: (message) => diagnostics.push(message),
      },
    );

    await expect(presenter.present(
      item({
        type: "extension_ui_request",
        id: "focus-restore-error",
        method: "select",
        title: "permission",
        options: ["Allow once", "Deny"],
      }),
      new AbortController().signal,
      0,
    )).resolves.toEqual({ kind: "value", value: "Deny" });
    expect(diagnostics).toContain(
      "Unable to restore subagent inspector focus after child extension dialog: overlay closed",
    );
  });

  it("cancels safely when parent UI is unavailable", async () => {
    const notify = vi.fn();
    const diagnostics: string[] = [];
    const presenter = new ExtensionUIDialogPresenter(
      { hasUI: false, ui: { notify } },
      { onDiagnostic: (message) => diagnostics.push(message) },
    );
    const result = await presenter.present(
      item({ type: "extension_ui_request", id: "x", method: "confirm", title: "confirm" }),
      new AbortController().signal,
      0,
    );
    expect(result.kind).toBe("cancelled");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(1);
  });
});
