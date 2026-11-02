import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Settings that affect only how timestamps are displayed.
 *
 * The date and time patterns are deliberately separate. This lets a user keep
 * a compact time-only footer while still choosing a date pattern for the cases
 * where the date is useful. The values are small format strings, not locale
 * names, so the transcript stays stable across machines and sessions.
 */
export interface TimestampSettings {
	showDate: boolean;
	dateFormat: string;
	timeFormat: string;
}

export const DEFAULT_TIMESTAMP_SETTINGS: Readonly<TimestampSettings> = {
	showDate: false,
	dateFormat: "YYYY-MM-DD",
	timeFormat: "HH:mm:ss",
};

export const DATE_FORMAT_OPTIONS = [
	{ value: "YYYY-MM-DD", label: "YYYY-MM-DD (2025-01-02)" },
	{ value: "MM/DD/YYYY", label: "MM/DD/YYYY (01/02/2025)" },
	{ value: "DD/MM/YYYY", label: "DD/MM/YYYY (02/01/2025)" },
	{ value: "custom", label: "Custom date format…" },
] as const;

export const TIME_FORMAT_OPTIONS = [
	{ value: "HH:mm:ss", label: "HH:mm:ss (15:04:05)" },
	{ value: "HH:mm", label: "HH:mm (15:04)" },
	{ value: "h:mm:ss A", label: "h:mm:ss A (3:04:05 PM)" },
	{ value: "h:mm A", label: "h:mm A (3:04 PM)" },
	{ value: "custom", label: "Custom time format…" },
] as const;

const DATE_TOKEN_PATTERN = /YYYY|YY|MM|M|DD|D/g;
const TIME_TOKEN_PATTERN = /HH|H|hh|h|mm|m|ss|s|A|a/g;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasOnlyTokensAndPunctuation(value: string, tokenPattern: RegExp, required: RegExp): boolean {
	if (value.length === 0 || value.length > 64 || !required.test(value)) return false;

	// Remove every known token. Any remaining ASCII letter would be an
	// accidental unsupported token, while punctuation and spaces are valid
	// literals in a timestamp format.
	const remainder = value.replace(new RegExp(tokenPattern.source, "g"), "");
	return !/[A-Za-z]/u.test(remainder);
}

/** Validate a date pattern before storing it or using it in a renderer. */
export function isValidDateFormat(value: string): boolean {
	return hasOnlyTokensAndPunctuation(value, DATE_TOKEN_PATTERN, /Y/u) && /M/u.test(value) && /D/u.test(value);
}

/** Validate a time pattern before storing it or using it in a renderer. */
export function isValidTimeFormat(value: string): boolean {
	return hasOnlyTokensAndPunctuation(value, TIME_TOKEN_PATTERN, /H|h/u) && /m/u.test(value);
}

/** Return a safe copy of settings, falling back field-by-field when needed. */
export function normalizeTimestampSettings(value: unknown): TimestampSettings {
	if (!isRecord(value)) return { ...DEFAULT_TIMESTAMP_SETTINGS };

	const showDate = typeof value.showDate === "boolean" ? value.showDate : DEFAULT_TIMESTAMP_SETTINGS.showDate;
	const dateFormat =
		typeof value.dateFormat === "string" && isValidDateFormat(value.dateFormat)
			? value.dateFormat
			: DEFAULT_TIMESTAMP_SETTINGS.dateFormat;
	const timeFormat =
		typeof value.timeFormat === "string" && isValidTimeFormat(value.timeFormat)
			? value.timeFormat
			: DEFAULT_TIMESTAMP_SETTINGS.timeFormat;

	return { showDate, dateFormat, timeFormat };
}

function formatPattern(timestamp: Date, pattern: string): string {
	const hours24 = timestamp.getHours();
	const hours12 = hours24 % 12 || 12;
	const meridiem = hours24 < 12 ? "AM" : "PM";

	return pattern.replace(/YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g, (token) => {
		switch (token) {
			case "YYYY":
				return String(timestamp.getFullYear()).padStart(4, "0");
			case "YY":
				return String(timestamp.getFullYear()).padStart(2, "0").slice(-2);
			case "MM":
				return pad(timestamp.getMonth() + 1);
			case "M":
				return String(timestamp.getMonth() + 1);
			case "DD":
				return pad(timestamp.getDate());
			case "D":
				return String(timestamp.getDate());
			case "HH":
				return pad(hours24);
			case "H":
				return String(hours24);
			case "hh":
				return pad(hours12);
			case "h":
				return String(hours12);
			case "mm":
				return pad(timestamp.getMinutes());
			case "m":
				return String(timestamp.getMinutes());
			case "ss":
				return pad(timestamp.getSeconds());
			case "s":
				return String(timestamp.getSeconds());
			case "A":
				return meridiem;
			case "a":
				return meridiem.toLowerCase();
			default:
				return token;
		}
	});
}

/** Format a timestamp using the current display settings and local time. */
export function formatTimestamp(timestamp: number, settings: TimestampSettings = DEFAULT_TIMESTAMP_SETTINGS): string {
	const date = new Date(timestamp);
	const time = formatPattern(date, settings.timeFormat);
	return settings.showDate ? `${formatPattern(date, settings.dateFormat)} ${time}` : time;
}

/** Return the path used for settings, honoring Pi's standard config override. */
export function getSettingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "pi-msg-timestamps.json");
}

/**
 * Small user-level settings store. Pi does not expose an extension settings API,
 * so this file keeps the preference independent from any one conversation.
 */
export class TimestampSettingsStore {
	private settings: TimestampSettings = { ...DEFAULT_TIMESTAMP_SETTINGS };

	constructor(private readonly filePath = getSettingsPath()) {}

	get(): TimestampSettings {
		return { ...this.settings };
	}

	set(settings: TimestampSettings): void {
		this.settings = normalizeTimestampSettings(settings);
	}

	async load(): Promise<void> {
		try {
			const contents = await readFile(this.filePath, "utf8");
			this.settings = normalizeTimestampSettings(JSON.parse(contents));
		} catch (error) {
			// A missing or malformed preference must never stop Pi from loading the
			// extension. Keep defaults and let the next successful command rewrite it.
			if (isFileMissingOrInvalidJson(error)) return;
			throw error;
		}
	}

	async save(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
	}
}

function isFileMissingOrInvalidJson(error: unknown): boolean {
	return isRecord(error) && (error.code === "ENOENT" || error instanceof SyntaxError);
}
