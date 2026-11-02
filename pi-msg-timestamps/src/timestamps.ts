import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TIMESTAMP_SETTINGS, formatTimestamp, type TimestampSettings } from "./settings.ts";

export { formatTimestamp } from "./settings.ts";

/**
 * Timestamp bookkeeping shared by the Pi hooks and the small unit-test surface.
 *
 * Pi's public Markdown transformer receives only the Markdown string and a
 * message kind. It does not receive the original session entry, so this class
 * keeps a best-effort lookup table keyed by role and text. Session entries fill
 * the table for resumed conversations; lifecycle events fill it for messages
 * that are being created now.
 */

export type TimestampedMessageRole = "user" | "assistant";

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

interface ContentBlockLike {
	type?: unknown;
	text?: unknown;
	id?: unknown;
}

export interface SessionEntryLike {
	type?: unknown;
	timestamp?: unknown;
	message?: MessageLike;
}

const MESSAGE_KEY_SEPARATOR = "\u0000";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function messageRole(message: MessageLike): TimestampedMessageRole | undefined {
	return message.role === "user" || message.role === "assistant" ? message.role : undefined;
}

/** Extract the text that Pi sends through its user/assistant Markdown component. */
export function messageText(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter((block): block is ContentBlockLike => isRecord(block) && block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function messageKey(role: TimestampedMessageRole, text: string): string {
	return `${role}${MESSAGE_KEY_SEPARATOR}${text}`;
}

function messageTextVariants(message: MessageLike): string[] {
	if (typeof message.content === "string") return [message.content];
	if (!Array.isArray(message.content)) return [];

	const textBlocks = message.content
		.filter((block): block is ContentBlockLike => isRecord(block) && block.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.filter(Boolean);

	return textBlocks.length > 1 ? [textBlocks.join("\n"), ...textBlocks] : textBlocks;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function toolCallIds(message: MessageLike): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

	return message.content.flatMap((block): string[] => {
		if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") return [];
		return [block.id];
	});
}

const ANSI_DIM_START = "\u001b[2m";
const ANSI_DIM_END = "\u001b[22m";
const ANSI_ITALIC_START = "\u001b[3m";
const ANSI_ITALIC_END = "\u001b[23m";

/**
 * Escape punctuation that Markdown could otherwise interpret as formatting.
 * Custom timestamp patterns intentionally allow punctuation, so the rendered
 * value must remain literal even when a user chooses characters such as `*`.
 */
function escapeTimestampMarkdown(value: string): string {
	return value.replace(/[\\`*_\[\]<>#|~]/g, "\\$&");
}

/**
 * Apply terminal faint/italic styling to a display-only timestamp.
 *
 * Pi's Markdown transformer does not receive the active Theme, so ordinary
 * message timestamps cannot use the same `thinkingText` color function as a
 * native thinking block. ANSI faint + italic is the closest theme-independent
 * equivalent. It changes emphasis, not the terminal's actual font size.
 */
export function subduedTimestamp(
	timestamp: number,
	settings: TimestampSettings = DEFAULT_TIMESTAMP_SETTINGS,
): string {
	const value = escapeTimestampMarkdown(formatTimestamp(timestamp, settings));
	return `${ANSI_DIM_START}${ANSI_ITALIC_START}${value}${ANSI_ITALIC_END}${ANSI_DIM_END}`;
}

/** Apply the same faint treatment to a timestamp rendered by a themed Text. */
export function dimTimestampText(value: string): string {
	return `${ANSI_DIM_START}${value}${ANSI_DIM_END}`;
}

/**
 * Append a display-only Markdown footer. A plain paragraph is used instead of
 * a blockquote because Pi renders every blockquote line with a visible `│`
 * border. Two newlines keep the footer visually separated from the message.
 *
 * Pi passes the Markdown transformer the content width available to the
 * message. Non-breaking spaces provide right alignment without triggering
 * Markdown's four-space indented-code-block rule.
 */
export function appendTimestamp(
	markdown: string,
	timestamp: number,
	settings: TimestampSettings = DEFAULT_TIMESTAMP_SETTINGS,
	availableWidth?: number,
): string {
	const body = markdown.trimEnd();
	const footer = subduedTimestamp(timestamp, settings);
	// `subduedTimestamp()` escapes Markdown punctuation. Those escape
	// backslashes disappear during parsing, so measure the displayed value,
	// not the source string, when calculating the left padding.
	const footerWidth = visibleWidth(formatTimestamp(timestamp, settings));
	const leftPadding =
		availableWidth === undefined ? "" : "\u00a0".repeat(Math.max(0, availableWidth - footerWidth));
	const alignedFooter = `${leftPadding}${footer}`;
	return body ? `${body}\n\n${alignedFooter}` : alignedFooter;
}

export class TimestampStore {
	private readonly messageTimestamps = new Map<string, number>();
	private readonly activeMessageTimestamps = new Map<TimestampedMessageRole, number>();
	private readonly toolTimestamps = new Map<string, number>();

	/** Rebuild all persisted associations when Pi loads or changes the session branch. */
	loadBranch(entries: readonly SessionEntryLike[]): void {
		this.messageTimestamps.clear();
		this.activeMessageTimestamps.clear();
		this.toolTimestamps.clear();

		for (const entry of entries) {
			if (entry.type !== "message" || !entry.message) continue;

			const timestamp = parseTimestamp(entry.timestamp);
			if (timestamp === undefined) continue;

			this.recordMessage(entry.message, timestamp);
			for (const toolCallId of toolCallIds(entry.message)) {
				// The assistant entry is the persisted point at which Pi issued the call.
				// Do not replace it with the later tool-result entry timestamp.
				if (!this.toolTimestamps.has(toolCallId)) this.toolTimestamps.set(toolCallId, timestamp);
			}
		}
	}

	/** Record a message that has just started, including an empty streaming message. */
	startMessage(message: MessageLike, timestamp = Date.now()): void {
		const role = messageRole(message);
		if (!role) return;

		this.activeMessageTimestamps.set(role, timestamp);
		this.recordMessage(message, timestamp);
	}

	/** Record the final text while retaining the original start time when available. */
	endMessage(message: MessageLike, timestamp = Date.now()): void {
		const role = messageRole(message);
		if (!role) return;

		this.recordMessage(message, this.activeMessageTimestamps.get(role) ?? timestamp);
		this.activeMessageTimestamps.delete(role);
	}

	recordMessage(message: MessageLike, timestamp: number): void {
		const role = messageRole(message);
		const texts = messageTextVariants(message);
		if (!role || texts.length === 0) return;

		// Keep the aggregate form and every individual text block. Assistant
		// messages can contain several Markdown components around tool calls, and
		// each component must resolve to the same parent-message timestamp.
		for (const text of texts) {
			// Keep both forms because Pi trims assistant text before constructing its
			// Markdown component, while user text is passed through more directly.
			this.messageTimestamps.set(messageKey(role, text), timestamp);
			this.messageTimestamps.set(messageKey(role, text.trim()), timestamp);
		}
	}

	/** Return the persisted/event timestamp, or a stable active-stream timestamp. */
	getMessageTimestamp(role: TimestampedMessageRole, markdown: string): number {
		const exact = this.messageTimestamps.get(messageKey(role, markdown));
		if (exact !== undefined) return exact;

		const trimmed = this.messageTimestamps.get(messageKey(role, markdown.trim()));
		if (trimmed !== undefined) return trimmed;

		return this.activeMessageTimestamps.get(role) ?? Date.now();
	}

	/** Record the instant at which a tool execution began. */
	recordToolStart(toolCallId: string, timestamp = Date.now()): void {
		this.toolTimestamps.set(toolCallId, timestamp);
	}

	getToolTimestamp(toolCallId: string, fallback = Date.now()): number {
		const timestamp = this.toolTimestamps.get(toolCallId);
		if (timestamp !== undefined) return timestamp;

		this.toolTimestamps.set(toolCallId, fallback);
		return fallback;
	}

	clear(): void {
		this.messageTimestamps.clear();
		this.activeMessageTimestamps.clear();
		this.toolTimestamps.clear();
	}
}
