import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { adapterForProvider, readSharedProviderEntry } from "pi-usage-vflo/src/index.js";
import { matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { limitsFromEntry } from "./limits.js";
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
import { prioritizeInputListener } from "./input-priority.js";
import { isUnmodifiedPrimaryPress, parseSgrMouseEvent } from "./mouse.js";
import {
	DEFAULT_CONFIG,
	type ActivityState,
	type SidebarConfig,
	type SidebarPanelId,
	type LimitsState,
	type SidebarSnapshot,
	type SubagentItem,
	type TodoItem,
} from "./types.js";

// How often the sidebar re-reads pi-usage-vflo's published cache file. This is
// a local file read, not a provider request, so it can be frequent and cheap:
// it only decides how fast the panel picks up numbers that the usage extension
// has already fetched (that extension refreshes every 5 minutes).
const SUBSCRIPTION_POLL_MS = 30_000;

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
	limits: LimitsState;
	subscriptionPollTimer?: NodeJS.Timeout;
	overlayGeneration: number;
	overlayStarting: boolean;
	tui?: TUI;
	split?: SplitPaneController;
	overlayHandle?: OverlayHandle;
	closeOverlay?: () => void;
	// Todos panel expand/collapse state, toggled by clicking the panel
	// (fullscreen mode only) or the alt+t shortcut (both modes).
	todosExpanded: boolean;
	// [startLine, endLine) of the last-rendered Todos panel within the
	// sidebar's output, used to hit-test mouse clicks. Undefined when the
	// panel isn't currently rendered.
	todosRange?: [number, number];
	terminalInputListener?: (data: string) => { consume?: boolean; data?: string } | undefined;
	unsubscribeTerminalInput?: () => void;
	// Whether our terminal input listener has successfully been moved ahead of
	// Pi's own fullscreen viewport listener this render. Re-derived every
	// frame since Pi may rebind its private listener set (e.g. on a regular
	// <-> fullscreen mode switch).
	inputPriorityReady: boolean;
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
				  }
			: undefined,
		thinkingLevel: runtime.ctx.thinkingLevel,
		activity: runtime.activity,
		context,
		limits: runtime.limits,
		usage: sumBranchUsage(runtime.ctx.sessionManager.getBranch()),
		todos: runtime.todos,
		subagents: runtime.subagents,
	};
}

// Reads the limits state for the current model from pi-usage-vflo's published
// cache. Returns whether the current provider is a subscription provider, so
// the caller can stop polling for models that can never have limit windows.
//
// This performs no network I/O on purpose: see src/limits.ts for why the
// sidebar must not query the provider itself.
async function refreshSubscription(runtime: Runtime): Promise<boolean> {
	const model = runtime.ctx.model;
	const adapter = adapterForProvider(model?.provider);
	const isSubscriptionModel = !!model && !!adapter && adapter.semantics.kind === "consumer-subscription";
	if (!isSubscriptionModel) {
		runtime.limits = { buckets: [] };
		requestRender(runtime);
		return false;
	}
	const entry = await readSharedProviderEntry(model.provider);
	// The model may have been switched while we were reading the file; in that
	// case the newer refresh owns the state and this result is discarded.
	if (runtime.ctx.model !== model) return true;
	runtime.limits = limitsFromEntry(entry, true, Date.now());
	requestRender(runtime);
	return true;
}

function clearSubscriptionPoll(runtime: Runtime): void {
	if (runtime.subscriptionPollTimer === undefined) return;
	clearTimeout(runtime.subscriptionPollTimer);
	runtime.subscriptionPollTimer = undefined;
}

