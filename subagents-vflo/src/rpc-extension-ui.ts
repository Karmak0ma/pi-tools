/**
 * The small, deliberately local subset of Pi's RPC extension UI protocol used
 * by subagents-vflo.
 *
 * Pi does not currently export a stable TypeScript type for these JSON lines.
 * Keeping the wire types and validation here prevents the runner and the UI
 * broker from accidentally treating an arbitrary child event as a dialog.
 */

export type ChildExtensionUIDialogRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
    };

export type ChildExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type BlockingExtensionUIMethod = ChildExtensionUIDialogRequest["method"];

export interface ActiveChildToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startedAt: number;
}

export interface ParsedFireAndForgetUIRequest {
  type: "extension_ui_request";
  method: string;
  /** Known methods are observable but intentionally not mirrored into parent UI. */
  known: boolean;
}

export type ExtensionUIParseResult =
  | { kind: "dialog"; request: ChildExtensionUIDialogRequest }
  | ({ kind: "fire-and-forget" } & ParsedFireAndForgetUIRequest)
  | {
      kind: "invalid";
      reason: string;
      method?: string;
      requestId?: string;
      /** True only when it is safe to fail closed with a cancellation response. */
      blocking?: boolean;
      timeout?: number;
    };

const BLOCKING_METHODS = new Set<BlockingExtensionUIMethod>([
  "select",
  "confirm",
  "input",
  "editor",
]);

const FIRE_AND_FORGET_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown, field: string): string | undefined | Error {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : new Error(`${field} must be a string`);
}

function validateTimeout(value: unknown): number | Error | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return new Error("timeout must be a finite positive number");
  }
  return value;
}

/**
 * Parse one raw child event. Unknown methods are intentionally returned as
 * unhandled fire-and-forget events: the current protocol cannot tell whether a
 * future method blocks the child, so guessing a response would be unsafe.
 */
export function parseExtensionUIRequest(value: unknown): ExtensionUIParseResult {
  if (!isRecord(value) || value.type !== "extension_ui_request") {
    return { kind: "invalid", reason: "extension UI request must be an object" };
  }

  const method = typeof value.method === "string" ? value.method : undefined;
  const requestId = typeof value.id === "string" ? value.id : undefined;
  if (!method) {
    return {
      kind: "invalid",
      reason: "extension UI request method must be a string",
      requestId,
    };
  }

  if (!BLOCKING_METHODS.has(method as BlockingExtensionUIMethod)) {
    return {
      kind: "fire-and-forget",
      type: "extension_ui_request",
      method,
      known: FIRE_AND_FORGET_METHODS.has(method),
    };
  }

  if (!nonEmptyString(value.id)) {
    return {
      kind: "invalid",
      reason: "blocking extension UI request id must be a non-empty string",
      method,
      requestId,
      blocking: true,
    };
  }

  if (typeof value.title !== "string") {
    return {
      kind: "invalid",
      reason: "blocking extension UI request title must be a string",
      method,
      requestId: value.id,
      blocking: true,
    };
  }

  const timeout = validateTimeout(value.timeout);
  if (timeout instanceof Error) {
    return {
      kind: "invalid",
      reason: timeout.message,
      method,
      requestId: value.id,
      blocking: true,
    };
  }

  switch (method) {
    case "select": {
      if (!Array.isArray(value.options) || value.options.length === 0 || !value.options.every((option) => typeof option === "string")) {
        return {
          kind: "invalid",
          reason: "select options must be a non-empty array of strings",
          method,
          requestId: value.id,
          blocking: true,
          timeout,
        };
      }
      return {
        kind: "dialog",
        request: {
          type: "extension_ui_request",
          id: value.id,
          method,
          title: value.title,
          options: [...value.options] as string[],
          ...(timeout === undefined ? {} : { timeout }),
        },
      };
    }
    case "confirm": {
      const message = optionalString(value.message, "message");
      if (message instanceof Error) {
        return { kind: "invalid", reason: message.message, method, requestId: value.id, blocking: true, timeout };
      }
      return {
        kind: "dialog",
        request: {
          type: "extension_ui_request",
          id: value.id,
          method,
          title: value.title,
          ...(message === undefined ? {} : { message }),
          ...(timeout === undefined ? {} : { timeout }),
        },
      };
    }
    case "input": {
      const placeholder = optionalString(value.placeholder, "placeholder");
      if (placeholder instanceof Error) {
        return { kind: "invalid", reason: placeholder.message, method, requestId: value.id, blocking: true, timeout };
      }
      return {
        kind: "dialog",
        request: {
          type: "extension_ui_request",
          id: value.id,
          method,
          title: value.title,
          ...(placeholder === undefined ? {} : { placeholder }),
          ...(timeout === undefined ? {} : { timeout }),
        },
      };
    }
    case "editor": {
      const prefill = optionalString(value.prefill, "prefill");
      if (prefill instanceof Error) {
        return { kind: "invalid", reason: prefill.message, method, requestId: value.id, blocking: true, timeout };
      }
      return {
        kind: "dialog",
        request: {
          type: "extension_ui_request",
          id: value.id,
          method,
          title: value.title,
          ...(prefill === undefined ? {} : { prefill }),
          ...(timeout === undefined ? {} : { timeout }),
        },
      };
    }
  }

  // The method is narrowed to the four cases above. This branch keeps the
  // parser total if Pi adds a method to the local union in the future.
  return { kind: "invalid", reason: "unsupported blocking extension UI method", method, requestId: value.id, blocking: true };
}

