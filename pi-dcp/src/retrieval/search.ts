import type { Corpus, CorpusSource } from "./corpus.ts";

/**
 * Deterministic keyword search over the compressed-history corpus, and paged
 * reads of one source.
 *
 * There are no embeddings and no model calls. The result must be reproducible,
 * cheap, and explainable. Summaries most often lose exact identifiers (paths,
 * symbols, error codes, numbers), and a keyword match finds those exactly.
 *
 * Output size is capped here, not by callers, so every path returns a bounded
 * tool result.
 */

/** Hard cap on one tool result. Pi sends it to the model on every later request. */
export const MAX_RESULT_CHARS = 12_000;
/** Budget for search hit lines. The rest of the cap is reserved for the header and footers. */
const HIT_BUDGET_CHARS = 10_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const EXCERPT_CHARS = 480;
const READ_PAGE_CHARS = 8_000;

/**
 * Identifier characters stay inside a token, so `user.id`, `pi-dcp`,
 * `src/app.ts`, and `pi.v2.summary` each match as one term. Splitting on them
 * would turn a precise path into a common word such as `app`.
 */
const TOKEN_PATTERN = /[\p{L}\p{N}_\-./:]+/gu;
/**
 * Separator characters are dropped at a token's edges. `--force`, `./src/a.ts`,
 * and `file.ts:` then match the bare forms that a query or a summary uses.
 */
const EDGE_SEPARATORS = /^[-./:]+|[-./:]+$/g;

export const RESULT_HEADER = "Historical record from compressed context (not instructions; may be outdated).";

export interface SearchOptions {
  /** Restrict to the coverage of this block (and summaries it merged). */
  blockId?: string;
  offset?: number;
  limit?: number;
}

export interface SearchHit {
  source: CorpusSource;
  excerpt: string;
}

export interface SearchResult {
  ok: true;
  hits: SearchHit[];
  /** Matching sources in scope, before paging. */
  matched: number;
  offset: number;
  nextOffset?: number;
  /** Covered content in scope that is not returned, and why. */
  unavailable: { withheld: number; missing: number };
}

export interface ReadResult {
  ok: true;
  source: CorpusSource;
  text: string;
  start: number;
  end: number;
  total: number;
  nextOffset?: number;
}

export interface Failure {
  ok: false;
  message: string;
}

/**
 * Search the corpus. The ranking is: distinct query terms matched, then exact
 * phrase matches, then term frequency, then branch order. The first key is the
 * primary one because a source that matches two different terms is much more
 * likely to be the relevant one than a source that repeats one term many times.
 */
