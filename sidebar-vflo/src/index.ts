import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	adapterForProvider,
	queryProviderUsage,
	resolveUsageAuth,
	type UsageReport,
} from "@narumitw/pi-usage/src/index.js";
import { matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { renderSidebar, type SidebarTheme } from "./render.js";
import {
	applySubagentDetails,
	finishSubagents,
	normalizeTodoDetails,
	panelEnabled,
	parseConfig,
	subagentItemsFromStart,
	sumBranchUsage,
} from "./state.js";
import { createSplitPaneController, type SplitPaneController } from "./split-pane.js";
import {
	DEFAULT_CONFIG,
	type ActivityState,
	type SidebarConfig,
	type SidebarPanelId,
	type SidebarSnapshot,
	type SubagentItem,
	type TodoItem,
} from "./types.js";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "sidebar-vflo.json");

interface Runtime {
	ctx: ExtensionContext;
	config: SidebarConfig;
	sidebarVisible: boolean;
	activity: SidebarSnapshot["activity"];
	todos: TodoItem[];
	subagents: SubagentItem[];
	activeToolCalls: Map<string, string>;
	subagentBatches: Map<string, SubagentItem[]>;
	subscriptionRemaining?: number;
	usageRefresh?: AbortController;
	overlayGeneration: number;
	overlayStarting: boolean;
	tui?: TUI;
	split?: SplitPaneController;
	overlayHandle?: OverlayHandle;
	closeOverlay?: () => void;
}

const isCurrent = (runtime: Runtime | undefined, ctx: ExtensionContext): runtime is Runtime =>
	runtime !== undefined && runtime.ctx.sessionManager === ctx.sessionManager;

async function readConfig(): Promise<SidebarConfig> {
	try {
		const text = await readFile(CONFIG_PATH, "utf8");
		return parseConfig(JSON.parse(text) as unknown, DEFAULT_CONFIG);
	} catch {
		return { ...DEFAULT_CONFIG, panels: { ...DEFAULT_CONFIG.panels } };
	}
}

async function writeConfig(config: SidebarConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function todoStateFromBranch(ctx: ExtensionContext): TodoItem[] {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as unknown as Record<string, unknown>;
		const message = entry?.type === "message" && typeof entry.message === "object" && entry.message !== null
			? (entry.message as Record<string, unknown>)
			: undefined;
		if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
		const todos = normalizeTodoDetails(message.details);
		if (todos !== undefined) return todos;
	}
	return [];
}

function snapshot(runtime: Runtime): SidebarSnapshot {
	const model = runtime.ctx.model;
	const context = runtime.ctx.getContextUsage();
	return {
		model: model
			? {
					provider: model.provider,
					id: model.id,
					name: model.name,
					subscriptionRemaining: runtime.subscriptionRemaining,
				  }
			: undefined,
		thinkingLevel: runtime.ctx.thinkingLevel,
		activity: runtime.activity,
		context,
		usage: sumBranchUsage(runtime.ctx.sessionManager.getBranch()),
		todos: runtime.todos,
		subagents: runtime.subagents,
	};
}

function subscriptionRemaining(report: UsageReport): number | undefined {
	const buckets = report.buckets.filter((bucket) => bucket.unit === "percent" && bucket.remaining !== undefined);
	if (report.semantics.kind !== "consumer-subscription" || buckets.length === 0) return undefined;
	return Math.max(0, Math.min(100, Math.min(...buckets.map((bucket) => bucket.remaining as number))));
}

async function refreshSubscription(runtime: Runtime): Promise<void> {
	runtime.usageRefresh?.abort();
	runtime.subscriptionRemaining = undefined;
	const model = runtime.ctx.model;
	const adapter = adapterForProvider(model?.provider);
	if (!model || !adapter || adapter.semantics.kind !== "consumer-subscription") {
		requestRender(runtime);
		return;
	}
	const controller = new AbortController();
	runtime.usageRefresh = controller;
	try {
		const auth = await resolveUsageAuth(runtime.ctx, adapter);
		if (!auth) return;
		const report = await queryProviderUsage(adapter, auth, controller.signal, 15_000);
		if (controller.signal.aborted || runtime.ctx.model !== model) return;
		runtime.subscriptionRemaining = subscriptionRemaining(report);
		requestRender(runtime);
	} catch {
		// pi-usage owns the authoritative status; the sidebar simply omits unavailable data.
	} finally {
		if (runtime.usageRefresh === controller) runtime.usageRefresh = undefined;
	}
}

