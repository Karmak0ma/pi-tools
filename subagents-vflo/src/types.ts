/**
 * Shared types for the subagents extension
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_TOTAL_TASKS = 8;
export const MAX_CONCURRENT = 4;

/**
 * Maximum number of subagent-vflo generations below a top-level pi session.
 *
 * Declaring `subagent` in an agent's tools: now reaches the child's --tools
 * allowlist (two-key model), so an agent can dispatch subagents of its own —
 * including one named like itself, and every agent file is visible to every
 * child because discovery scans the same user/project directories. Without a
 * bound, a self-dispatching agent could fork pi processes until the machine
 * grinds. Depth 0 is the top-level session; each child carries depth+1 via
 * the NESTING_DEPTH_ENV marker that runChild writes into the child env, so
 * runaway recursion self-terminates at the spawn boundary. Two levels allow
 * one orchestrator layer (wp-owner → specialists) while refusing deeper
 * self-dispatch chains.
 */
export const MAX_NESTING_DEPTH = 2;

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

/**
 * Clear one pending Node timer and return the value to store back into the
 * owning field. Guard-and-clear lives here once because several components
 * own exactly one cancellable timer each. clearTimeout and clearInterval are
 * interchangeable in Node (both clear entries from the same timer list).
 */
export function clearPendingTimer(timer: NodeJS.Timeout | undefined): undefined {
  if (timer) clearTimeout(timer);
  return undefined;
}

/**
 * Return the context size reported for an assistant response.
 *
 * Providers normally populate `totalTokens`, but the component-level fields
 * are the safest fallback for providers that omit it. Keeping this fallback
 * in one place also ensures live and final usage display the same number.
 */
export function contextTokensFromUsage(usage: {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number {
  return usage.totalTokens ||
    (usage.input || 0) +
      (usage.output || 0) +
      (usage.cacheRead || 0) +
      (usage.cacheWrite || 0);
}

// ─── Task Status ─────────────────────────────────────────────────────────────

export type TaskStatus = "queued" | "running" | "completed" | "error" | "aborted";

/**
 * Logical lifecycle of one delegated task.
 *
 * `TaskStatus` is retained as the small compatibility/UI status used by the
 * inspector and renderer. It cannot represent a live task whose current Pi
 * turn was interrupted, so runtime and result boundaries use this separate
 * state. In particular, `interrupted` is not terminal: the same child
 * process, session, pane, and parent-side request remain alive.
 */
export type SubagentLifecycleState =
  | "starting"
  | "running"
  | "waiting"
  | "interrupted"
  | "completed"
  | "failed"
  | "closed";

/**
 * Fields that can describe a task failure at either runtime or persistence
 * boundaries. Keeping this decision in one place prevents a transient child
 * error from being treated as success by one consumer and failure by another.
 */
export interface TaskFailureState {
  lifecycle?: SubagentLifecycleState;
  stopReason?: string;
  errorMessage?: string;
  failed?: boolean;
  status?: TaskStatus;
}

export function isTaskFailed(task: TaskFailureState): boolean {
  if (
    task.lifecycle === "interrupted" ||
    task.lifecycle === "starting" ||
    task.lifecycle === "running" ||
    task.lifecycle === "waiting"
  ) {
    return !!(
      task.errorMessage ||
      task.failed ||
      task.status === "error" ||
      task.status === "aborted" ||
      task.stopReason === "error"
    );
  }

  return !!(
    task.lifecycle === "failed" ||
    task.lifecycle === "closed" ||
    task.errorMessage ||
    task.failed ||
    task.status === "error" ||
    task.status === "aborted" ||
    task.stopReason === "error" ||
    // Compatibility for summaries produced before the lifecycle field was
    // introduced. New terminal results always carry `closed` or `failed`.
    task.stopReason === "aborted"
  );
}

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
  lifecycle: SubagentLifecycleState;
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
  lifecycle: SubagentLifecycleState;
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