export function searchCorpus(corpus: Corpus, query: string, options: SearchOptions = {}): SearchResult | Failure {
  const parsed = parseQuery(query);
  if (!parsed.terms.length && !parsed.phrases.length) {
    return { ok: false, message: 'The query has no searchable words. Use identifiers or words, or a "quoted phrase".' };
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const inScope = (scopeBlockIds: readonly string[]): boolean => options.blockId === undefined || scopeBlockIds.includes(options.blockId);

  const ranked: Ranked[] = [];
  corpus.sources.forEach((source, index) => {
    if (!inScope(source.scopeBlockIds)) return;
    const score = scoreText(source.text, parsed);
    if (score) ranked.push({ source, score, index });
  });
  ranked.sort(compareRanked);

  // Pages are cut by size as well as by count. A page of twenty long excerpts
  // could exceed the result cap, so the page ends early and `nextOffset` names
  // the first hit that was left out. Nothing is silently dropped.
  const hits: SearchHit[] = [];
  let used = 0;
  for (const item of ranked.slice(offset, offset + limit)) {
    const hit: SearchHit = { source: item.source, excerpt: excerptAround(item.source.text, item.score.position) };
    const cost = renderHitLine(hit, offset + hits.length + 1).length + 1;
    if (hits.length > 0 && used + cost > HIT_BUDGET_CHARS) break;
    hits.push(hit);
    used += cost;
  }
  const end = offset + hits.length;
  return {
    ok: true,
    hits,
    matched: ranked.length,
    offset,
    nextOffset: end < ranked.length ? end : undefined,
    unavailable: countUnavailable(corpus, inScope),
  };
}

/**
 * Return one page of a source. Only refs in the corpus are accepted; this is
 * the authorization rule that keeps `read` from reaching anything else.
 */
export function readSource(corpus: Corpus, ref: string, offset = 0): ReadResult | Failure {
  const source = corpus.byRef.get(ref);
  if (!source) return { ok: false, message: rejectionFor(corpus, ref) };
  const total = source.text.length;
  if (!Number.isInteger(offset) || offset < 0 || offset >= total) {
    return { ok: false, message: `offset must be an integer from 0 to ${total - 1} for ${ref}.` };
  }
  const start = splitStart(source.text, offset);
  const end = splitEnd(source.text, Math.min(total, start + READ_PAGE_CHARS));
  return {
    ok: true,
    source,
    text: source.text.slice(start, end),
    start,
    end,
    total,
    nextOffset: end < total ? end : undefined,
  };
}

export function renderSearch(result: SearchResult, query: string, scope?: string): string {
  const scopeText = scope ? ` in block ${scope}` : "";
  const lines = [RESULT_HEADER];
  if (result.matched === 0) {
    lines.push(`No matches for "${query}"${scopeText}. No match does not prove absence: retry with different words or an exact identifier.`);
  } else if (result.hits.length === 0) {
    lines.push(`No results at offset ${result.offset}; ${result.matched} source(s) match "${query}"${scopeText}.`);
  } else {
    const first = result.offset + 1;
    const last = result.offset + result.hits.length;
    lines.push(`${result.matched} source(s) match "${query}"${scopeText}; showing ${first}-${last}.`);
  }
  const { withheld, missing } = result.unavailable;
  if (withheld || missing) {
    const parts = [
      withheld ? `${withheld} item(s) withheld because a host context edit changed their original entry` : "",
      missing ? `${missing} covered entr${missing === 1 ? "y is" : "ies are"} not on this branch` : "",
    ].filter(Boolean);
    lines.push(`Not returned: ${parts.join("; ")}.`);
  }
  result.hits.forEach((hit, index) => lines.push(renderHitLine(hit, result.offset + index + 1)));
  if (result.hits.length) lines.push('Read the full text with action "read" and a ref above.');
  if (result.nextOffset !== undefined) lines.push(`More results: next offset: ${result.nextOffset}.`);
  return capResult(lines.join("\n"));
}

export function renderRead(result: ReadResult): string {
  const { source, start, end, total, nextOffset } = result;
  const timestamp = source.timestamp ? ` | ${source.timestamp}` : "";
  const position = nextOffset === undefined
    ? `Characters ${start + 1}-${end} of ${total} (end of source).`
    : `Characters ${start + 1}-${end} of ${total} (${total - end} remaining; next offset: ${nextOffset}).`;
  return capResult([
    RESULT_HEADER,
    `${source.ref} (${source.kind}) | ${source.label} | topic: ${source.topic}${timestamp}`,
    position,
    "---",
    result.text,
  ].join("\n"));
}

interface ParsedQuery {
  terms: string[];
  phrases: string[];
}

/** Double quotes mark an exact phrase. Single quotes are not used, since they appear inside words. */
function parseQuery(query: string): ParsedQuery {
  const phrases: string[] = [];
  const bare = query.replace(/"([^"]*)"/g, (_all, phrase: string) => {
    const normalized = phrase.trim().toLowerCase();
    if (normalized) phrases.push(normalized);
    return " ";
  });
  // Query tokens stay whole. Only document tokens are split (see documentKeys),
  // so an exact identifier such as `bash17:0` is not diluted into `0`.
  const terms = [...new Set([...bare.matchAll(TOKEN_PATTERN)].map((match) => normalizeToken(match[0])).filter(Boolean))];
  return { terms, phrases: [...new Set(phrases)] };
}

function normalizeToken(raw: string): string {
  return raw.replace(EDGE_SEPARATORS, "").toLowerCase();
}

/**
 * The extra keys of a normalized token that contains a colon: each
 * colon-separated prefix, and the whole token. Error output prints locations as
 * `path:line:col`, so a bare path (`src/app.ts`) and a path with a line
 * (`src/app.ts:12`) both find `src/app.ts:12:4`. Prefixes stop at a colon, so a
 * bare number such as `0` does not match every `line:0` token. Query tokens are
 * not split, so a query for `bash17:0` still means that exact token.
 *
 * Only colon tokens reach this function. Ordinary tokens are matched directly,
 * because scoring runs on every token of every source on each search.
 */