// Self-rescheduling, unref'd poll: it never keeps the process alive on its
// own, and it is cleared synchronously whenever the sidebar is hidden or the
// session ends, so a stale timer can never fire against a torn-down runtime.
function scheduleSubscriptionPoll(runtime: Runtime, delayMs = SUBSCRIPTION_POLL_MS): void {
	clearSubscriptionPoll(runtime);
	if (!runtime.sidebarVisible) return;
	const timer = setTimeout(() => {
		void refreshSubscription(runtime).then((isSubscriptionModel) => {
			if (runtime.subscriptionPollTimer !== timer) return;
			runtime.subscriptionPollTimer = undefined;
			if (isSubscriptionModel) scheduleSubscriptionPoll(runtime);
		});
	}, delayMs);
	timer.unref?.();
	runtime.subscriptionPollTimer = timer;
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
		["model", "Model"], ["activity", "Activity"], ["context", "Context"], ["limits", "Limits"],
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
		// No point polling for subscription data nobody can see.
		scheduleSubscriptionPoll(runtime);
	} else {
		closeOverlay(runtime);
		clearSubscriptionPoll(runtime);
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
						// Re-derived every frame: Pi may rebind its private fullscreen
						// input-listener Set (e.g. on a regular <-> fullscreen switch),
						// so priority must be re-established rather than cached once.
						if (runtime.terminalInputListener) {
							runtime.inputPriorityReady = prioritizeInputListener(tui, runtime.terminalInputListener);
						}
						const { lines, todosRange } = renderSidebar(snapshot(runtime), runtime.config, sidebarTheme, width, tui.terminal.rows, runtime.todosExpanded);
						runtime.todosRange = todosRange;
						return lines;
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

// Parses raw terminal input for a mouse click landing on the Todos panel.
// Fullscreen-mode only, and never enables mouse tracking itself — it only
// observes SGR reports Pi's own fullscreen renderer is already generating.
// Every non-matching report (release, motion, wheel, clicks elsewhere, a
// click while a real capturing dialog is open) is returned as `undefined` so
// Pi's own input handling proceeds completely untouched.
function handleTerminalInput(runtime: Runtime, data: string): { consume?: boolean } | undefined {
	try {
		if (!runtime.sidebarVisible || !runtime.tui || !runtime.split) return undefined;
		const event = parseSgrMouseEvent(data);
		if (!event || !isUnmodifiedPrimaryPress(event)) return undefined;
		const tui = runtime.tui;
		if (tui.mode !== "fullscreen") return undefined;
		if (typeof tui.hasOverlay !== "function" || tui.hasOverlay()) return undefined;
		// Our listener isn't ahead of Pi's own viewport listener this frame (a
		// future pi-tui version may not expose the private shape we rely on) —
		// fail open and let Pi handle the click as it normally would.
		if (!runtime.inputPriorityReady) return undefined;
		if (!runtime.todosRange) return undefined;
		const sidebarWidth = runtime.split.getSidebarWidth();
		const columns = tui.terminal.columns;
		const leftCol0 = columns - sidebarWidth;
		if (event.x < leftCol0) return undefined;
		const [start, end] = runtime.todosRange;
		if (event.y < start || event.y >= end) return undefined;
		runtime.todosExpanded = !runtime.todosExpanded;
		requestRender(runtime);
		return { consume: true };
	} catch {
		// A future TUI/terminal quirk must never break normal input handling.
		return undefined;
	}
}

function disposeRuntime(runtime: Runtime): void {
	clearSubscriptionPoll(runtime);
	runtime.unsubscribeTerminalInput?.();
	runtime.unsubscribeTerminalInput = undefined;
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
			limits: { buckets: [] },
			overlayGeneration: 0,
			overlayStarting: false,
			todosExpanded: false,
			inputPriorityReady: false,
		};
		current = runtime;
		startOverlay(runtime);
		void refreshSubscription(runtime).then(() => scheduleSubscriptionPoll(runtime));
		if (runtime.sidebarVisible) {
			suppressTodoWidget(runtime);
			queueMicrotask(() => suppressTodoWidget(runtime));
		}
		if (ctx.mode === "tui") {
			runtime.terminalInputListener = (data) => handleTerminalInput(runtime, data);
			runtime.unsubscribeTerminalInput = ctx.ui.onTerminalInput(runtime.terminalInputListener);
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

	pi.registerShortcut("alt+t", {
		description: "Expand/collapse the Sidebar VFLO Todos panel",
		handler: (ctx) => {
			const runtime = runtimeFor(current, ctx);
			if (!runtime) return;
			runtime.todosExpanded = !runtime.todosExpanded;
			requestRender(runtime);
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
			void refreshSubscription(runtime).then(() => scheduleSubscriptionPoll(runtime));
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
	// Context tokens are recomputed fresh on every render already; these
	// handlers exist purely to trigger MORE render passes at more lifecycle
	// points so the Context panel reflects changes without waiting for an
	// unrelated event (tool call, model switch, etc.) to happen to fire first.
	pi.on("message_start", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) requestRender(runtime);
	});
	pi.on("message_end", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) requestRender(runtime);
	});
	pi.on("turn_end", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) requestRender(runtime);
	});
	pi.on("agent_end", (_event, ctx) => {
		const runtime = runtimeFor(current, ctx);
		if (runtime) requestRender(runtime);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!isCurrent(current, ctx)) return;
		disposeRuntime(current);
		current = undefined;
	});
}
