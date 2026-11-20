import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createEnvelope, OPERATION_CUSTOM_TYPE, type CreatedBlock, type OpEnvelope } from "../../src/state/operations.ts";
import { emptyState, markAvailability, reduceEnvelope, type ReducedState } from "../../src/state/reducer.ts";
import { reconstructFromBranch } from "../../src/state/reconstruct.ts";
import { buildSearchCorpus } from "../../src/retrieval/corpus.ts";
import { MAX_RESULT_CHARS, readSource, renderRead, renderSearch, searchCorpus, searchIndexFor, termKeys } from "../../src/retrieval/search.ts";

// Entries are built as Pi stores them. Blocks are applied through the real
// reducer, so coverage and summary semantics match production state.

let clock = 0;
const at = (): string => new Date(1_700_000_000_000 + (++clock) * 1000).toISOString();

function entry(id: string, message: Record<string, unknown>): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: at(), message: { timestamp: clock, ...message } } as unknown as SessionEntry;
}
const userText = (id: string, text: string) => entry(id, { role: "user", content: text });
const toolResult = (id: string, toolName: string, text: string) => entry(id, { role: "toolResult", toolCallId: `${id}-call`, toolName, content: [{ type: "text", text }], isError: false });
const assistant = (id: string, content: unknown[]) => entry(id, { role: "assistant", content, api: "test", provider: "test", model: "test", stopReason: "stop" });

function block(blockId: string, options: { entries?: string[]; effective?: string[]; summary?: string; consumed?: string[]; nestedDepth?: number; topic?: string; recall?: string[] }): CreatedBlock {
  const summary = options.summary ?? `summary of ${blockId}`;
  return {
    blockId,
    ordinal: 0,
    topic: options.topic ?? `topic ${blockId}`,
    summary,
    authoredSummary: summary,
    estimatedSummaryTokens: 10,
    coverage: {
      directEntryIds: options.entries ?? [],
      effectiveEntryIds: options.effective ?? options.entries ?? [],
      directToolCallIds: [],
      effectiveToolCallIds: [],
    },
    anchor: {},
    consumedBlockIds: options.consumed ?? [],
    nestedDepth: options.nestedDepth ?? 0,
    ...(options.recall ? { recall: options.recall } : {}),
  };
}

let operations = 0;
/** One compression.created operation, as lifecycle.ts would persist it. */
function operation(...blocks: CreatedBlock[]): OpEnvelope {
  const index = ++operations;
  return createEnvelope({
    type: "compression.created",
    runId: `run-${index}`,
    mode: "range",
    toolCallId: `call-${index}`,
    snapshotHash: `snapshot-${index}`,
    model: { provider: "test", id: "test", api: "test" },
    blocks: blocks.map((item, ordinal) => ({ ...item, ordinal })),
  }, "session", "0.2.0", `request-${index}`);
}

function apply(state: ReducedState, ...blocks: CreatedBlock[]): ReducedState {
  const next = reduceEnvelope(state, operation(...blocks));
  if (next.corruptReason) throw new Error(`test operation rejected: ${next.corruptReason}`);
  return next;
}

