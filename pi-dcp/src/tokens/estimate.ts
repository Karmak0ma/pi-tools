import type { AgentMessage } from "@earendil-works/pi-agent-core";
export interface TokenEstimate { total: number; categories: { system: number; user: number; assistant: number; thinking: number; toolArguments: number; toolResults: number; images: number; summaries: number; metadata: number; nudges: number }; confidence: "reported" | "heuristic"; }
export function estimateTokens(messages: readonly AgentMessage[]): TokenEstimate { const categories = { system: 0, user: 0, assistant: 0, thinking: 0, toolArguments: 0, toolResults: 0, images: 0, summaries: 0, metadata: 0, nudges: 0 }; for (const message of messages) { if (message.role === "system") { categories.system += contentTokens(message.content); categories.system += textTokens(JSON.stringify({ sections: message.sections, toolsAdded: message.toolsAdded, toolsRemoved: message.toolsRemoved })); } else if (message.role === "user") categories.user += contentTokens(message.content); else if (message.role === "assistant") { for (const part of message.content) { if (part.type === "text") categories.assistant += textTokens(part.text); else if (part.type === "thinking") categories.thinking += textTokens(part.thinking); else categories.toolArguments += textTokens(JSON.stringify(part.arguments)); } } else if (message.role === "toolResult") categories.toolResults += contentTokens(message.content); else if (message.role === "custom") { const text = typeof message.content === "string" ? message.content : contentTokens(message.content); if (message.customType === "pi-dcp.metadata" || message.customType === "pi-dcp.v2.guidance" || message.customType === "pi-dcp.v2.unit") categories.metadata += typeof text === "number" ? text : textTokens(text); else if (message.customType === "pi-dcp.summary" || message.customType === "pi-dcp.v2.summary") categories.summaries += typeof text === "number" ? text : textTokens(text); else if (message.customType === "pi-dcp.nudge" || message.customType === "pi-dcp.v2.nudge") categories.nudges += typeof text === "number" ? text : textTokens(text); else categories.user += typeof text === "number" ? text : textTokens(text); } } return { total: Object.values(categories).reduce((a, b) => a + b, 0), categories, confidence: "heuristic" }; }
/**
 * An image costs this many tokens, whatever its size. Anthropic prices an image by
 * its pixels after a resize: on standard-tier models the long edge is capped at
 * 1,568 px and the cost at about 1,568 tokens, so 1,600 is that cap with a small margin.
 * The base64 payload is never read as text. The provider sees pixels, so counting its
 * characters estimated one screenshot read at hundreds of thousands of tokens.
 * Reading the real dimensions would be more exact for small images, but it needs a
 * PNG/JPEG header parser to save a few hundred tokens per image, so it is not worth
 * the complexity.
 * High-resolution models (Claude 4.7 and later) allow up to about 4,784 tokens per
 * image, so this constant undercounts their images.
 */
export const IMAGE_TOKEN_COST = 1_600;

/**
 * Tokens of one tool result's content, as the request carries it. The compression
 * source and the pruning decisions both measure a result with this function, so a
 * decision and the block that covers its output agree on its size. An absent result
 * counts as 0.
 */
export function estimateToolResultTokens(result: { content: unknown } | undefined): number { return result ? contentTokens(result.content) : 0; }

/**
 * The size a dedup or sweep decision records for one output. It is never 0: the
 * reducer and the stats read a decision of 0 as "already counted by an earlier
 * decision" (commands/sweep.ts, stats.ts). A real output must therefore record at
 * least one token.
 */
export function estimateOutputPruneTokens(result: { content: unknown } | undefined): number { return result ? Math.max(1, estimateToolResultTokens(result)) : 0; }

/**
 * Counts UTF-8 bytes, not characters, so non-ASCII text weighs more than its length.
 * It is the one text rule for the whole file: changing it would move every estimate.
 */
function textTokens(text: string): number { return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4)); }

/**
 * Text parts count their text, not their JSON wrapper: JSON.stringify escapes every
 * quote and newline, which overcounted code and logs. Image parts count IMAGE_TOKEN_COST.
 * Any other part has no known wire form here, so its JSON is the only size available.
 */
function contentTokens(content: unknown): number { if (typeof content === "string") return textTokens(content); if (!Array.isArray(content)) return textTokens(JSON.stringify(content)); return content.reduce((total, part) => total + partTokens(part), 0); }
function partTokens(part: unknown): number { if (part && typeof part === "object") { const { type, text } = part as { type?: unknown; text?: unknown }; if (type === "image") return IMAGE_TOKEN_COST; if (type === "text" && typeof text === "string") return textTokens(text); } return textTokens(JSON.stringify(part)); }
