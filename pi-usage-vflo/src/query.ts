import { randomBytes } from "node:crypto";
import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { errorMessage, fingerprintResolvedAuth, isAbortError, redactUsageError } from "./core.js";
import { normalizeAnthropicOauthUsagePayload } from "./providers/anthropic.js";
import { normalizeCodexBackendPayload } from "./providers/codex.js";
import { normalizeGitHubCopilotUsagePayload } from "./providers/github-copilot.js";
import type {
	AnthropicOauthUsagePayload,
	CodexBackendPayload,
	GitHubCopilotUsagePayload,
	PiModel,
	ResolvedUsageAuth,
	UsageProviderAdapter,
	UsageReport,
} from "./types.js";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GITHUB_COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export const AUTH_FINGERPRINT_SALT = randomBytes(32);

export const SUPPORTED_ADAPTERS: readonly UsageProviderAdapter[] = [
	{
		id: "anthropic",
		displayName: "Claude",
		semantics: {
			kind: "consumer-subscription",
			label: "Claude subscription limits",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				ANTHROPIC_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"Claude usage endpoint",
			);
			return normalizeAnthropicOauthUsagePayload(
				payload as AnthropicOauthUsagePayload,
				Date.now(),
			);
		},
	},
	{
		id: "openai-codex",
		displayName: "OpenAI Codex",
		semantics: {
			kind: "consumer-subscription",
			label: "ChatGPT subscription limits",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				CODEX_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"Codex usage endpoint",
			);
			return normalizeCodexBackendPayload(payload as CodexBackendPayload, Date.now());
		},
	},
	{
		id: "github-copilot",
		displayName: "GitHub Copilot",
		semantics: {
			kind: "consumer-subscription",
			label: "GitHub Copilot subscription limits",
		},
		async query(auth, signal, timeoutMs) {
			const payload = await fetchProviderJson(
				auth.endpointUrl ?? GITHUB_COPILOT_USAGE_URL,
				auth,
				signal,
				timeoutMs,
				"GitHub Copilot usage endpoint",
			);
			return normalizeGitHubCopilotUsagePayload(
				payload as GitHubCopilotUsagePayload,
				Date.now(),
			);
		},
	},
];

export function adapterForProvider(
	providerId: string | undefined,
): UsageProviderAdapter | undefined {
	return SUPPORTED_ADAPTERS.find((adapter) => adapter.id === providerId);
}

export function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes("This extension ctx is stale after session replacement or reload")
	);
}