describe("search_compressed corpus", () => {
  it("finds an exact detail in an entry covered by an active block, and not in the active summary", () => {
    const entries = [
      userText("u0", "unrelated ERR_NOT_COVERED note"),
      userText("u1", "why does the migration hang?"),
      assistant("a1", [
        { type: "text", text: "Running the migration." },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run migrate -- --env staging" } },
      ]),
      toolResult("r1", "bash", "ERR_MIGRATION_LOCK_TIMEOUT at db/lock.ts:42\nlock held by pid 9134"),
    ];
    const state = apply(emptyState(), block("b1", { entries: ["u1", "a1", "r1"], summary: "Migration hung on a lock." }));
    const corpus = buildSearchCorpus(entries, state);

    const result = searchCorpus(corpus, "ERR_MIGRATION_LOCK_TIMEOUT");
    expect(result).toMatchObject({ ok: true, matched: 1 });
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.hits[0].source).toMatchObject({ ref: "e:r1", kind: "entry", label: "tool result (bash)", topic: "topic b1" });
    expect(result.hits[0].excerpt).toContain("pid 9134");

    // Uncovered history is already visible to the model, and an active summary
    // is already in context, so neither is returned.
    expect(searchCorpus(corpus, "NOT_COVERED")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpus, "hung")).toMatchObject({ ok: true, matched: 0 });
  });

  it("covers merged children and merged-away summaries, and filters by block", () => {
    const entries = [
      userText("e1", "first phase note: tokenparser handles spaces"),
      toolResult("e2", "read", "src/parse.ts: tokenparser config"),
      userText("e3", "second phase gamma"),
    ];
    let state = apply(emptyState(), block("b1", { entries: ["e1", "e2"], summary: "phase one alphasummary" }));
    state = apply(state, block("b2", { entries: ["e3"], effective: ["e1", "e2", "e3"], consumed: ["b1"], nestedDepth: 1, summary: "merged betasummary" }));
    const corpus = buildSearchCorpus(entries, state);

    const children = searchCorpus(corpus, "tokenparser");
    expect(children).toMatchObject({ ok: true, matched: 2 });
    if (!children.ok) throw new Error("unexpected failure");
    // Both sources are covered. Their order is by BM25, and the shorter one ranks first, so the order is not asserted here.
    expect(children.hits.map((hit) => hit.source.ref).sort()).toEqual(["e:e1", "e:e2"]);
    expect(children.hits[0].source.topic).toBe("topic b2");

    // The merged-away child's summary is searchable; the active merged summary is not.
    const merged = searchCorpus(corpus, "alphasummary");
    expect(merged.ok && merged.hits.map((hit) => hit.source.ref)).toEqual(["s:b1"]);
    expect(searchCorpus(corpus, "betasummary")).toMatchObject({ ok: true, matched: 0 });

    // A block filter selects that block's coverage. The child's summary belongs
    // to its parent's scope, but not to the child's own scope.
    expect(searchCorpus(corpus, "tokenparser", { blockId: "b1" })).toMatchObject({ ok: true, matched: 2 });
    expect(searchCorpus(corpus, "alphasummary", { blockId: "b1" })).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpus, "alphasummary", { blockId: "b2" })).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, "tokenparser", { blockId: "b9" })).toMatchObject({ ok: true, matched: 0 });
  });

  it("excludes thinking, system, pi-dcp messages, and withheld entries; reports missing coverage", () => {
    const entries = [
      assistant("a1", [{ type: "thinking", thinking: "thinkingsecret" }, { type: "text", text: "visible answer" }]),
      entry("s0", { role: "system", content: "systemsecret" }),
      { type: "custom_message", id: "cm1", parentId: null, timestamp: at(), customType: "pi-dcp.v2.notification", content: "dcpnotice", display: true },
      { type: "custom_message", id: "cm2", parentId: null, timestamp: at(), customType: "subagent-result", content: [{ type: "text", text: "subagentfinding" }, { type: "image", data: "AAAA", mimeType: "image/png" }], display: true },
      userText("edited", "editedsecret value"),
      { type: "context_edit", id: "edit1", parentId: null, timestamp: at(), targetId: "edited", replacement: null },
      // "gone" is covered but absent from this branch, as a sibling's entry would be.
    ] as SessionEntry[];
    const state = apply(emptyState(), block("b1", { entries: ["a1", "s0", "cm1", "cm2", "edited", "gone"] }));
    const corpus = buildSearchCorpus(entries, state);

    for (const hidden of ["thinkingsecret", "systemsecret", "dcpnotice", "editedsecret"]) {
      expect(searchCorpus(corpus, hidden)).toMatchObject({ ok: true, matched: 0 });
    }
    const found = searchCorpus(corpus, "subagentfinding");
    expect(found.ok && found.hits[0].source).toMatchObject({ ref: "e:cm2", label: "custom (subagent-result)" });
    expect(searchCorpus(corpus, "image omitted")).toMatchObject({ ok: true, matched: 1 });

    expect(searchCorpus(corpus, "visible")).toMatchObject({ ok: true, unavailable: { withheld: 1, missing: 1 } });
    expect(readSource(corpus, "e:edited")).toMatchObject({ ok: false, message: expect.stringContaining("withheld") });
    expect(readSource(corpus, "e:gone")).toMatchObject({ ok: false, message: expect.stringContaining("not on the current branch") });
  });

  it("withholds a hidden summary whose block covers a host-edited entry", () => {
    const entries = [userText("e1", "secret line"), userText("e2", "other line")];
    const edit = { type: "context_edit", id: "edit1", parentId: null, timestamp: at(), targetId: "e1", replacement: null } as unknown as SessionEntry;
    let state = apply(emptyState(), block("b1", { entries: ["e1"], summary: "summary restating redactedterm" }));
    state = apply(state, block("b2", { entries: ["e2"], effective: ["e1", "e2"], consumed: ["b1"], nestedDepth: 1, summary: "merged summary" }));
    const corpus = buildSearchCorpus([...entries, edit], state);

    // The summary may restate the redacted text, so it is withheld like the entry.
    expect(searchCorpus(corpus, "redactedterm")).toMatchObject({ ok: true, matched: 0, unavailable: { withheld: 2, missing: 0 } });
    expect(readSource(corpus, "s:b1")).toMatchObject({ ok: false, message: expect.stringContaining("withheld") });
  });

  it("indexes a compress call by its topic only, because its summaries are stored in the block", () => {
    const compress = assistant("a1", [{ type: "toolCall", id: "c1", name: "compress", arguments: { topic: "Auth work", content: [{ startId: "m0001", endId: "m0002", summary: "compresssecret repeated" }] } }]);
    const corpus = buildSearchCorpus([userText("u1", "auth question"), compress], apply(emptyState(), block("b1", { entries: ["u1", "a1"] })));

    expect(searchCorpus(corpus, "compresssecret")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpus, "auth")).toMatchObject({ ok: true, matched: 2 });
  });

  it("keeps entries searchable while their block is unavailable after native compaction", () => {
    const entries = [userText("u1", "lock details ERR_LOCK"), assistant("a1", [{ type: "text", text: "done" }])];
    const compacted = markAvailability(apply(emptyState(), block("b1", { entries: ["u1", "a1"], summary: "lock summary" })), new Set(), new Map());
    expect(compacted.blocks.get("b1")).toMatchObject({ active: false, available: false });

    const corpus = buildSearchCorpus(entries, compacted);
    expect(searchCorpus(corpus, "ERR_LOCK")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, "summary")).toMatchObject({ ok: true, matched: 1 });
  });

  it("searches a hidden summary by its recall cues, but not an active block's cues", () => {
    const entries = [userText("e1", "first phase note"), userText("e2", "second phase note")];
    let state = apply(emptyState(), block("b1", { entries: ["e1"], summary: "phase one", recall: ["SQLite rejection reasons"] }));
    state = apply(state, block("b2", { entries: ["e2"], effective: ["e1", "e2"], consumed: ["b1"], nestedDepth: 1, summary: "merged", recall: ["lock contention figures"] }));
    const corpus = buildSearchCorpus(entries, state);

    // b1 is merged away, so its summary is hidden, and its cues are searchable with it.
    const hidden = searchCorpus(corpus, "SQLite rejection");
    expect(hidden.ok && hidden.hits.map((hit) => [hit.source.ref, hit.source.kind])).toEqual([["s:b1", "summary"]]);
    expect(readSource(corpus, "s:b1")).toMatchObject({ ok: true, text: expect.stringContaining("SQLite rejection reasons") });
    // b2 is active, so its summary and cues are already in the model's context.
    expect(searchCorpus(corpus, "lock contention")).toMatchObject({ ok: true, matched: 0 });
  });

  it("never indexes a block that exists only on a sibling branch", () => {
    // lifecycle.ts rebuilds the state from getBranch() alone. A sibling's
    // compress operation and its entries live in the session file, but are not
    // in this branch's array, so they never reach the state that the corpus reads.
    // The sibling's operation is deliberately left out of branchEntries.
    const branchEntries = [
      userText("u1", "branch note"),
      { type: "custom", id: "op-branch", parentId: null, timestamp: at(), customType: OPERATION_CUSTOM_TYPE, data: operation(block("b1", { entries: ["u1"] })) },
    ] as SessionEntry[];
    const state = reconstructFromBranch(branchEntries).state;
    const corpus = buildSearchCorpus(branchEntries, state);
    expect(corpus.byRef.has("s:sib")).toBe(false);
    expect(searchCorpus(corpus, "siblingsecret")).toMatchObject({ ok: true, matched: 0 });
    expect(readSource(corpus, "e:s1")).toMatchObject({ ok: false });
  });

  it("matches exact identifiers, colon locations, and quoted phrases, and ranks distinct terms first", () => {
    const entries = [
      toolResult("r1", "bash", "error in src/app.ts while calling user.id lookup"),
      toolResult("r2", "bash", "TypeError at src/app.ts:12:4"),
      userText("u1", "please check the lookup later"),
    ];
    const corpus = buildSearchCorpus(entries, apply(emptyState(), block("b1", { entries: ["r1", "r2", "u1"] })));

    // A bare path finds locations, a path with a line finds its location, and
    // a bare number does not match every line:column token.
    expect(searchCorpus(corpus, "src/app.ts")).toMatchObject({ ok: true, matched: 2 });
    expect(searchCorpus(corpus, "src/app.ts:12")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, "src/app.ts:12:4")).toMatchObject({ ok: true, matched: 1 });
    // A query location is not split: `:12:4` does not match the `:12:9` location, but its path and line do.
    const other = buildSearchCorpus([toolResult("r3", "bash", "TypeError at src/app.ts:12:9")], apply(emptyState(), block("b2", { entries: ["r3"] })));
    expect(searchCorpus(other, "src/app.ts:12:4")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(other, "src/app.ts:12")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, "12")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpus, '"user.id lookup"')).toMatchObject({ ok: true, matched: 1 });
    const ranked = searchCorpus(corpus, "lookup later");
    expect(ranked.ok && ranked.hits.map((hit) => hit.source.ref)).toEqual(["e:u1", "e:r1"]);
    expect(searchCorpus(corpus, "--- ...")).toMatchObject({ ok: false });
  });

  it("pages results and keeps every page within the result cap", () => {
    const entries = Array.from({ length: 30 }, (_, index) => toolResult(`r${index}`, "bash", `needle ${index} ${"x".repeat(2000)}`));
    const corpus = buildSearchCorpus(entries, apply(emptyState(), block("b1", { entries: entries.map((item) => item.id) })));

    const first = searchCorpus(corpus, "needle", { limit: 20 });
    if (!first.ok) throw new Error("unexpected failure");
    expect(first.matched).toBe(30);
    // Long excerpts stop the page early instead of overflowing the cap.
    expect(first.hits.length).toBeLessThan(20);
    expect(first.nextOffset).toBe(first.hits.length);
    expect(renderSearch(first, "needle").length).toBeLessThanOrEqual(MAX_RESULT_CHARS);

    const second = searchCorpus(corpus, "needle", { limit: 20, offset: first.nextOffset });
    if (!second.ok) throw new Error("unexpected failure");
    expect(second.hits[0].source.ref).toBe(`e:r${first.hits.length}`);
  });

  it("reads only refs in the corpus, and pages long sources", () => {
    const long = `${"filler line\n".repeat(1000)}ENDMARK final`;
    const corpus = buildSearchCorpus([toolResult("r1", "bash", long)], apply(emptyState(), block("b1", { entries: ["r1"], summary: "hidden summary" })));

    // Authorization: active summaries, unknown entries, and malformed refs are refused.
    expect(readSource(corpus, "s:b1")).toMatchObject({ ok: false });
    expect(readSource(corpus, "e:unknown")).toMatchObject({ ok: false });
    expect(readSource(corpus, "x:r1")).toMatchObject({ ok: false });
    expect(readSource(corpus, "e:r1", long.length)).toMatchObject({ ok: false });

    const first = readSource(corpus, "e:r1");
    if (!first.ok) throw new Error("unexpected failure");
    expect(first.text.length).toBe(8000);
    expect(first.nextOffset).toBe(8000);
    expect(renderRead(first)).toContain(`${long.length - 8000} remaining; next offset: 8000`);
    expect(renderRead(first).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);

    const second = readSource(corpus, "e:r1", first.nextOffset);
    if (!second.ok) throw new Error("unexpected failure");
    expect(second.text).toContain("ENDMARK final");
    expect(second.nextOffset).toBeUndefined();
  });
});

