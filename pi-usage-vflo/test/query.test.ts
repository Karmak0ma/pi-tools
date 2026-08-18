import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	adapterForProvider,
	fetchProviderJson,
	providerIsConfigured,
	queryProviderUsage,
	resolveUsageAuth,
} from "../src/query.js";
import { normalizeAnthropicOauthUsagePayload } from "../src/providers/anthropic.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiModel, ResolvedUsageAuth } from "../src/types.js";

const SALT = new Uint8Array(32);

function mockModel(overrides: Partial<PiModel> = {}): PiModel {
	return {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		...overrides,
	} as PiModel;
}

function mockCtx(options: {
	model?: PiModel;
	models?: PiModel[];
	apiKeyResult?: { ok: true; headers?: Record<string, string>; apiKey?: string } | {
		ok: false;
		error: string;
	};
	providerAuth?: { auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string } };
	authStatus?: { configured: boolean };
} = {}): ExtensionContext {
	const {
		model = mockModel(),
		models = [model],
		apiKeyResult = { ok: true, headers: { Authorization: "Bearer sk-ant-oat01-abc" } },
		providerAuth = { auth: { baseUrl: "https://api.anthropic.com" } },
		authStatus = { configured: true },
	} = options;
	return {
		model,
		modelRegistry: {
			getAvailable: () => [],
			getAll: () => models,
			getApiKeyAndHeaders: async () => apiKeyResult,
			getProviderAuth: async () => providerAuth,
			getProviderAuthStatus: () => authStatus,
		},
	} as unknown as ExtensionContext;
}

