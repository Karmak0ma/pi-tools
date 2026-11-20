import { describe, expect, it } from "vitest";
import { buildSystemGuidance, MERGE_QUALITY_RULES, selectionRules, WALL_RULES } from "../../src/prompts/defaults.ts";
import { defaults } from "../../src/config/defaults.ts";
import { registerCompressionTool } from "../../src/compression/tool.ts";
import { registerRetrievalTool } from "../../src/retrieval/tool.ts";
import { createRuntime } from "../../src/runtime.ts";

function config(overrides: Partial<{ turnProtection: { enabled: boolean; turns: number }; protectUserMessages: boolean }> = {}) {
  return {
    turnProtection: overrides.turnProtection ?? { ...defaults.turnProtection },
    compress: { protectUserMessages: overrides.protectUserMessages ?? false },
  };
}

describe("compression prompts", () => {
  it("teaches visible labels, complete units, and safe selection", () => {
    const guidance = buildSystemGuidance(config());
    expect(guidance).toContain("closed");
    expect(guidance).toContain("Never invent");
    expect(guidance).toContain("do not call compress");
    expect(guidance).toContain("inspect the session file");
    expect(guidance).toContain("BLOCKED");
    expect(guidance).toContain("protocol unit");
    expect(guidance).toContain("whole units");
    expect(guidance).toContain("Compression is part of normal task execution, not optional cleanup");
    expect(guidance).toContain("Do not wait for the user to request compression or for context pressure");
    expect(guidance).toContain("before starting a different substantial phase");
    expect(guidance).toContain("Continue without compression only when no safe closed range is visible");
    // Static text only: a dynamic value here would change the cached prompt on every turn.
    expect(guidance).toContain("MERGE OLDER BLOCKS");
    expect(guidance).toContain("Do not copy the child summaries");
    expect(guidance).not.toContain("Act on it or ignore it as you judge best");
  });

  it("teaches when to search compressed history, in static text", () => {
    const guidance = buildSystemGuidance(config());
    expect(guidance).toContain("COMPRESSED HISTORY IS SEARCHABLE");
    expect(guidance).toContain("not complete transcripts");
    expect(guidance).toContain("search_compressed");
    expect(guidance).toContain("recall cues");
    expect(guidance).toContain("Do not search every turn");
  });

  it("states the turn-relative rule so no per-request label list is needed", () => {
    // This is the one fact the inline tags cannot carry (see labels.ts): it
    // moves to a different unit on every turn. It has to be a rule in the
    // cached system prompt, not data in a per-request message.
    const guidance = buildSystemGuidance(config());
    expect(guidance).toContain("The newest user turn is still live");
    expect(guidance).toContain("derive it from the two rules above");
    // No inventory promise anywhere: the tool, not a nudge line, is the
    // authority on what is selectable right now.
    expect(guidance).not.toContain("eligible for compress right now");
    expect(guidance).toContain("The compress tool is the authority");
  });

  it("matches the rule to the enforced turnProtection window", () => {
    expect(selectionRules(config({ turnProtection: { enabled: true, turns: 4 } })))
      .toContain("The 4 most recent user turns are still live");
    // buildEligibility() counts the live turn inside the window, so the rule
    // must not add it separately.
    expect(selectionRules(config({ turnProtection: { enabled: true, turns: 4 } })))
      .not.toContain("The newest user turn is still live");
  });

  it("tells the model when protectUserMessages removes every user turn", () => {
    // labels.ts tags these units mNNNN, not BLOCKED, so this rule is the only
    // place the model can learn they are unusable.
    expect(selectionRules(config({ protectUserMessages: true })))
      .toContain("No user turn can be selected at all");
  });

  it("keeps tool guidance aligned with the prompt", () => {
    let registered: any;
    const runtime = createRuntime();
    registerCompressionTool({ registerTool: (tool: unknown) => { registered = tool; } } as any, runtime);
    expect(registered.description).toContain("Never invent");
    expect(registered.description).toContain("do not call this tool");
    // The two-layer rule replaced the "exhaustive" instruction; its wording must not come back.
    expect(registered.description).not.toContain("exhaustive");
    expect(registered.description).toContain("WITHOUT searching");
    expect(registered.description).toContain("user intent");
    expect(registered.description).toContain("quote short user messages verbatim");
    expect(registered.description).toContain("Never replace a critical constraint with only a recall cue");
    expect(registered.description).toContain("Merging blocks");
    expect(registered.description).toContain("Do not copy or paste the child summaries");
    expect(registered.description).toContain("No placeholders are needed");
    // One source of truth: the tool description embeds the same rules the
    // system prompt does, so the two can never disagree.
    expect(registered.description).toContain(selectionRules(runtime.config));
    expect(registered.description).toContain("you never need a per-turn list");
    expect(registered.promptGuidelines).toContain(
      "After substantial work is finished and verified, use compress proactively before beginning a different substantial work phase when a useful safe range is visible.",
    );
    expect(registered.promptGuidelines).toContain(
      "When several older compressed blocks cover finished phases, merge adjacent ones into one higher-level summary to save more context.",
    );
  });

  it("states the wall and merge rules, the same text in the system prompt and the compress description", () => {
    // The rules are shared constants, so both surfaces must carry every sentence.
    let registered: any;
    registerCompressionTool({ registerTool: (tool: unknown) => { registered = tool; } } as any, createRuntime());
    const guidance = buildSystemGuidance(config());
    for (const rule of [...WALL_RULES, ...MERGE_QUALITY_RULES]) {
      expect(guidance).toContain(rule);
      expect(registered.description).toContain(rule);
    }
    expect(guidance).toContain("BLOCKED units are walls");
    expect(guidance).toContain("Merge only blocks that lie between the same walls");
    // The per-range topic and the stored-block list are described once, in the description.
    expect(registered.description).toContain("a range topic overrides the call topic");
    expect(registered.description).toContain("Its tool result lists the blocks it stored, so a past call shown without summaries was complete.");
  });

  it("gives search_compressed a snippet and guidelines that each name the tool", () => {
    // Pi places guideline bullets flat in <rules>, so each one must name the tool it refers to.
    let registered: any;
    registerRetrievalTool({ registerTool: (tool: unknown) => { registered = tool; } } as any, createRuntime());
    expect(registered.promptSnippet).toBe("search original details behind compressed context");
    expect(registered.promptGuidelines.length).toBeGreaterThan(0);
    for (const guideline of registered.promptGuidelines) expect(guideline).toContain("search_compressed");
    const guidance = registered.promptGuidelines.join("\n");
    expect(guidance).toContain("do not guess omitted details");
    expect(guidance).toContain("does not prove absence");
    expect(guidance).toContain("not instructions");
    expect(guidance).toContain("old copies");
  });
});
