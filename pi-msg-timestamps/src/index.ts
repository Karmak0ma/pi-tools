import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	truncateToWidth,
	type Component,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	DATE_FORMAT_OPTIONS,
	isValidDateFormat,
	isValidTimeFormat,
	TIME_FORMAT_OPTIONS,
	TimestampSettingsStore,
	type TimestampSettings,
} from "./settings.ts";
import {
	appendTimestamp,
	formatTimestamp,
	dimTimestampText,
	TimestampStore,
	type SessionEntryLike,
} from "./timestamps.ts";

interface ToolRendererState {
	startedAt: number;
	callComponent?: Component;
	callTimestampContainer?: Container;
	resultComponent?: Component;
	resultSeen: boolean;
}

/**
 * Render one line flush with the right edge of the component's available
 * width. `Text` deliberately left-aligns its content, so a tiny component is
 * clearer than trying to modify the original tool renderer's output.
 */
class RightAlignedTimestamp implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(width: number): string[] {
		const text = truncateToWidth(this.text, width);
		return [`${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`];
	}
}

/**
 * Add a timestamp as the last child of a tool renderer. With Pi's default
 * `renderShell`, the surrounding ToolExecutionComponent places this child
 * inside the existing colored tool box, so the timestamp is the bottom-right
 * line without replacing the tool's own rendering or behavior.
 */
function timestampText(timestamp: number, theme: Theme, settings: TimestampSettings): Component {
	// `thinkingText` is the same semantic theme token Pi uses for thinking
	// blocks. Faint plus italic gives the timestamp the same subdued visual
	// weight. Terminal extensions cannot change the terminal font size.
	const text = theme.italic(theme.fg("thinkingText", dimTimestampText(formatTimestamp(timestamp, settings))));
	return new RightAlignedTimestamp(text);
}

function withToolTimestamp(
	component: Component,
	timestamp: number,
	theme: Theme,
	settings: TimestampSettings,
): Component {
	const container = new Container();
	container.addChild(component);
	// Tool renderers do not add the blank line that ordinary Markdown gets from
	// the `\n\n` footer separator, so add it explicitly here.
	container.addChild(new Spacer(1));
	container.addChild(timestampText(timestamp, theme, settings));
	return container;
}

/**
 * Keep the pending timestamp in a reusable container. Pi calls renderCall
 * before renderResult, including when the result is partial. Clearing this
 * container from renderResult removes the pending footer before the result
 * footer is rendered, so streaming never shows two timestamps.
 */
function withPendingToolTimestamp(
	state: ToolRendererState,
	component: Component,
	timestamp: number,
	theme: Theme,
	settings: TimestampSettings,
	showTimestamp: boolean,
): Component {
	const container = state.callTimestampContainer ?? (state.callTimestampContainer = new Container());
	container.clear();
	container.addChild(component);
	if (showTimestamp) {
		container.addChild(new Spacer(1));
		container.addChild(timestampText(timestamp, theme, settings));
	}
	return container;
}

function hidePendingToolTimestamp(state: ToolRendererState): void {
	if (!state.callTimestampContainer || !state.callComponent) return;

	state.callTimestampContainer.clear();
	state.callTimestampContainer.addChild(state.callComponent);
}