export async function resolveUsageAuth(
	ctx: ExtensionContext,
	adapter: UsageProviderAdapter,
	salt: Uint8Array = AUTH_FINGERPRINT_SALT,
	credentialReader: StoredCredentialReader = readStoredCredential,
): Promise<ResolvedUsageAuth | undefined> {
	// Pi resolves Copilot model calls to a short-lived Copilot API token, but
	// GitHub's quota endpoint requires the original GitHub OAuth token stored in
	// the credential's `refresh` field. Read only that provider's canonical
	// credential; never infer or exchange tokens in this extension.
	let storedCredential: unknown;
	try {
		storedCredential = adapter.id === "github-copilot" ? credentialReader(adapter.id) : undefined;
	} catch {
		throw new Error(`${adapter.displayName} credential resolution failed.`);
	}
	const enterpriseDomain = githubCopilotEnterpriseDomain(storedCredential);
	if (
		ctx.model?.provider === adapter.id &&
		!hasOfficialOrigin(ctx.model, adapter.id, enterpriseDomain)
	) {
		throw new Error(
			`${adapter.displayName} usage cannot send a custom provider base URL credential to the official usage endpoint.`,
		);
	}

	const model = candidateModels(ctx, adapter.id).find((candidate) =>
		hasOfficialOrigin(candidate, adapter.id, enterpriseDomain),
	);
	if (!model) return undefined;
	const registry = ctx.modelRegistry as unknown as UsageAuthRegistry;
	let modelAuth: RequestAuth | undefined;
	if (ctx.model?.provider === adapter.id && typeof registry.getApiKeyAndHeaders === "function") {
		let result: Awaited<ReturnType<NonNullable<UsageAuthRegistry["getApiKeyAndHeaders"]>>>;
		try {
			result = await registry.getApiKeyAndHeaders(ctx.model);
		} catch {
			throw new Error(`${adapter.displayName} credential resolution failed.`);
		}
		// Registry errors can contain provider command output. Do not publish
		// that opaque text to the statusline or the cross-process failure file,
		// where an accidentally echoed credential would persist in plaintext.
		if (!result.ok) throw new Error(`${adapter.displayName} credential resolution failed.`);
		if (authorizationFrom(result)) modelAuth = result;
	}
	if (typeof registry.getProviderAuth !== "function") {
		throw new Error("pi-usage-vflo requires Pi 0.81.0 or newer to validate resolved provider auth.");
	}
	let providerResult: Awaited<ReturnType<NonNullable<UsageAuthRegistry["getProviderAuth"]>>>;
	try {
		providerResult = await registry.getProviderAuth(adapter.id);
	} catch {
		throw new Error(`${adapter.displayName} credential resolution failed.`);
	}
	if (
		providerResult?.auth.baseUrl &&
		!hasOfficialResolvedAuthOrigin(providerResult.auth.baseUrl, adapter.id, enterpriseDomain)
	) {
		throw new Error(
			`${adapter.displayName} usage cannot send a proxy-resolved credential to the official usage endpoint.`,
		);
	}
	const auth = modelAuth ?? providerResult?.auth;
	if (!auth) return undefined;
	const authorization = authorizationFrom(auth);
	if (!authorization) return undefined;
	const runtimeSecrets = [auth.apiKey, headerValue(auth.headers, "Authorization"), authorization].filter(
		(value): value is string => Boolean(value),
	);

	if (adapter.id === "github-copilot") {
		const githubToken = githubCopilotOAuthToken(storedCredential);
		if (!githubToken) {
			throw new Error(
				"GitHub Copilot usage requires Pi's OAuth login. A COPILOT_GITHUB_TOKEN API token cannot report subscription quota.",
			);
		}
		const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/json" };
		return {
			headers,
			endpointUrl: githubCopilotUsageUrl(enterpriseDomain),
			fingerprint: fingerprintResolvedAuth({ headers }, salt),
			secrets: [...runtimeSecrets, githubToken, `Bearer ${githubToken}`],
			model,
		};
	}

	if (adapter.id === "anthropic" && !/^Bearer\s+sk-ant-oat/u.test(authorization)) {
		throw new Error(
			"Claude usage requires the claude.ai subscription OAuth credential (sk-ant-oat…). An API key cannot report subscription usage.",
		);
	}
	const headers = { Authorization: authorization };
	return {
		apiKey: auth.apiKey,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: runtimeSecrets,
		model,
	};
}

export async function queryProviderUsage(
	adapter: UsageProviderAdapter,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<UsageReport> {
	try {
		return await adapter.query(auth, signal, timeoutMs);
	} catch (error) {
		if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
		throw new Error(redactUsageError(errorMessage(error), auth.secrets));
	}
}

export function providerIsConfigured(ctx: ExtensionContext, providerId: string): boolean {
	try {
		return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
	} catch {
		return candidateModels(ctx, providerId).length > 0;
	}
}

function candidateModels(ctx: ExtensionContext, providerId: string): PiModel[] {
	const candidates: PiModel[] = [];
	const seen = new Set<string>();
	const add = (model: PiModel | undefined) => {
		if (!model || model.provider !== providerId) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};
	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model);
	for (const model of ctx.modelRegistry.getAll()) add(model);
	return candidates;
}