export function selectResponse(id: string, value: string): ChildExtensionUIResponse {
  return { type: "extension_ui_response", id, value };
}

export function confirmResponse(id: string, confirmed: boolean): ChildExtensionUIResponse {
  return { type: "extension_ui_response", id, confirmed };
}

export function cancelledResponse(id: string): ChildExtensionUIResponse {
  return { type: "extension_ui_response", id, cancelled: true };
}

/**
 * Reserve a small transport margin without making the parent timer
 * authoritative. Pi remains the owner of the actual RPC timeout.
 */
export function conservativeLocalDuration(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout <= 0) return 0;
  const margin = Math.min(timeout, Math.max(50, timeout * 0.1));
  return Math.max(0, timeout - margin);
}

export function localDeadline(receivedAt: number, timeout?: number): number | undefined {
  return timeout === undefined ? undefined : receivedAt + conservativeLocalDuration(timeout);
}

/**
 * Replace terminal controls with visible text. Newline and tab are layout
 * characters; everything else in C0/C1 and DEL is made inert. Escaping the
 * introducer rather than stripping the sequence keeps suspicious content
 * visible to the user while ensuring it cannot move the terminal cursor.
 */
export function sanitizeTerminalText(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n" || char === "\t") {
      result += char;
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      result += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      result += char;
    }
  }
  return result;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable arguments]";
    }
  }
}

export interface FormattedActiveChildToolCall {
  toolName: string;
  toolCallId: string;
  command?: string;
  arguments: string;
}

/** Format untrusted tool data for display without changing protocol values. */
export function formatActiveChildToolCall(call: ActiveChildToolCall): FormattedActiveChildToolCall {
  let command: string | undefined;
  if (call.toolName === "bash" && isRecord(call.args) && typeof call.args.command === "string") {
    command = sanitizeTerminalText(call.args.command);
  }
  return {
    toolName: sanitizeTerminalText(call.toolName),
    toolCallId: sanitizeTerminalText(call.toolCallId),
    command,
    arguments: sanitizeTerminalText(safeStringify(call.args)),
  };
}

export function isBlockingExtensionUIDialog(
  value: unknown,
): value is ChildExtensionUIDialogRequest {
  return parseExtensionUIRequest(value).kind === "dialog";
}