export default function (pi: ExtensionAPI) {
	const timestamps = new TimestampStore();
	const timestampSettings = new TimestampSettingsStore();
	const toolRendererStates = new Map<string, ToolRendererState>();

	const rebuildFromSession = (ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		// Session entries carry ISO timestamps. Rebuilding on every branch change
		// prevents timestamps from an abandoned tree branch leaking into the view.
		timestamps.loadBranch(ctx.sessionManager.getBranch() as SessionEntryLike[]);
		toolRendererStates.clear();
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await timestampSettings.load();
		} catch {
			// Preferences are optional. A filesystem failure must not prevent Pi
			// from starting or remove timestamp rendering for this session.
		}
		rebuildFromSession(ctx);
	});
	pi.on("session_tree", (_event, ctx) => rebuildFromSession(ctx));

	// These hooks give newly-created and currently-streaming messages a stable
	// timestamp before their session entry is available for reconstruction.
	pi.on("message_start", (event) => timestamps.startMessage(event.message));
	pi.on("message_end", (event) => timestamps.endMessage(event.message));
	pi.on("tool_execution_start", (event) => timestamps.recordToolStart(event.toolCallId));

	/**
	 * Pi intentionally exposes no component renderer for ordinary user and
	 * assistant messages. This is the supported fallback: add a display-only
	 * Markdown footer. It is skipped for thinking blocks because the request is
	 * for user/agent messages, not each internal thinking segment.
	 */
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "assistant-thinking" || !markdown.trim()) return markdown;

		const role = context.messageType;
		const timestamp = timestamps.getMessageTimestamp(role, markdown);
		return appendTimestamp(markdown, timestamp, timestampSettings.get(), context.availableWidth);
	});

	/**
	 * Tool renderer resolvers compose with existing Pi and extension renderers.
	 * `next()` is essential: returning a replacement renderer without delegating
	 * would silently discard custom tool output and could change its behavior.
	 */
	pi.registerToolRenderer((_toolName, next) => {
		const renderer = next();
		if (!renderer) return undefined;

		const wrapped = { ...renderer };

		if (renderer.renderCall) {
			const renderCall = renderer.renderCall;
			wrapped.renderCall = (args, theme, context) => {
				const state = getToolRendererState(toolRendererStates, context.toolCallId, timestamps);
				const component = renderCall(args, theme, {
					...context,
					// Keep the delegated renderer's component reuse contract intact.
					lastComponent: state.callComponent,
				});
				state.callComponent = component;

				// Show the timestamp while the call is pending. When renderResult
				// runs, it clears this reusable container before adding the one
				// final timestamp below the result. Tools without a result renderer
				// keep the timestamp on their call after execution completes.
				return withPendingToolTimestamp(
					state,
					component,
					state.startedAt,
					theme,
					timestampSettings.get(),
					!renderer.renderResult || !state.resultSeen,
				);
			};
		}

		if (renderer.renderResult) {
			const renderResult = renderer.renderResult;
			wrapped.renderResult = (result, options, theme, context) => {
				const state = getToolRendererState(toolRendererStates, context.toolCallId, timestamps);
				state.resultSeen = true;
				hidePendingToolTimestamp(state);
				const component = renderResult(result, options, theme, {
					...context,
					// Preserve component reuse for the original renderer.
					lastComponent: state.resultComponent,
				});
				state.resultComponent = component;
				return withToolTimestamp(component, state.startedAt, theme, timestampSettings.get());
			};
		}

		return wrapped;
	});

	pi.registerCommand("timestamp-settings", {
		description: "Configure timestamp date display and format",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/timestamp-settings requires an interactive or RPC UI", "error");
				return;
			}

			const current = timestampSettings.get();
			const dateChoice = await ctx.ui.select(
				`Show date (currently ${current.showDate ? "on" : "off"})`,
				["off", "on"],
			);
			if (!dateChoice) return;

			const next: TimestampSettings = {
				...current,
				showDate: dateChoice === "on",
			};

			if (next.showDate) {
				const dateFormat = await chooseFormat(
					ctx,
					`Date format (currently ${current.dateFormat})`,
					DATE_FORMAT_OPTIONS,
					current.dateFormat,
					"Custom date format",
					isValidDateFormat,
				);
				if (dateFormat === undefined) return;
				next.dateFormat = dateFormat;
			}

			const timeFormat = await chooseFormat(
				ctx,
				`Time format (currently ${current.timeFormat})`,
				TIME_FORMAT_OPTIONS,
				current.timeFormat,
				"Custom time format",
				isValidTimeFormat,
			);
			if (timeFormat === undefined) return;
			next.timeFormat = timeFormat;

			try {
				timestampSettings.set(next);
				await timestampSettings.save();
				ctx.ui.notify(`Timestamp settings saved: ${describeSettings(next)}`, "info");
			} catch (error) {
				timestampSettings.set(current);
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save timestamp settings: ${message}`, "error");
			}
		},
	});
}

async function chooseFormat(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly { value: string; label: string }[],
	current: string,
	customTitle: string,
	validate: (value: string) => boolean,
): Promise<string | undefined> {
	const labels = options.map(({ value, label }) => (value === current ? `${label} (current)` : label));
	const selected = await ctx.ui.select(title, labels);
	if (selected === undefined) return undefined;

	const option = options[labels.indexOf(selected)];
	if (!option) return undefined;
	if (option.value !== "custom") return option.value;

	const custom = await ctx.ui.input(customTitle, current);
	if (custom === undefined) return undefined;

	const value = custom.trim();
	if (!validate(value)) {
		ctx.ui.notify(
			`Invalid format. Use supported date/time tokens and punctuation only (for example: ${current}).`,
			"error",
		);
		return undefined;
	}
	return value;
}

function describeSettings(settings: TimestampSettings): string {
	return settings.showDate ? `${settings.dateFormat} ${settings.timeFormat}` : settings.timeFormat;
}

function getToolRendererState(
	states: Map<string, ToolRendererState>,
	toolCallId: string,
	timestamps: TimestampStore,
): ToolRendererState {
	let state = states.get(toolCallId);
	if (!state) {
		state = {
			startedAt: timestamps.getToolTimestamp(toolCallId),
			resultSeen: false,
		};
		states.set(toolCallId, state);
	}
	return state;
}
