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
import { normalizeGitHubCopilotUsagePayload } from "./providers/github-copilot.js";
import {
	publishSharedFailure,
	publishSharedReport,
	readSharedProviderEntry,
	readSharedReportFile,
	SHARED_REPORT_PATH,
} from "./shared-report.js";
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
	normalizeGitHubCopilotUsagePayload,
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
	publishSharedFailure,
	publishSharedReport,
	readSharedProviderEntry,
	readSharedReportFile,
	SHARED_REPORT_PATH,
};

export default usageExtension;

export type { SharedProviderEntry, SharedReportFile } from "./shared-report.js";

export type {
	AnthropicOauthUsagePayload,
	CodexBackendPayload,
	GitHubCopilotUsagePayload,
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