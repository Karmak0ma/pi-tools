import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbortError, sanitizeDisplayText } from "./core.js";
import type { PiModel } from "./types.js";

export function providerDisplayName(ctx: ExtensionContext, providerId: string): string {
	try {
		return sanitizeDisplayText(ctx.modelRegistry.getProviderDisplayName(providerId), 80);
	} catch {
		return sanitizeDisplayText(providerId, 80);
	}
}

export function setBoundedMap<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
	map.delete(key);
	while (map.size >= limit) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
	map.set(key, value);
}

export function modelIdentity(model: PiModel | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}