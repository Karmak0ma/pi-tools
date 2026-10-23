import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SharedProviderEntry } from "pi-usage-vflo/src/index.js";
import sidebarVflo from "../src/index.js";

const { readEntry } = vi.hoisted(() => ({ readEntry: vi.fn() }));
vi.mock("pi-usage-vflo/src/index.js", () => ({
	adapterForProvider: (provider: string) => ["anthropic", "openai-codex"].includes(provider)
		? { semantics: { kind: "consumer-subscription" } } : undefined,
	readSharedProviderEntry: readEntry,
}));
// Keep the real extension event handlers and overlay frame cache. Replace only
// external I/O and terminal layout so provider changes are deterministic.
vi.mock("node:fs/promises", () => ({ readFile: vi.fn().mockRejectedValue(new Error("no config")), mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("../src/diff-refresh.js", () => ({ createDiffRefreshController: () => ({ setActive() {}, dispose() {}, agentSettled() {} }) }));
vi.mock("../src/overlay-close.js", () => ({ closeOverlayCustomUi() {} }));
vi.mock("../src/split-pane.js", () => ({ createSplitPaneController: () => ({ attach() {}, show() {}, dispose() {}, requestRender() {}, overlayOptions() {} }) }));

const NOW = 1_800_000_000_000;
const report = (providerId: string, hours: number, remaining: number): SharedProviderEntry => ({
	capturedAt: NOW,
	report: {
		providerId, providerName: providerId, capturedAt: NOW, source: "fixture",
		semantics: { kind: "consumer-subscription", label: "Subscription" },
		buckets: [{ id: `${providerId}:5h`, label: "5-hour window", remaining, unit: "percent", resetsAt: NOW / 1000 + hours * 3600 }],
		metrics: [],
	},
});

async function harness() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let model = { provider: "anthropic", id: "claude", name: "Claude" };
	let overlay!: { render(width: number): string[] };
	const ctx = {
		get model() { return model; },
		mode: "tui", hasUI: true, thinkingLevel: "medium", cwd: "/fixture",
		sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined,
		ui: {
			setWidget() {}, onTerminalInput: () => () => {},
			custom: (factory: Function) => {
				overlay = factory({ terminal: { rows: 80 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, () => {});
				return new Promise(() => {});
			},
		},
	} as unknown as ExtensionContext;
	sidebarVflo({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand() {}, registerShortcut() {} } as unknown as ExtensionAPI);
	await handlers.get("session_start")!({}, ctx);
	await Promise.resolve();
	return {
		render: () => overlay.render(72).join("\n"),
		switchProvider(provider: string) {
			const previousModel = model;
			model = { provider, id: provider, name: provider };
			return handlers.get("model_select")!({ model, previousModel, source: "set" }, ctx);
		},
		close: () => handlers.get("session_shutdown")!({}, ctx),
	};
}

describe("subscription provider switches through the sidebar overlay", () => {
	afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

	it("never shows Anthropic quota while the Codex cache read is pending", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		readEntry.mockResolvedValueOnce(report("anthropic", 2, 12));
		const app = await harness();
		try {
			expect(app.render()).toContain("(2h until reset)");
			let finish!: (entry: SharedProviderEntry) => void;
			readEntry.mockImplementationOnce(() => new Promise<SharedProviderEntry>((resolve) => { finish = resolve; }));
			app.switchProvider("openai-codex");
			const pending = app.render();
			finish(report("openai-codex", 4, 87));
			await Promise.resolve();
			expect(readEntry).toHaveBeenLastCalledWith("openai-codex");
			expect(app.render()).toContain("(4h until reset)");
			expect(app.render()).toContain("87.0%");
			expect(pending).not.toContain("(2h until reset)");
			expect(pending).not.toContain("12.0%");
			expect(pending).toContain("Waiting for usage data");
		} finally { app.close(); }
	});

	it("discards a late Codex read after switching back to Anthropic", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		readEntry.mockResolvedValueOnce(report("anthropic", 2, 12));
		const app = await harness();
		try {
			let finishCodex!: (entry: SharedProviderEntry) => void;
			readEntry.mockImplementationOnce(() => new Promise<SharedProviderEntry>((resolve) => { finishCodex = resolve; }));
			app.switchProvider("openai-codex");
			readEntry.mockResolvedValueOnce(report("anthropic", 1, 11));
			app.switchProvider("anthropic");
			await Promise.resolve();
			expect(app.render()).toContain("(1h until reset)");
			finishCodex(report("openai-codex", 4, 87));
			await Promise.resolve();
			expect(app.render()).toContain("(1h until reset)");
			expect(app.render()).toContain("11.0%");
			expect(app.render()).not.toContain("87.0%");
		} finally { app.close(); }
	});

	it("updates the countdown in the cached overlay frame even when usage data is unchanged", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
		readEntry.mockResolvedValueOnce(report("anthropic", 2, 12));
		const app = await harness();
		try {
			expect(app.render()).toContain("(2h until reset)");
			clock.mockReturnValue(NOW + 3600_000);
			expect(app.render()).toContain("(1h until reset)");
		} finally { app.close(); }
	});
});