function mockAuth(): ResolvedUsageAuth {
	return {
		apiKey: "sk-ant-oat01-abc",
		headers: { Authorization: "Bearer sk-ant-oat01-abc" },
		fingerprint: "x".repeat(64),
		secrets: ["sk-ant-oat01-abc"],
		model: mockModel(),
	};
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			new Response(JSON.stringify({ five_hour: {}, seven_day: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("adapterForProvider", () => {
	it("resolves the anthropic and openai-codex adapters", () => {
		expect(adapterForProvider("anthropic")?.id).toBe("anthropic");
		expect(adapterForProvider("openai-codex")?.id).toBe("openai-codex");
	});

	it("returns undefined for unsupported providers", () => {
		expect(adapterForProvider("opencode-cli")).toBeUndefined();
	});
});

describe("resolveUsageAuth", () => {
	it("resolves the anthropic OAuth authorization with a fingerprint", async () => {
		const auth = await resolveUsageAuth(mockCtx(), adapterForProvider("anthropic")!, SALT);
		expect(auth).toBeDefined();
		expect(auth!.headers.Authorization).toBe("Bearer sk-ant-oat01-abc");
		expect(auth!.secrets).toContain("Bearer sk-ant-oat01-abc");
		expect(auth!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(auth!.model.id).toBe("claude-sonnet-5");
	});

	it("fails closed when the current model uses a custom base URL", async () => {
		const ctx = mockCtx({ model: mockModel({ baseUrl: "https://proxy.example.com" }) });
		await expect(resolveUsageAuth(ctx, adapterForProvider("anthropic")!, SALT)).rejects.toThrow(
			/Claude usage cannot send a custom provider base URL credential/,
		);
	});

	it("fails closed when provider auth resolves through a proxy", async () => {
		const ctx = mockCtx({
			providerAuth: { auth: { baseUrl: "https://proxy.example.com" } },
		});
		await expect(resolveUsageAuth(ctx, adapterForProvider("anthropic")!, SALT)).rejects.toThrow(
			/Claude usage cannot send a proxy-resolved credential/,
		);
	});

	it("returns undefined when no candidate model has the official origin", async () => {
		const ctx = mockCtx({ model: mockModel({ provider: "opencode-cli", baseUrl: undefined }) });
		expect(await resolveUsageAuth(ctx, adapterForProvider("anthropic")!, SALT)).toBeUndefined();
	});

	it("throws a redacted error when the registry rejects credential resolution", async () => {
		const ctx = mockCtx({
			apiKeyResult: { ok: false, error: "bad secret sk-ant-oat01-abc" },
		});
		await expect(resolveUsageAuth(ctx, adapterForProvider("anthropic")!, SALT)).rejects.toThrow(
			"bad secret sk-ant-oat01-abc",
		);
	});

	it("returns undefined when no authorization can be derived", async () => {
		const ctx = mockCtx({
			apiKeyResult: { ok: true },
			providerAuth: { auth: {} },
		});
		expect(await resolveUsageAuth(ctx, adapterForProvider("anthropic")!, SALT)).toBeUndefined();
	});

	it("fails closed when the anthropic token is not a claude.ai subscription OAuth token", async () => {
		const ctx = mockCtx({
			apiKeyResult: { ok: true, apiKey: "sk-ant-api03-something" },
			providerAuth: { auth: {} },
		});
		await expect(resolveUsageAuth(ctx, adapterForProvider("anthropic")!, SALT)).rejects.toThrow(
			/Claude usage requires the claude.ai subscription OAuth credential/,
		);
	});
});

describe("anthropic adapter query", () => {
	it("fetches the OAuth usage endpoint with the subscription bearer token", async () => {
		const payload = {
			five_hour: { utilization: 62, resets_at: "2026-08-18T15:30:00.000Z" },
			seven_day: { utilization: 38, resets_at: "2026-08-21T00:00:00.000Z" },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init: RequestInit) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const report = await queryProviderUsage(
			adapterForProvider("anthropic")!,
			mockAuth(),
			new AbortController().signal,
			15_000,
		);
		const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(String(url)).toBe("https://api.anthropic.com/api/oauth/usage");
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer sk-ant-oat01-abc",
		});
		expect(report.providerId).toBe("anthropic");
		expect(report.buckets).toHaveLength(2);
		expect(report.buckets[0].remaining).toBe(38);
		expect(report.buckets[1].remaining).toBe(62);
	});
});

describe("codex adapter query", () => {
	it("fetches the wham usage endpoint", async () => {
		const payload = {
			rate_limit: {
				primary_window: { used_percent: 59, limit_window_seconds: 18_000, reset_at: 1_753_000_000 },
				secondary_window: {
					used_percent: 61,
					limit_window_seconds: 604_800,
					reset_at: 1_753_000_000,
				},
			},
			credits: { has_credits: false },
			rate_limit_reset_credits: { available_count: 0 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL, init: RequestInit) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
		const auth = mockAuth();
		auth.headers = { Authorization: "Bearer codex-jwt" };
		auth.apiKey = "codex-jwt";
		auth.secrets = ["codex-jwt"];
		const report = await queryProviderUsage(
			adapterForProvider("openai-codex")!,
			auth,
			new AbortController().signal,
			15_000,
		);
		const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(report.providerId).toBe("openai-codex");
		expect(report.buckets[0].remaining).toBe(41);
	});
});

function abortableFetchStub(): ReturnType<typeof vi.fn> {
	return vi.fn(
		(_url: string | URL, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener(
					"abort",
					() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					{ once: true },
				);
			}),
	);
}

describe("fetchProviderJson", () => {
	it("rejects with a redacted message on non-2xx responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "token sk-ant-oat01-abc invalid" }), {
					status: 401,
					statusText: "Unauthorized",
				}),
			),
		);
		await expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				new AbortController().signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toThrow(/Claude usage endpoint returned 401 Unauthorized: .*<redacted>/);
	});

	it("throws a timeout error after the deadline", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", abortableFetchStub());
		const rejection = expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				new AbortController().signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toThrow("Timed out after 15s while fetching usage.");
		await vi.advanceTimersByTimeAsync(15_000);
		await rejection;
	});

	it("throws an abort error when the caller aborts", async () => {
		vi.stubGlobal("fetch", abortableFetchStub());
		const controller = new AbortController();
		const rejection = expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				controller.signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejection;
	});

	it("rejects invalid JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not json", { status: 200 })),
		);
		await expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				new AbortController().signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toThrow(/Claude usage endpoint returned invalid JSON/);
	});

	it("rejects non-object JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("[1,2,3]", { status: 200 })),
		);
		await expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				new AbortController().signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toThrow(/Claude usage endpoint response was not an object/);
	});

	it("rejects success bodies over the size bound", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`{"pad":"${"x".repeat(64 * 1024)}"}`, { status: 200 })),
		);
		await expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				new AbortController().signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toThrow(/Claude usage endpoint response exceeded 65536 bytes/);
	});

	it("truncates oversized error bodies with an ellipsis", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(`{"error":"${"y".repeat(8 * 1024)}"}`, { status: 500, statusText: "Nope" }),
			),
		);
		await expect(
			fetchProviderJson(
				"https://api.anthropic.com/api/oauth/usage",
				mockAuth(),
				new AbortController().signal,
				15_000,
				"Claude usage endpoint",
			),
		).rejects.toThrow(/Claude usage endpoint returned 500 Nope: .*…$/);
	});

	it("redacts secrets from query errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "bad token sk-ant-oat01-abc" }), {
					status: 403,
					statusText: "Forbidden",
				}),
			),
		);
		await expect(
			queryProviderUsage(
				adapterForProvider("anthropic")!,
				mockAuth(),
				new AbortController().signal,
				15_000,
			),
		).rejects.toThrow(/<redacted>/);
	});
});

describe("providerIsConfigured", () => {
	it("reports configured from the registry status", () => {
		const ctx = mockCtx({ authStatus: { configured: true } });
		expect(providerIsConfigured(ctx, "anthropic")).toBe(true);
	});

	it("falls back to candidate models when status is unavailable", () => {
		const ctx = {
			model: mockModel(),
			modelRegistry: {
				getAvailable: () => [],
				getAll: () => [],
				getProviderAuthStatus: () => {
					throw new Error("no status");
				},
			},
		} as unknown as ExtensionContext;
		expect(providerIsConfigured(ctx, "anthropic")).toBe(true);
		expect(providerIsConfigured(ctx, "openai-codex")).toBe(false);
	});
});