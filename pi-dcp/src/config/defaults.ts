export const defaults = {
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
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
    minPotentialSavingsTokens: 12000,
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
  summary: { maxChars: 100000, maxExpandedChars: 200000, maxNestedDepth: 8 },
} as const;

export type EffectiveConfig = {
  enabled: boolean;
  debug: boolean;
  pruneNotification: "off" | "minimal" | "summary" | "detailed";
  pruneNotificationType: "chat" | "toast" | "both";
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
  summary: { maxChars: number; maxExpandedChars: number; maxNestedDepth: number };
};
