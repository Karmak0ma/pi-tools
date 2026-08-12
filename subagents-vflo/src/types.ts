/**
 * Shared types for the subagents extension
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_TOTAL_TASKS = 8;
export const MAX_CONCURRENT = 4;

export const ALLOWED_CHILD_BUILTINS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type AllowedChildBuiltin = (typeof ALLOWED_CHILD_BUILTINS)[number];

export const DEFAULT_BUILD_TOOLS: AllowedChildBuiltin[] = ["read", "bash", "edit", "write"];

// ─── Agent Types ─────────────────────────────────────────────────────────────

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  systemPrompt: string;
  source: AgentSource;
  filePath?: string;
}

// ─── Thinking Levels ─────────────────────────────────────────────────────────

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// ─── Task Types ──────────────────────────────────────────────────────────────

export interface TaskItem {
  agent: string;
  task: string;
  model?: string;
  cwd?: string;
  thinking?: ThinkingLevel;
}

// ─── Usage Types ─────────────────────────────────────────────────────────────

export interface TaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function emptyUsage(): TaskUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ─── Task Status ─────────────────────────────────────────────────────────────

export type TaskStatus = "queued" | "running" | "completed" | "error" | "aborted";

// ─── Runtime Tracker Types ───────────────────────────────────────────────────

export interface LiveTaskSummary {
  id: string;
  agent: string;
  source: AgentSource;
  task: string;
  cwd: string;
  model?: string;
  warnings: string[];
  status: TaskStatus;
  isPartial: boolean;
  stopReason?: string;
  errorMessage?: string;
  stderrPreview?: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
  latestOutput: string;
  usage: TaskUsage;
}

// ─── Persisted Details Types ─────────────────────────────────────────────────

export interface PersistedTaskSummary {
  agent: string;
  source: AgentSource;
  task: string;
  cwd: string;
  model?: string;
  warnings: string[];
  stopReason?: string;
  errorMessage?: string;
  stderrPreview?: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
  finalOutput: string;
  usage: TaskUsage;
  failed?: boolean;
}

export interface LiveSubagentToolDetails {
  mode: "tasks";
  live: true;
  taskCount: number;
  summaries: LiveTaskSummary[];
}

export interface PersistedSubagentToolDetails {
  mode: "tasks";
  live?: false;
  taskCount: number;
  summaries: PersistedTaskSummary[];
  overallFailed?: boolean;
}

// ─── Resolution Types ────────────────────────────────────────────────────────

export interface ModelResolutionResult {
  model: string | undefined;
  warnings: string[];
}

export interface ToolResolutionResult {
  tools: string[];
  warnings: string[];
  error?: string;
}

export interface CwdResolutionResult {
  cwd: string;
  error?: string;
}
