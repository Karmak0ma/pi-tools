/**
 * Agent discovery and configuration
 *
 * Discovers agents from:
 * 1. Built-in fallback agents (explore, build)
 * 2. User agents (~/.pi/agent/agents/*.md)
 * 3. Project agents (nearest ancestor .pi/agents/*.md)
 *
 * Precedence: project > user > builtin
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  type AgentConfig,
  type AgentSource,
  DEFAULT_BUILD_TOOLS,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./types.js";

// ─── Built-in Fallback Agents ────────────────────────────────────────────────

const BUILTIN_AGENTS: AgentConfig[] = [
  {
    name: "explore",
    description: "Fast read-only codebase reconnaissance using the configured Luna model",
    tools: ["read", "grep", "find", "ls", "bash"],
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    systemPrompt: `You are an exploration agent. Your job is to quickly scan and understand codebases.

Rules:
- Do NOT edit any files
- Do NOT run destructive commands
- Use grep, find, and read to gather information
- Be concise in your findings
- Report paths, patterns, and key observations
- If you find what you're looking for, stop immediately`,
    source: "builtin",
  },
  {
    name: "build",
    description: "General-purpose agent with coding capabilities",
    tools: [...DEFAULT_BUILD_TOOLS],
    model: undefined,
    systemPrompt: `You are a build agent. Your job is to implement code changes.

Rules:
- Make targeted, precise edits
- Follow existing code patterns and conventions
- Test your changes when possible
- Be thorough but efficient
- Report what you changed and why`,
    source: "builtin",
  },
];

// ─── Agent File Loading ──────────────────────────────────────────────────────

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

    const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
    if (!name || !description) {
      continue;
    }

    const rawTools = frontmatter.tools;
    const tools = Array.isArray(rawTools)
      ? rawTools
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean)
      : typeof rawTools === "string"
        ? rawTools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

    agents.push({
      name,
      description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: typeof frontmatter.model === "string" && frontmatter.model ? frontmatter.model : undefined,
      thinking:
        typeof frontmatter.thinking === "string" && THINKING_LEVELS.includes(frontmatter.thinking as ThinkingLevel)
          ? (frontmatter.thinking as ThinkingLevel)
          : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

// ─── Directory Discovery ─────────────────────────────────────────────────────

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  userAgentsDir: string;
}

/**
 * Discover all available agents with proper precedence.
 * Always includes both user and project agents.
 * Precedence: project > user > builtin
 */
export function discoverAgents(cwd: string): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  // Build agent map with precedence: project > user > builtin
  const agentMap = new Map<string, AgentConfig>();

  // Start with builtins (lowest priority)
  for (const agent of BUILTIN_AGENTS) {
    agentMap.set(agent.name, agent);
  }

  // User agents override builtins
  for (const agent of userAgents) {
    agentMap.set(agent.name, agent);
  }

  // Project agents override everything
  for (const agent of projectAgents) {
    agentMap.set(agent.name, agent);
  }

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    userAgentsDir: userDir,
  };
}

/**
 * Find a specific agent by name from the discovery result.
 */
export function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((a) => a.name === name);
}

/**
 * Format agent list for display in error messages.
 */
export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `"${a.name}" (${a.source}): ${a.description}`).join("\n");
}