export async function fetchProviderJson(
	url: string,
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
	description: string,
	request: {
		method?: "GET" | "POST";
		body?: Record<string, unknown>;
	} = {},
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const headers = { ...auth.headers };
		if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "pi-usage-vflo";
		if (request.body && !hasHeader(headers, "Content-Type")) {
			headers["Content-Type"] = "application/json";
		}
		const response = await fetch(url, {
			method: request.method ?? "GET",
			headers,
			...(request.body ? { body: JSON.stringify(request.body) } : {}),
			signal: controller.signal,
		});
		if (controller.signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		const text = await readBoundedResponse(
			response,
			response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
			!response.ok,
			description,
		);
		if (controller.signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		if (!response.ok) {
			throw new Error(
				`${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch (error) {
			throw new Error(`${description} returned invalid JSON: ${errorMessage(error)}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${description} response was not an object.`);
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (timedOut) {
			throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
		}
		if (signal.aborted)
			throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromCaller);
	}
}

async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	truncateOverflow: boolean,
	description: string,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (truncated && !truncateOverflow) {
		throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(body);
	return truncated ? `${text}…` : text;
}

type RequestAuth = {
	apiKey?: string;
	headers?: Record<string, string | null>;
};

type StoredCredentialReader = (providerId: string) => unknown;

type UsageAuthRegistry = {
	getApiKeyAndHeaders?(
		model: PiModel,
	): Promise<({ ok: true } & RequestAuth) | { ok: false; error: string }>;
	getProviderAuth?(providerId: string): Promise<
		| {
				auth: RequestAuth & { baseUrl?: string };
		  }
		| undefined
	>;
};

function authorizationFrom(auth: RequestAuth): string | undefined {
	return (
		headerValue(auth.headers, "Authorization") ??
		(auth.apiKey ? `Bearer ${auth.apiKey}` : undefined)
	);
}

function hasOfficialOrigin(
	model: PiModel,
	providerId: string,
	githubEnterpriseDomain?: string,
): boolean {
	return hasOfficialUrlOrigin(model.baseUrl, providerId, githubEnterpriseDomain);
}

function hasOfficialUrlOrigin(
	value: string | undefined,
	providerId: string,
	githubEnterpriseDomain?: string,
): boolean {
	try {
		const url = new URL(value ?? "");
		if (providerId === "anthropic") return url.origin === "https://api.anthropic.com";
		if (providerId === "openai-codex") return url.origin === "https://chatgpt.com";
		if (providerId === "github-copilot") {
			if (url.protocol !== "https:" || url.port) return false;
			// Built-in model metadata keeps the public catalog base URL even for
			// Enterprise accounts. The credential-specific endpoint is available
			// only from getProviderAuth(), where the stricter check below applies.
			const publicCopilotApi = /^api\.[a-z0-9-]+\.githubcopilot\.com$/u.test(url.hostname);
			const enterpriseCopilotApi =
				githubEnterpriseDomain !== undefined &&
				(url.hostname === `api.${githubEnterpriseDomain}` ||
					url.hostname === `copilot-api.${githubEnterpriseDomain}`);
			return publicCopilotApi || enterpriseCopilotApi;
		}
		return false;
	} catch {
		return false;
	}
}

function hasOfficialResolvedAuthOrigin(
	value: string | undefined,
	providerId: string,
	githubEnterpriseDomain: string | undefined,
): boolean {
	if (providerId !== "github-copilot") {
		return hasOfficialUrlOrigin(value, providerId, githubEnterpriseDomain);
	}
	try {
		const url = new URL(value ?? "");
		if (url.protocol !== "https:" || url.port) return false;
		// Pi prefers the `proxy-ep` embedded in the short-lived Copilot token,
		// converting `proxy.<enterprise>` to `api.<enterprise>`. If that field is
		// absent, Pi falls back to `copilot-api.<enterprise>`. Accept exactly
		// those two credential-derived hosts, not an arbitrary custom proxy.
		if (githubEnterpriseDomain) {
			return (
				url.hostname === `api.${githubEnterpriseDomain}` ||
				url.hostname === `copilot-api.${githubEnterpriseDomain}`
			);
		}
		return /^api\.[a-z0-9-]+\.githubcopilot\.com$/u.test(url.hostname);
	} catch {
		return false;
	}
}

function githubCopilotOAuthToken(credential: unknown): string | undefined {
	if (!credential || typeof credential !== "object" || Array.isArray(credential)) return undefined;
	const value = credential as Record<string, unknown>;
	return value.type === "oauth" && typeof value.refresh === "string" && value.refresh
		? value.refresh
		: undefined;
}

function githubCopilotEnterpriseDomain(credential: unknown): string | undefined {
	if (!credential || typeof credential !== "object" || Array.isArray(credential)) return undefined;
	const raw = (credential as Record<string, unknown>).enterpriseUrl;
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new Error("GitHub Copilot credential has an invalid enterprise URL.");
	try {
		const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
			throw new Error("invalid enterprise URL");
		}
		return url.hostname;
	} catch {
		throw new Error("GitHub Copilot credential has an invalid enterprise URL.");
	}
}

function githubCopilotUsageUrl(enterpriseDomain: string | undefined): string {
	return enterpriseDomain
		? `https://api.${enterpriseDomain}/copilot_internal/user`
		: GITHUB_COPILOT_USAGE_URL;
}

function headerValue(
	headers: Record<string, string | null> | undefined,
	name: string,
): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return entry?.[1] ?? undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}