import { describe, expect, it, vi } from "vitest";
import { ChildUIDialogComponent, ExtensionUIDialogPresenter, getSafeInitialSelectIndex } from "./extension-ui-presenter.js";
import type { QueuedChildUIRequest } from "./extension-ui-broker.js";
import type { ChildExtensionUIDialogRequest } from "./rpc-extension-ui.js";
import type { ChildExtensionUIChannel } from "./runner.js";
import { visibleWidth } from "@earendil-works/pi-tui";

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
