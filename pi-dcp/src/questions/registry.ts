import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isPlainObject } from "../util/canonical-json.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import type { PrunedToolDecision } from "../state/operations.ts";
import { collectToolRecords } from "../strategies/deduplicate.ts";

export interface QuestionAdapter { toolName: "question" | "ask_user_question"; inputField: string; redact(input: unknown): unknown; }
const marker = "[Question input cleared by pi-dcp]";
export function adapterForQuestion(toolName: string, args: unknown): QuestionAdapter | undefined { if (toolName === "question" && validQuestion(args)) return { toolName, inputField: "questions", redact: () => marker }; if (toolName === "ask_user_question" && validAskUserQuestion(args)) return { toolName, inputField: "questions", redact: (input) => ({ ...(input as Record<string, unknown>), questions: marker }) }; return undefined; }
export function validQuestion(args: unknown): boolean { return typeof args === "string" || (Array.isArray(args) && args.every((value) => typeof value === "string")); }
export function validAskUserQuestion(args: unknown): boolean { if (!isPlainObject(args) || !Array.isArray(args.questions)) return false; return args.questions.every((question) => isPlainObject(question) && typeof question.header === "string" && typeof question.question === "string" && Array.isArray(question.options) && question.options.every((option) => isPlainObject(option) && typeof option.label === "string" && typeof option.description === "string")); }
export function isQuestionResultPair(messages: readonly AgentMessage[], toolCallId: string): boolean { return messages.some((message) => message.role === "toolResult" && message.toolCallId === toolCallId); }
export function questionPruning(index: CanonicalIndex, existing: ReadonlyMap<string, { questionInput?: unknown }>): PrunedToolDecision[] { return collectToolRecords(index).filter((record) => adapterForQuestion(record.name, record.args) !== undefined && record.result !== undefined && !existing.get(record.toolCallId)?.questionInput).map((record) => ({ toolCallId: record.toolCallId, kind: "question-input" as const, estimatedTokens: Math.max(1, Math.ceil(JSON.stringify(record.args).length / 4)) })); }
