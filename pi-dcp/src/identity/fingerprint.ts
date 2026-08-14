import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalJson, canonicalPlainObject, isPlainObject } from "../util/canonical-json.ts";
import { sha256 } from "../util/hash.ts";

export function fingerprintMessage(message: AgentMessage): string {
  const value = fingerprintValue(message);
  return sha256(canonicalJson(value));
}

export function fingerprintValue(message: AgentMessage): unknown {
  if (message.role === "user") return { role: "user", content: contentFingerprint(message.content) };
  if (message.role === "assistant") {
    return {
      role: "assistant", content: message.content.map((part) => {
        if (part.type === "text") return { type: "text", text: normalizeText(part.text) };
        if (part.type === "thinking") return { type: "thinking", thinkingHash: sha256(normalizeText(part.thinking)) };
        return { type: "toolCall", id: part.id, name: part.name, arguments: canonicalPlainObject(part.arguments) };
      }),
      provider: message.provider, model: message.model, api: message.api, stopReason: message.stopReason,
    };
  }
  if (message.role === "toolResult") return {
    role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName,
    isError: message.isError, content: contentFingerprint(message.content),
    detailsShape: shape(message.details),
  };
  if (message.role === "custom") return { role: "custom", customType: message.customType, content: contentFingerprint(message.content), display: message.display };
  if (message.role === "compactionSummary") return { role: "compactionSummary", summary: normalizeText(message.summary) };
  if (message.role === "branchSummary") return { role: "branchSummary", fromId: message.fromId, summary: normalizeText(message.summary) };
  return { role: (message as { role?: unknown }).role, value: shape(message) };
}

export function normalizeText(text: string): string { return text.replace(/\r\n?/g, "\n"); }

function contentFingerprint(content: unknown): unknown {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return shape(content);
  return content.map((part) => {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") return { type: "text", text: normalizeText((part as { text: string }).text) };
    if (part && typeof part === "object" && (part as { type?: string }).type === "image") {
      const image = part as { mimeType?: string; data?: string };
      return { type: "image", mimeType: image.mimeType, hash: sha256(image.data || "") };
    }
    return shape(part);
  });
}

function shape(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" ? "function" : value;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => shape(item, seen));
  if (isPlainObject(value)) { const result: Record<string, unknown> = {}; for (const key of Object.keys(value).sort()) result[key] = shape(value[key], seen); return result; }
  return Object.prototype.toString.call(value);
}