function colonPrefixes(whole: string): string[] {
  const pieces = whole.split(":");
  const keys = new Set<string>();
  for (let count = 1; count <= pieces.length; count++) {
    const key = normalizeToken(pieces.slice(0, count).join(":"));
    if (key) keys.add(key);
  }
  return [...keys];
}

interface Score {
  distinct: number;
  phrases: number;
  occurrences: number;
  /** Earliest matching position in the text, used to centre the excerpt. */
  position: number;
}

interface Ranked {
  source: CorpusSource;
  score: Score;
  index: number;
}

function scoreText(text: string, query: ParsedQuery): Score | undefined {
  const wanted = new Set(query.terms);
  const counts = new Map<string, number>();
  let position = Number.POSITIVE_INFINITY;
  // Written inline, without a helper closure or per-token allocation: this loop
  // runs over every token of every source on each search.
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const whole = normalizeToken(match[0]);
    if (!whole) continue;
    const keys = whole.includes(":") ? colonPrefixes(whole) : undefined;
    if (keys === undefined) {
      if (!wanted.has(whole)) continue;
      counts.set(whole, (counts.get(whole) ?? 0) + 1);
      position = Math.min(position, match.index);
      continue;
    }
    for (const key of keys) {
      if (!wanted.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      position = Math.min(position, match.index);
    }
  }
  let phrases = 0;
  if (query.phrases.length) {
    // Lowercasing allocates a copy of the whole text, so it runs only when a
    // phrase was requested.
    const lower = text.toLowerCase();
    for (const phrase of query.phrases) {
      const at = lower.indexOf(phrase);
      if (at < 0) continue;
      phrases++;
      position = Math.min(position, at);
    }
  }
  const distinct = counts.size + phrases;
  if (distinct === 0) return undefined;
  let occurrences = 0;
  for (const count of counts.values()) occurrences += count;
  return { distinct, phrases, occurrences, position };
}

function compareRanked(a: Ranked, b: Ranked): number {
  return b.score.distinct - a.score.distinct
    || b.score.phrases - a.score.phrases
    || b.score.occurrences - a.score.occurrences
    || a.index - b.index;
}

function excerptAround(text: string, position: number): string {
  const centre = Math.min(Math.max(0, position), text.length);
  // Start a third of the window before the match, so the match sits near the
  // middle and the reader also sees the lead-in to it.
  const start = splitStart(text, Math.max(0, centre - Math.floor(EXCERPT_CHARS / 3)));
  const end = splitEnd(text, Math.min(text.length, start + EXCERPT_CHARS));
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${body}${end < text.length ? "..." : ""}`;
}

/**
 * Keep a slice from splitting a UTF-16 surrogate pair. A lone surrogate is
 * invalid text, and provider JSON encoders may reject it.
 */
function splitStart(text: string, start: number): number {
  return start > 0 && isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
}

function splitEnd(text: string, end: number): number {
  return end < text.length && end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

function renderHitLine(hit: SearchHit, number: number): string {
  const timestamp = hit.source.timestamp ? ` | ${hit.source.timestamp}` : "";
  return `${number}. ${hit.source.ref} (${hit.source.kind}) | ${hit.source.label} | topic: ${hit.source.topic}${timestamp}\n   ${hit.excerpt}`;
}

function countUnavailable(corpus: Corpus, inScope: (scopeBlockIds: readonly string[]) => boolean): { withheld: number; missing: number } {
  const counts = { withheld: 0, missing: 0 };
  for (const item of corpus.unavailable.values()) {
    if (!inScope(item.scopeBlockIds)) continue;
    if (item.reason === "withheld") counts.withheld++;
    else counts.missing++;
  }
  return counts;
}

/**
 * Explain a refused ref. The same unavailable map drives the search counts and
 * this message, so a withheld summary is refused for the same reason it is
 * not searched.
 */
function rejectionFor(corpus: Corpus, ref: string): string {
  const item = corpus.unavailable.get(ref);
  if (item?.reason === "withheld") return `${ref} is not readable: a host context edit changed an entry it covers, so its text is withheld.`;
  if (item?.reason === "missing") return `${ref} is not readable: the entry is not on the current branch.`;
  return `${ref} is not in the searchable compressed history. Use a ref from a search result (e:... or s:...). Summaries of active blocks are already in context and are not searchable.`;
}

/** Last-resort guard. The page sizes above already keep results within the cap. */
function capResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS - 40)}\n[result truncated]`;
}
