import { describe, expect, it } from "vitest";
import {
  conservativeLocalDuration,
  formatActiveChildToolCall,
  parseExtensionUIRequest,
  sanitizeTerminalText,
} from "./rpc-extension-ui.js";

const base = { type: "extension_ui_request" as const, id: "request-1", title: "Danger" };

describe("RPC extension UI protocol", () => {
  it("parses all blocking dialog methods without changing values", () => {
    expect(parseExtensionUIRequest({ ...base, method: "select", options: ["Allow once", "Deny"] })).toEqual({
      kind: "dialog",
      request: { ...base, method: "select", options: ["Allow once", "Deny"] },
    });
    expect(parseExtensionUIRequest({ ...base, method: "confirm", message: "line 1\nline 2" }).kind).toBe("dialog");
    expect(parseExtensionUIRequest({ ...base, method: "input", placeholder: " keep  spaces " }).kind).toBe("dialog");
    expect(parseExtensionUIRequest({ ...base, method: "editor", prefill: "a\n\n b" }).kind).toBe("dialog");
  });

  it("fails closed for malformed known requests and leaves unknown methods untouched", () => {
    expect(parseExtensionUIRequest({ ...base, method: "select", options: [] })).toMatchObject({
      kind: "invalid",
      blocking: true,
      requestId: "request-1",
    });
    expect(parseExtensionUIRequest({ ...base, method: "confirm", timeout: 0 })).toMatchObject({
      kind: "invalid",
      blocking: true,
    });
    expect(parseExtensionUIRequest({ ...base, method: "future_dialog" })).toMatchObject({
      kind: "fire-and-forget",
      known: false,
    });
    expect(parseExtensionUIRequest({ ...base, method: "setTitle" })).toMatchObject({
      kind: "fire-and-forget",
      known: true,
    });
  });

  it("preserves exact response data while sanitizing display data", () => {
    const value = "\u001b]8;;https://evil.example\u0007command\nnext\tpart";
    const display = sanitizeTerminalText(value);
    expect(display).not.toContain("\u001b");
    expect(display).toContain("\\x1b");
    expect(display).toContain("\n");
    expect(formatActiveChildToolCall({
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: value },
      startedAt: 1,
    }).command).toBe(display);
  });

  it("reserves a transport margin for local deadlines", () => {
    expect(conservativeLocalDuration(1000)).toBe(900);
    expect(conservativeLocalDuration(100)).toBe(50);
    expect(conservativeLocalDuration(1)).toBe(0);
  });
});