function requestRender(runtime: Runtime): void {
	runtime.tui?.requestRender();
	runtime.split?.requestRender();
}

function refreshActivity(runtime: Runtime, state: ActivityState, label: string): void {
	runtime.activity = { state, label, activeTools: [...runtime.activeToolCalls.values()] };
}

function refreshSubagents(runtime: Runtime): void {
	runtime.subagents = [...runtime.subagentBatches.values()].flat();
}

function suppressTodoWidget(runtime: Runtime): void {
	if (!runtime.sidebarVisible || !panelEnabled(runtime.config, "todos") || !runtime.ctx.hasUI) return;
	// rpiv-todo intentionally uses this stable widget id. Clearing it here
	// makes the sidebar the one visible TODO presentation while it is enabled.
	runtime.ctx.ui.setWidget("rpiv-todos", undefined);
}

async function openSettings(runtime: Runtime): Promise<void> {
	if (runtime.ctx.mode !== "tui") {
		runtime.ctx.ui.notify("Sidebar settings require TUI mode", "warning");
		return;
	}
	const panelLabels: Array<[SidebarPanelId, string]> = [
		["model", "Model"], ["activity", "Activity"], ["context", "Context"],
		["usage", "Session usage"], ["todos", "Todos"], ["subagents", "Subagents"],
	];
	const presets: SidebarConfig["colorPreset"][] = ["monokai", "catppuccin", "dracula"];
	await runtime.ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let selected = 0;
		const items = panelLabels.length + 1;
		const render = (width: number): string[] => {
			const lines = [theme.bold("Sidebar VFLO settings"), "", "Color preset: " + runtime.config.colorPreset, ""];
			for (let index = 0; index < items; index += 1) {
				const isPreset = index === 0;
				const label = isPreset ? "Color preset" : panelLabels[index - 1]?.[1] ?? "";
				const value = isPreset ? runtime.config.colorPreset : runtime.config.panels[panelLabels[index - 1]?.[0] ?? "model"] ? "on" : "off";
				lines.push(`${selected === index ? "❯" : " "} ${label.padEnd(14)} ${value}`);
			}
			lines.push("", "↑/↓ select  Enter change  Esc close");
			return lines.map((line) => line.length > width ? line.slice(0, width) : line);
		};
		return {
			render,
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { done(); return; }
				if (matchesKey(data, "up") || data === "k") selected = (selected + items - 1) % items;
				else if (matchesKey(data, "down") || data === "j") selected = (selected + 1) % items;
				else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
					if (selected === 0) {
						const current = presets.indexOf(runtime.config.colorPreset);
						runtime.config.colorPreset = presets[(current + 1) % presets.length] ?? "monokai";
					} else {
						const panel = panelLabels[selected - 1]?.[0];
						if (panel) runtime.config.panels[panel] = !runtime.config.panels[panel];
					}
					void writeConfig(runtime.config);
					requestRender(runtime);
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 48, maxHeight: "80%", margin: 2 } });
}

function setSidebarVisible(runtime: Runtime, visible: boolean): void {
	runtime.sidebarVisible = visible;
	runtime.config.showSidebarOnStartup = visible;
	if (visible) {
		if (runtime.split) runtime.split.show();
		else startOverlay(runtime);
		runtime.overlayHandle?.setHidden(false);
		suppressTodoWidget(runtime);
	} else {
		closeOverlay(runtime);
	}
	requestRender(runtime);
}

