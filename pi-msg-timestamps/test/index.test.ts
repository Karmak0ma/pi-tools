import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { subduedTimestamp } from "../src/timestamps.ts";

type Handler = (...args: any[]) => unknown;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	let markdownTransformer: ((markdown: string, context: any) => string) | undefined;
	let toolRendererResolver: ((toolName: string, next: () => any) => any) | undefined;
	const commands = new Map<string, any>();

	const pi = {
		on(event: string, handler: Handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
			return () => undefined;
		},
		registerMarkdownTransformer(transformer: (markdown: string, context: any) => string) {
			markdownTransformer = transformer;
		},
		registerToolRenderer(resolver: (toolName: string, next: () => any) => any) {
			toolRendererResolver = resolver;
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		handlers,
		getMarkdownTransformer: () => markdownTransformer,
		getToolRendererResolver: () => toolRendererResolver,
		getCommand: (name: string) => commands.get(name),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Pi extension wiring", () => {
	it("adds a timestamp to a newly-created user message", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1234);
		const fake = createFakePi();
		extension(fake.pi);

		for (const handler of fake.handlers.get("message_start") ?? []) {
			handler({ message: { role: "user", content: "Hello" } });
		}

		const transformer = fake.getMarkdownTransformer();
		expect(transformer).toBeDefined();
		const rendered = transformer!("Hello", {
			messageType: "user",
			isStreaming: false,
			availableWidth: 80,
		});

		expect(rendered).toContain("Hello");
		const timestamp = subduedTimestamp(1234);
		expect(rendered).toContain(`${"\u00a0".repeat(80 - visibleWidth(timestamp))}${timestamp}`);
		expect(rendered).not.toContain("│");
		expect(rendered).not.toContain("⏱");
	});

	it("delegates tool rendering and puts the timestamp inside the returned component", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1234);
		const fake = createFakePi();
		extension(fake.pi);

		const resolver = fake.getToolRendererResolver();
		expect(resolver).toBeDefined();

		const theme = {
			fg: (_color: string, text: string) => text,
			italic: (text: string) => text,
		} as unknown as Theme;
		const base = {
			renderCall: () => new Text("call", 0, 0),
			renderResult: () => new Text("result", 0, 0),
		};
		const wrapped = resolver!("demo", () => base);
		expect(wrapped).toBeDefined();

		const context = {
			toolCallId: "tool-1",
			isPartial: true,
			lastComponent: undefined,
			state: {},
		};
		const pending = wrapped.renderCall({}, theme, context);
		const pendingLines = pending.render(80);
		const pendingTimestampLine = pendingLines.findIndex((line: string) => line.includes("01:00:01"));
		expect(pendingTimestampLine).toBeGreaterThan(0);
		expect(pendingLines[pendingTimestampLine - 1]?.trim()).toBe("");
		expect(stripTerminalSequences(pendingLines[pendingTimestampLine] ?? "").indexOf("01:00:01")).toBe(72);
		expect(visibleWidth(pendingLines[pendingTimestampLine] ?? "")).toBe(80);
		expect(pending.render(80).join("\n")).not.toContain("⏱");

		const result = wrapped.renderResult(
			{ content: [{ type: "text", text: "done" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			{ ...context, isPartial: false },
		);
		expect(result.render(80).join("\n")).toContain("result");
		const resultLines = result.render(80);
		const resultTimestampLine = resultLines.findIndex((line: string) => line.includes("01:00:01"));
		expect(resultTimestampLine).toBeGreaterThan(0);
		expect(resultLines[resultTimestampLine - 1]?.trim()).toBe("");
		expect(stripTerminalSequences(resultLines[resultTimestampLine] ?? "").indexOf("01:00:01")).toBe(72);
		expect(visibleWidth(resultLines[resultTimestampLine] ?? "")).toBe(80);
		expect(pending.render(80).join("\n")).not.toContain("01:00:01");
	});

	it("registers a command and reports when no dialog UI is available", async () => {
		const fake = createFakePi();
		extension(fake.pi);

		const command = fake.getCommand("timestamp-settings");
		expect(command?.description).toContain("Configure timestamp");

		const notify = vi.fn();
		await command.handler("", { hasUI: false, ui: { notify } });
		expect(notify).toHaveBeenCalledWith(
			"/timestamp-settings requires an interactive or RPC UI",
			"error",
		);
	});

	it("saves settings selected through the command UI", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "pi-msg-timestamps-"));
		const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = configDir;

		try {
			const fake = createFakePi();
			extension(fake.pi);
			const command = fake.getCommand("timestamp-settings");
			const select = vi
				.fn()
				.mockResolvedValueOnce("on")
				.mockResolvedValueOnce("MM/DD/YYYY (01/02/2025)")
				.mockResolvedValueOnce("HH:mm (15:04)");

			await command.handler("", {
				hasUI: true,
				ui: { select, input: vi.fn(), notify: vi.fn() },
			});

			expect(JSON.parse(await readFile(join(configDir, "pi-msg-timestamps.json"), "utf8"))).toEqual({
			showDate: true,
			dateFormat: "MM/DD/YYYY",
			timeFormat: "HH:mm",
		});
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
			await rm(configDir, { recursive: true, force: true });
		}
	});
});
