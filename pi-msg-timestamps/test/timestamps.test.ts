import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_TIMESTAMP_SETTINGS,
	formatTimestamp,
	isValidDateFormat,
	isValidTimeFormat,
	normalizeTimestampSettings,
	TimestampSettingsStore,
} from "../src/settings.ts";
import { appendTimestamp, subduedTimestamp, TimestampStore } from "../src/timestamps.ts";

const markdownTheme = {
	heading: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => `│ ${text}`,
	hr: (text: string) => text,
	listBullet: (text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

afterEach(() => {
	vi.useRealTimers();
});

describe("timestamp formatting", () => {
	it("formats only the local time by default", () => {
		const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5);
		const date = new Date(timestamp);
		const expected = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;

		expect(formatTimestamp(timestamp)).toBe(expected);
	});

	it("formats optional dates and custom date/time patterns", () => {
		const timestamp = Date.UTC(2025, 0, 2, 15, 4, 5);
		const date = new Date(timestamp);
		const settings = {
			showDate: true,
			dateFormat: "DD/MM/YYYY",
			timeFormat: "h:mm A",
		};

		expect(formatTimestamp(timestamp, settings)).toBe(
			`${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()} ` +
				`${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() < 12 ? "AM" : "PM"}`,
		);
	});

	it("keeps custom two-digit years padded", () => {
		const date = new Date(0);
		date.setFullYear(5, 0, 2);
		date.setHours(3, 4, 5, 0);

		expect(
			formatTimestamp(date.getTime(), {
				showDate: true,
				dateFormat: "YY-M-D",
				timeFormat: "HH:mm",
			}),
		).toBe("05-1-2 03:04");
	});

	it("appends a display-only footer without a blockquote border or icon", () => {
		const rendered = appendTimestamp("Hello\n", 0);

		expect(rendered).toBe(`Hello\n\n${subduedTimestamp(0)}`);
		expect(rendered).not.toContain("> _");
		expect(rendered).not.toContain("⏱");
	});

	it("renders the footer without a Markdown quote gutter", () => {
		const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5);
		const settings = {
			showDate: true,
			dateFormat: "YYYY*MM*DD",
			timeFormat: "HH:mm",
		};
		const markdown = new Markdown(appendTimestamp("Hello", timestamp, settings, 80), 0, 0, markdownTheme);
		const lines = markdown.render(80).map(stripAnsi);

		expect(lines.some((line) => line.includes("│"))).toBe(false);
		expect(lines.some((line) => line.trim() === "")).toBe(true);
		const formatted = formatTimestamp(timestamp, settings);
		const timestampLine = lines.find((line) => line.includes(formatted));
		expect(timestampLine).toBeDefined();
		expect(timestampLine?.indexOf(formatted)).toBe(80 - visibleWidth(formatted));
	});

	it("validates supported custom patterns and normalizes invalid settings", () => {
		expect(isValidDateFormat("YYYY.MM.DD")).toBe(true);
		expect(isValidDateFormat("YYYY-MM-DD HH:mm")).toBe(false);
		expect(isValidTimeFormat("h:mm:ss A")).toBe(true);
		expect(isValidTimeFormat("YYYY-MM-DD")).toBe(false);
		expect(normalizeTimestampSettings({ showDate: true, timeFormat: "not valid" })).toEqual({
			...DEFAULT_TIMESTAMP_SETTINGS,
			showDate: true,
		});
	});
});

describe("TimestampSettingsStore", () => {
	it("persists and reloads display settings", async () => {
		const path = `/tmp/pi-msg-timestamps-test-${process.pid}-${Date.now()}.json`;
		const first = new TimestampSettingsStore(path);
		first.set({ showDate: true, dateFormat: "MM/DD/YYYY", timeFormat: "HH:mm" });
		await first.save();

		const second = new TimestampSettingsStore(path);
		await second.load();
		expect(second.get()).toEqual({ showDate: true, dateFormat: "MM/DD/YYYY", timeFormat: "HH:mm" });

		await import("node:fs/promises").then(({ unlink }) => unlink(path));
	});
});

describe("TimestampStore", () => {
	it("reuses the message start time for a streamed final message", () => {
		const store = new TimestampStore();
		store.startMessage({ role: "assistant", content: "partial" }, 1000);
		store.endMessage({ role: "assistant", content: "final answer" }, 2000);

		expect(store.getMessageTimestamp("assistant", "final answer")).toBe(1000);
	});

	it("uses one timestamp for every assistant Markdown block", () => {
		const store = new TimestampStore();
		store.loadBranch([
			{
				type: "message",
				timestamp: "2025-01-02T03:04:05.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Before the tool." },
						{ type: "toolCall", id: "tool-1" },
						{ type: "text", text: "After the tool." },
					],
				},
			},
		]);

		const expected = Date.parse("2025-01-02T03:04:05.000Z");
		expect(store.getMessageTimestamp("assistant", "Before the tool.")).toBe(expected);
		expect(store.getMessageTimestamp("assistant", "After the tool.")).toBe(expected);
	});

	it("reconstructs message and tool times from session entries", () => {
		const store = new TimestampStore();
		store.loadBranch([
			{
				type: "message",
				timestamp: "2025-01-02T03:04:05.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the file." },
						{ type: "toolCall", id: "tool-1" },
					],
				},
			},
		]);

		const expected = Date.parse("2025-01-02T03:04:05.000Z");
		expect(store.getMessageTimestamp("assistant", "I will inspect the file.")).toBe(expected);
		expect(store.getToolTimestamp("tool-1")).toBe(expected);
	});

	it("keeps a fallback tool timestamp stable", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1234);
		const store = new TimestampStore();

		const first = store.getToolTimestamp("tool-1");
		vi.setSystemTime(5678);
		const second = store.getToolTimestamp("tool-1");

		expect(first).toBe(1234);
		expect(second).toBe(1234);
	});
});