function startOverlay(runtime: Runtime): void {
	if (runtime.ctx.mode !== "tui" || !runtime.sidebarVisible || runtime.split || runtime.overlayStarting) return;
	const generation = ++runtime.overlayGeneration;
	const split = createSplitPaneController({
		defaultSidebarWidth: runtime.config.width,
		onWarning: (message) => runtime.ctx.ui.notify(message, "warning"),
	});
	runtime.split = split;
	runtime.overlayStarting = true;
	void runtime.ctx.ui
		.custom<void>(
			(tui, theme, _keybindings, done) => {
				if (!runtime.sidebarVisible || runtime.split !== split || runtime.overlayGeneration !== generation) {
					done();
					return { render: () => [], invalidate() {} };
				}
				runtime.tui = tui;
				split.attach(tui);
				runtime.closeOverlay = () => done();
				split.show();
				const sidebarTheme: SidebarTheme = {
					fg: (color, text) => theme.fg(color, text),
					bold: (text) => theme.bold(text),
					preset: runtime.config.colorPreset,
				};
				return {
					render(width: number): string[] {
						sidebarTheme.preset = runtime.config.colorPreset;
						return renderSidebar(snapshot(runtime), runtime.config, sidebarTheme, width, tui.terminal.rows);
					},
					invalidate() {},
				};
			},
			{
				overlay: true,
				overlayOptions: () => split.overlayOptions(),
				onHandle: (handle) => {
					if (runtime.overlayGeneration !== generation) {
						handle.hide();
						return;
					}
					runtime.overlayHandle = handle;
				},
			},
		)
		.then(() => {
			if (runtime.overlayGeneration !== generation) return;
			runtime.closeOverlay = undefined;
			runtime.overlayHandle = undefined;
			runtime.tui = undefined;
			runtime.split = undefined;
		})
		.catch((error: unknown) => {
			if (runtime.overlayGeneration === generation) {
				runtime.closeOverlay = undefined;
				runtime.overlayHandle = undefined;
				runtime.tui = undefined;
				runtime.split?.dispose();
				runtime.split = undefined;
				runtime.ctx.ui.notify(`Sidebar unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		})
		.finally(() => {
			if (runtime.overlayGeneration === generation || (runtime.split === undefined && !runtime.sidebarVisible)) {
				runtime.overlayStarting = false;
			}
		});
}

function closeOverlay(runtime: Runtime): void {
	runtime.overlayGeneration += 1;
	runtime.closeOverlay?.();
	runtime.closeOverlay = undefined;
	runtime.overlayHandle = undefined;
	runtime.overlayStarting = false;
	runtime.split?.dispose();
	runtime.split = undefined;
	runtime.tui = undefined;
}

function disposeRuntime(runtime: Runtime): void {
	runtime.usageRefresh?.abort();
	closeOverlay(runtime);
}

function runtimeFor(current: Runtime | undefined, ctx: ExtensionContext): Runtime | undefined {
	return isCurrent(current, ctx) ? current : undefined;
}

export default function sidebarVflo(pi: ExtensionAPI): void {
	let current: Runtime | undefined;

	const persist = async (runtime: Runtime): Promise<void> => {
		try {
			await writeConfig(runtime.config);
		} catch (error) {
			runtime.ctx.ui.notify(`Could not save sidebar settings: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (current) disposeRuntime(current);
		const config = await readConfig();
		const runtime: Runtime = {
			ctx,
			config,
			sidebarVisible: ctx.mode === "tui" && config.showSidebarOnStartup,
			activity: { state: "ready", label: "Ready", activeTools: [] },
			todos: todoStateFromBranch(ctx),
			subagents: [],
			activeToolCalls: new Map(),
			subagentBatches: new Map(),
			overlayGeneration: 0,
			overlayStarting: false,
		};
		current = runtime;
		startOverlay(runtime);
		void refreshSubscription(runtime);
		if (runtime.sidebarVisible) {
			suppressTodoWidget(runtime);
			queueMicrotask(() => suppressTodoWidget(runtime));
		}
	});

	pi.registerCommand("sidebar", {
		description: "Show, hide, or toggle the Sidebar VFLO dock",
		handler: async (args, ctx) => {
			const runtime = runtimeFor(current, ctx);
			if (!runtime) return;
			const action = args.trim().toLowerCase();
			if (!action) { await openSettings(runtime); return; }
			const visible = action === "show" ? true : action === "hide" ? false : !runtime.sidebarVisible;
			if (!["show", "hide", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /sidebar [show|hide|toggle]", "warning");
				return;
			}
			setSidebarVisible(runtime, visible);
			await persist(runtime);
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Toggle Sidebar VFLO",
		handler: async (ctx) => {
			const runtime = runtimeFor(current, ctx);
			if (!runtime) return;
			setSidebarVisible(runtime, !runtime.sidebarVisible);
			await persist(runtime);
		},
	});

	pi.registerCommand("sidebar-reset", {
		description: "Restore Sidebar VFLO panel defaults",
		handler: async (_args, ctx) => {
			const runtime = runtimeFor(current, ctx);
			if (!runtime) return;
			runtime.config = { ...DEFAULT_CONFIG, panels: { ...DEFAULT_CONFIG.panels } };
			runtime.split?.setSidebarWidth(DEFAULT_CONFIG.width);
			setSidebarVisible(runtime, DEFAULT_CONFIG.showSidebarOnStartup);
			if (runtime.sidebarVisible) suppressTodoWidget(runtime);
			requestRender(runtime);
			await persist(runtime);
			ctx.ui.notify("Sidebar VFLO settings reset", "info");
		},
	});

	pi.on("session_tree", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		runtime.todos = todoStateFromBranch(ctx);
		requestRender(runtime);
	});

	pi.on("agent_start", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		runtime.activeToolCalls.clear();
		refreshActivity(runtime, "working", "Thinking");
		requestRender(runtime);
	});
	pi.on("turn_start", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		runtime.activeToolCalls.clear();
		refreshActivity(runtime, "working", "Thinking");
		requestRender(runtime);
	});
	pi.on("before_provider_request", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		refreshActivity(runtime, "working", "Responding");
		requestRender(runtime);
	});
	pi.on("message_update", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		refreshActivity(runtime, "working", "Responding");
		requestRender(runtime);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		runtime.activeToolCalls.set(event.toolCallId, event.toolName);
		refreshActivity(runtime, "working", `Running ${event.toolName}`);
		if (event.toolName === "subagent") {
			runtime.subagentBatches.set(event.toolCallId, subagentItemsFromStart(event.toolCallId, event.args));
			refreshSubagents(runtime);
		}
		requestRender(runtime);
	});
	pi.on("tool_execution_update", (event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime || event.toolName !== "subagent") return;
		const batch = runtime.subagentBatches.get(event.toolCallId);
		if (!batch) return;
		runtime.subagentBatches.set(event.toolCallId, applySubagentDetails(batch, event.partialResult?.details));
		refreshSubagents(runtime);
		requestRender(runtime);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		runtime.activeToolCalls.delete(event.toolCallId);
		const activeTools = [...runtime.activeToolCalls.values()];
		refreshActivity(runtime, "working", activeTools.length > 0 ? `Running ${activeTools[activeTools.length - 1]}` : "Responding");
		if (event.toolName === "todo") suppressTodoWidget(runtime);
		requestRender(runtime);
	});
	pi.on("tool_result", (event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		if (event.toolName === "todo") {
			if (event.isError) return;
			const todos = normalizeTodoDetails(event.details);
			if (todos === undefined) return;
			runtime.todos = todos;
			if (runtime.sidebarVisible && panelEnabled(runtime.config, "todos")) {
				suppressTodoWidget(runtime);
				requestRender(runtime);
				const done = todos.filter((todo) => todo.status === "completed").length;
				return { content: [{ type: "text", text: `${done}/${todos.length} done · see sidebar` }] };
			}
			requestRender(runtime);
			return;
		}
		if (event.toolName === "subagent") {
			const batch = runtime.subagentBatches.get(event.toolCallId);
			if (!batch) return;
			const updated = finishSubagents(applySubagentDetails(batch, event.details), event.isError);
			runtime.subagentBatches.set(event.toolCallId, updated);
			refreshSubagents(runtime);
			requestRender(runtime);
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (!runtime) return;
		runtime.activeToolCalls.clear();
		refreshActivity(runtime, "ready", "Ready");
		requestRender(runtime);
	});
	pi.on("model_select", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) {
			void refreshSubscription(runtime);
			requestRender(runtime);
		}
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) requestRender(runtime);
	});
	pi.on("session_compact", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) requestRender(runtime);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!isCurrent(current, ctx)) return;
		disposeRuntime(current);
		current = undefined;
	});
}
