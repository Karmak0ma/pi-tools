export const defaults = {
  enabled: true,
  disabledModels: [] as string[],
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  // Which bar the compress receipt draws in the TUI (detailed notifications
  // only). "regained" is the default: one bar answers both "how full is the
  // context now" and "how much did this call give back". The other styles are
  // a user preference, not a behavior change, so they never touch the
  // model-visible tool result text.
  receiptStyle: "regained",
  commands: { enabled: true, protectedTools: ["compress", "write", "edit", "todo"] as string[] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  nudge: {
    minContextPercent: 35,
    maxContextPercent: 70,
    criticalContextPercent: 90,
    turnsBetweenNudges: 5,
    turnNudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    minPotentialSavingsTokens: 32000,
  },
  protectedFilePatterns: [] as string[],
  compress: {
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100000,
    minContextLimit: 50000,
    modelMaxLimits: {} as Record<string, number | string>,
    modelMinLimits: {} as Record<string, number | string>,
    // No hardcoded floor here (unlike commands.protectedTools): a match
    // absorbs the tool's output into the summary verbatim rather than
    // blocking the range, so "write"/"edit" are deliberately left out by
    // default. The model's own authored summary is trusted to describe what
    // an edit did; only "todo" defaults to verbatim preservation, matching
    // opencode-dynamic-context-pruning's compress-side default.
    protectedTools: ["todo"] as string[],
    protectUserMessages: false,
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] as string[] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] as string[] },
  },
  // No nesting setting: merge depth is the stored-format bound MAX_NESTED_DEPTH
  // (state/operations.ts). A configured lower value would refuse merges that replay accepts.
  summary: { maxChars: 100000 },
} as const;

/**
 * Compress receipt bar styles, shown in the TUI only.
 * - simple: share of the window this call reclaimed. Needs no usage data, so
 *   every other style falls back to it when Pi cannot report usage.
 * - before-after: usage before and after the call, colored by usage level.
 * - regained: one bar, what is still used plus what this call gave back.
 * - full: the context laid out in order (system, raw history, summaries),
 *   plus what this call gave back and a per-compression history.
 */
export const RECEIPT_STYLES = ["simple", "before-after", "regained", "full"] as const;
export type ReceiptStyle = typeof RECEIPT_STYLES[number];

export type EffectiveConfig = {
  enabled: boolean;
  disabledModels: string[];
  debug: boolean;
  pruneNotification: "off" | "minimal" | "summary" | "detailed";
  pruneNotificationType: "chat" | "toast" | "both";
  receiptStyle: ReceiptStyle;
  commands: { enabled: boolean; protectedTools: string[] };
  manualMode: { enabled: boolean; automaticStrategies: boolean };
  turnProtection: { enabled: boolean; turns: number };
  nudge: {
    minContextPercent: number;
    maxContextPercent: number;
    criticalContextPercent: number;
    turnsBetweenNudges: number;
    turnNudgeFrequency: number;
    iterationNudgeThreshold: number;
    minPotentialSavingsTokens: number;
  };
  protectedFilePatterns: string[];
  compress: {
    permission: "allow" | "ask" | "deny";
    showCompression: boolean;
    summaryBuffer: boolean;
    maxContextLimit: number | string;
    minContextLimit: number | string;
    modelMaxLimits: Record<string, number | string>;
    modelMinLimits: Record<string, number | string>;
    protectedTools: string[];
    protectUserMessages: boolean;
  };
  strategies: {
    deduplication: { enabled: boolean; protectedTools: string[] };
    purgeErrors: { enabled: boolean; turns: number; protectedTools: string[] };
  };
  summary: { maxChars: number };
};