describe("search_compressed fuzzy matching", () => {
  /** One block covers every text, so each text is a searchable entry, `e:u0`, `e:u1`, and so on. */
  function corpusOf(...texts: string[]) {
    const entries = texts.map((text, index) => userText(`u${index}`, text));
    return buildSearchCorpus(entries, apply(emptyState(), block("b1", { entries: entries.map((item) => item.id) })));
  }

  it.each([
    ["migrate", "migrated", "migrating", "migration", "migrations"],
    ["class", "classes"],
    ["state", "states"],
    ["setting", "settings"],
    ["document", "documents", "documented"],
    ["parse", "parsed", "parsing", "parses"],
    ["configure", "configuration", "configured"],
  ])("gives %s and its word forms one shared stem key", (...words) => {
    expect(new Set(words.map((word) => termKeys(word)[1])).size).toBe(1);
  });

  it("finds word forms of a plain word", () => {
    const corpus = corpusOf("the migration finished", "migrating now", "migrated rows", "unrelated text");
    expect(searchCorpus(corpus, "migrate")).toMatchObject({ ok: true, matched: 3 });
  });

  it("finds a typo of one edit, and no more", () => {
    const corpus = corpusOf("the connection timed out", "lookup failed");
    expect(searchCorpus(corpus, "conection")).toMatchObject({ ok: true, matched: 1 });
    // Two edits (a deletion and a substitution) are not matched, at any length.
    expect(searchCorpus(corpus, "conextion")).toMatchObject({ ok: true, matched: 0 });
    // Five letters, two edits from `lookup`.
    expect(searchCorpus(corpus, "lokap")).toMatchObject({ ok: true, matched: 0 });
  });

  it("does not let a two-edit neighbour of a typo outrank the real word", () => {
    // `convention`, `collection`, and the others are two edits from `conection`.
    // The real word is in the longest source, which BM25 would otherwise rank last.
    const corpus = corpusOf("the connection timed out here now", "the convention changed", "the condition held", "the collection grew", "the correction landed");
    const result = searchCorpus(corpus, "conection");
    expect(result).toMatchObject({ ok: true, matched: 1 });
    expect(result.ok && result.hits[0].source.ref).toBe("e:u0");
  });

  it("finds a configure as a word form of configuration", () => {
    const corpus = corpusOf("the configuration file was changed");
    expect(searchCorpus(corpus, "configure")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, "configured")).toMatchObject({ ok: true, matched: 1 });
  });

  it("does not fuzz identifiers, numbers, or short words", () => {
    const corpus = corpusOf("error in app.ts", "bash18 exited", "a car was parked");
    expect(searchCorpus(corpus, "api.ts")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpus, "bash17")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpus, "cat")).toMatchObject({ ok: true, matched: 0 });
    // The exact forms still match.
    expect(searchCorpus(corpus, "app.ts")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, "bash18")).toMatchObject({ ok: true, matched: 1 });
  });

  it("keeps a stem apart from a short word with the same letters", () => {
    // `agreed` stems to `agre`, which is also a short word. The stem key and the exact key differ, so neither finds the other.
    expect(searchCorpus(corpusOf("the agre note"), "agreed")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpusOf("we agreed"), "agre")).toMatchObject({ ok: true, matched: 0 });
  });

  it("does not use identifiers or short words as typo targets", () => {
    // `error5` is one edit from `errors`, and `rate` is one edit from `rates`. Neither is a typo of the other.
    expect(searchCorpus(corpusOf("error5 happened"), "errors")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpusOf("rate limit"), "rates")).toMatchObject({ ok: true, matched: 0 });
  });

  it("ranks an exact match above an otherwise equal approximate match", () => {
    // The approximate source comes first in branch order, so only the weights can put the exact one first.
    const stems = searchCorpus(corpusOf("the migration plan", "the migrate plan"), "migrate");
    expect(stems.ok && stems.hits.map((hit) => hit.source.ref)).toEqual(["e:u1", "e:u0"]);
    const typos = searchCorpus(corpusOf("the connection plan", "the conection plan"), "conection");
    expect(typos.ok && typos.hits.map((hit) => hit.source.ref)).toEqual(["e:u1", "e:u0"]);
  });

  it("keeps a quoted phrase exact", () => {
    const corpus = corpusOf("the migration plan", "the migrate plan");
    expect(searchCorpus(corpus, '"migrate plan"')).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpus, '"migrates plan"')).toMatchObject({ ok: true, matched: 0 });
  });

  it("marks an approximate hit as approximate, and an exact hit as exact", () => {
    const result = searchCorpus(corpusOf("the migration plan", "the migrate plan"), "migrate");
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.hits.map((hit) => hit.approximate)).toEqual([[], ["migrate~migration"]]);
    const text = renderSearch(result, "migrate");
    expect(text).toContain("matched approximately: migrate~migration");
    // Labels show surface words only, never the internal stem or identifier keys.
    expect(result.hits.flatMap((hit) => hit.approximate).some((label) => label.includes("~#") || label.includes("~~"))).toBe(false);
    expect(text.split("matched approximately").length - 1).toBe(1);
  });

  it("caps the approximate pairs shown for one hit, and says how many were left out", () => {
    // Six word forms of `migrate`, and only five are listed.
    const result = searchCorpus(corpusOf("migrated migrating migration migrations migrator migrates"), "migrate");
    if (!result.ok) throw new Error("unexpected failure");
    const line = renderSearch(result, "migrate").split("\n").find((row) => row.includes("matched approximately")) ?? "";
    expect(line.split("~").length - 1).toBe(5);
    expect(line).toContain("(and 1 more)");
  });

  it("ranks a rare exact word above a common word that repeats in one source", () => {
    // Ten sources hold `common` once, and one holds it four times. The rare word appears only in the last source.
    const corpus = corpusOf(
      ...Array.from({ length: 10 }, (_unused, index) => `common note ${index}`),
      "common common common common",
      "rareword once",
    );
    const result = searchCorpus(corpus, "common rareword");
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.hits[0].source.ref).toBe("e:u11");
    expect(result.hits[1].source.ref).toBe("e:u10");
  });

  it("requires a quoted phrase, and lets the other words rank the sources that have it", () => {
    const corpus = corpusOf("the lookup failed with error", "the user.id lookup worked", "error in user.id lookup again");
    // The first source has `error` but not the phrase, so it is not a result. The second has the phrase and no `error`,
    // and it is still a result: the words rank the sources that have the phrase, they do not filter them.
    const result = searchCorpus(corpus, '"user.id lookup" error');
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.hits.map((hit) => hit.source.ref)).toEqual(["e:u2", "e:u1"]);
  });

  it("never serves a stale index: a changed source is found by its new text only", () => {
    // An equal corpus reuses the previous index, and a changed source builds a new one, so each search sees its own corpus.
    const first = searchIndexFor(corpusOf("alphaword here"));
    expect(searchIndexFor(corpusOf("alphaword here"), first)).toBe(first);
    expect(searchIndexFor(corpusOf("betaword here"), first)).not.toBe(first);
    expect(searchCorpus(corpusOf("alphaword here"), "alphaword")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpusOf("betaword here"), "alphaword")).toMatchObject({ ok: true, matched: 0 });
    expect(searchCorpus(corpusOf("betaword here"), "betaword")).toMatchObject({ ok: true, matched: 1 });
    expect(searchCorpus(corpusOf("alphaword here"), "alphaword")).toMatchObject({ ok: true, matched: 1 });
  });

  it("centres the excerpt on the exact match, not on an earlier approximate one", () => {
    const text = `migration ${"filler ".repeat(200)}migrate here`;
    const result = searchCorpus(corpusOf(text), "migrate");
    if (!result.ok) throw new Error("unexpected failure");
    expect(result.hits[0].excerpt).toContain("migrate here");
    expect(result.hits[0].excerpt).not.toContain("migration");
  });
});
