import {
	abortError,
	awaitWithDeadline,
	errorMessage,
	fingerprintResolvedAuth,
	redactUsageError,
	runWithConcurrency,
	sanitizeDisplayText,
	UsageCache,
} from "./core.js";
import { formatProviderStates, formatUsageReport, formatUsageStatusline } from "./format.js";
import {
	adapterForProvider,
	isStaleExtensionContextError,
	providerIsConfigured,
	queryProviderUsage,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
} from "./query.js";
import { normalizeAnthropicOauthUsagePayload } from "./providers/anthropic.js";
import { normalizeCodexBackendPayload } from "./providers/codex.js";
import usageExtension from "./usage.js";

export {
	adapterForProvider,
	isStaleExtensionContextError,
	providerIsConfigured,
	queryProviderUsage,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
	normalizeAnthropicOauthUsagePayload,
	normalizeCodexBackendPayload,
	formatProviderStates,
	formatUsageReport,
	formatUsageStatusline,
	abortError,
	awaitWithDeadline,
	errorMessage,
	fingerprintResolvedAuth,
	redactUsageError,
	runWithConcurrency,
	sanitizeDisplayText,
	UsageCache,
};

export default usageExtension;

export type {
	AnthropicOauthUsagePayload,
	CodexBackendPayload,
	PiModel,
	ProviderUsageState,
	ResolvedUsageAuth,
	UsageBucket,
	UsageDisplayState,
	UsageMetric,
	UsageModel,
	UsageProviderAdapter,
	UsageReport,
	UsageSemantics,
	UsageSemanticsKind,
	UsageUnit,
} from "./types.js";