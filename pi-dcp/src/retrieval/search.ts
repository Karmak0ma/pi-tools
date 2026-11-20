import MiniSearch, { type SearchOptions as EngineOptions } from "minisearch";
import { stemmer } from "stemmer";
import type { Corpus, CorpusSource } from "./corpus.ts";

/**
 * Keyword search over the compressed-history corpus, and paged reads of one source.
 *
 * There are no embeddings and no model calls. The result must be reproducible,
 * cheap, and explainable. Summaries most often lose exact identifiers (paths,
 * symbols, error codes, numbers), and a keyword match finds those exactly.
 *
 * MiniSearch owns the inverted index, BM25 ranking, and typo tolerance. This
 * file owns the rules that MiniSearch cannot know: which tokens are identifiers
 * (see "Term keys"), how a quoted phrase must appear, which document word a
 * query word matched (for the `term~form` labels), and where an excerpt is
 * centred.
 *
 * Output size is capped here, not by callers, so every path returns a bounded
 * tool result.
 */

/** Hard cap on one tool result. Pi sends it to the model on every later request. */
export const MAX_RESULT_CHARS = 12_000;
/** Budget for search hit lines. The rest of the cap is reserved for the header and footers. */
const HIT_BUDGET_CHARS = 10_000;
const DEFAULT_LIMIT = 8;
/** `term~form` pairs shown per hit. Each one is short, but a common word can match dozens of forms. */
const MAX_APPROXIMATE_LABELS = 5;
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
  /**
   * An index built from this corpus's sources (see searchIndexFor). When omitted, a
   * full index is built for this one search, which is correct but costs a build.
   */
  index?: SearchIndex;
}

export interface SearchHit {
  source: CorpusSource;
  excerpt: string;
  /** `term~form` pairs for query terms that matched this source only approximately. */
  approximate: string[];
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
 * Search the corpus. Each query word is looked up in the index, and the word
 * scores add up per source. A quoted phrase must appear in a source, so phrases
 * filter and words rank.
 *
 * Ranking: the sum of the BM25 scores of the query words, so a rare word counts
 * more than a common one, and a source that matches more words scores higher.
 * Branch order breaks ties.
 */
export function searchCorpus(corpus: Corpus, query: string, options: SearchOptions = {}): SearchResult | Failure {
  const parsed = parseQuery(query);
  if (!parsed.terms.length && !parsed.phrases.length) {
    return { ok: false, message: 'The query has no searchable words. Use identifiers or words, or a "quoted phrase".' };
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const inScope = (scopeBlockIds: readonly string[]): boolean => options.blockId === undefined || scopeBlockIds.includes(options.blockId);

  const termHits = parsed.terms.length ? searchWords((options.index ?? searchIndexFor(corpus)).engine, parsed.terms) : new Map<number, TermHit>();
  const ranked = rank(corpus, parsed.phrases, inScope, termHits);

  // Pages are cut by size as well as by count. A page of twenty long excerpts
  // could exceed the result cap, so the page ends early and `nextOffset` names
  // the first hit that was left out. Nothing is silently dropped.
  const hits: SearchHit[] = [];
  let used = 0;
  for (const item of ranked.slice(offset, offset + limit)) {
    // Excerpts and labels are computed for page hits only. Scanning every
    // match of every source would cost far more than the page shows.
    const source = corpus.sources[item.index];
    const detail = describeHit(source.text, parsed.terms, termHits.get(item.index)?.matched, item.phrase);
    const hit: SearchHit = { source, excerpt: excerptAround(source.text, detail.position), approximate: detail.approximate };
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
  // Query tokens stay whole. Only document tokens are split (see tokenPieces),
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

/** Keep a source only if the block filter allows it. */
type InScope = (scopeBlockIds: readonly string[]) => boolean;

/*
 * Term keys. The index stores keys, not words, and a query word becomes keys
 * in exactly the same way, so both sides always reduce the same way.
 *
 * A plain word (letters only, five or more) is stored under its own text and
 * under its stem. A query for `migrate` therefore reaches `migration` through
 * the shared stem `migrat`. Everything else (identifiers, numbers, and short
 * words) is stored under one key that has EXACT_PREFIX, so it matches only
 * itself.
 *
 * Why the prefixes: MiniSearch compares a query word with every stored key, not
 * only plain words. A typo search must not reach identifiers, short words, or
 * stems. The prefixes are non-letters, so a prefixed key is at least two edits
 * from any plain query word, and a one-edit typo never reaches one.
 */
const EXACT_PREFIX = "~~";
const STEM_PREFIX = "~#";
const PLAIN_WORD = /^\p{L}{5,}$/u;

function isPlainWord(token: string): boolean {
  return PLAIN_WORD.test(token);
}

/**
 * The keys for one token. The first key is the token's own key, so an exact
 * match is a match on `keys[0]`. A token with no stem has only that key.
 */
export function termKeys(token: string): string[] {
  if (!isPlainWord(token)) return [EXACT_PREFIX + token];
  return [token, STEM_PREFIX + stemmer(token)];
}

/**
 * Relative weights, applied by MiniSearch on top of BM25. An exact key counts
 * 1.0. A stem counts WEIGHT_STEM, through boostTerm. A typo counts WEIGHT_TYPO,
 * through the fuzzy weight, and MiniSearch also scales that by the length of
 * the matched word. A source with an exact match therefore outranks an
 * otherwise equal source with only a stem or a typo match.
 */
const WEIGHT_STEM = 0.7;
const WEIGHT_TYPO = 0.5;

/**
 * Edits allowed for a typo, for every plain word. An earlier version allowed two
 * edits for nine or more letters. A two-edit neighbour such as `convention` for
 * `conection` then ranked above the correct `connection` when that source was
 * longer, because BM25 length normalisation outweighed the lower typo weight.
 * One edit keeps those neighbours out of the results.
 */
const TYPO_EDITS = 1;

/**
 * Options for one word lookup. The query word is already one whole token, so
 * it is not split at colons. Prefix search is off, so its weight is unused, but
 * MiniSearch requires both weights.
 *
 * Fuzzy applies only to a plain query key, never to a prefixed one. A plain key
 * is letters only, so it is at least two edits from every prefixed key: a typo
 * cannot reach an identifier, a short word, or a stem.
 */
const WORD_SEARCH: EngineOptions = {
  tokenize: (word) => [word],
  prefix: false,
  fuzzy: (term) => (isPlainWord(term) ? TYPO_EDITS : false),
  boostTerm: (term) => (term.startsWith(STEM_PREFIX) ? WEIGHT_STEM : 1),
  weights: { fuzzy: WEIGHT_TYPO, prefix: WEIGHT_TYPO },
  combineWith: "OR",
};

/** One indexed source. `id` is its position in `corpus.sources`, so a hit maps back directly. */
interface IndexedSource {
  id: number;
  text: string;
}

/**
 * True when a query has plain words, which need the index. A query of only quoted
 * phrases is a plain scan of the text, so the caller need not build an index for it.
 */
export function searchNeedsIndex(query: string): boolean {
  return parseQuery(query).terms.length > 0;
}

/** A search index, with the sources it was built from so that a later corpus can be checked against it. */
export interface SearchIndex {
  sources: readonly CorpusSource[];
  engine: MiniSearch<IndexedSource>;
}

/**
 * The index for a corpus. A previous index is returned unchanged when it was
 * built from the same sources (ref and text, in the same order). The index depends
 * on nothing else: topic, label, scope, and the unavailable map do not change what
 * is indexed, and they are read from the corpus on every search. So that
 * comparison is the whole invalidation rule, and a search that changes no source
 * costs only the comparison. The tool adapter keeps the last index per session
 * (see tool.ts).
 */
export function searchIndexFor(corpus: Corpus, previous?: SearchIndex): SearchIndex {
  if (previous && sameIndexedText(previous.sources, corpus.sources)) return previous;
  const engine = new MiniSearch<IndexedSource>({
    fields: ["text"],
    idField: "id",
    tokenize: (text) => [...tokenPieces(text)].map((token) => token.piece),
    processTerm: termKeys,
  });
  engine.addAll(corpus.sources.map((source, id) => ({ id, text: source.text })));
  return { sources: corpus.sources, engine };
}

/** True when both lists hold the same refs and the same texts in the same order, so one index serves both. */
function sameIndexedText(a: readonly CorpusSource[], b: readonly CorpusSource[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].ref !== b[i].ref || a[i].text !== b[i].text) return false;
  }
  return true;
}

/**
 * Each token of a text, with its position. A colon token also yields its
 * prefixes at the same position, so each prefix is found on its own (see
 * colonPrefixes). Positions are used only for excerpts and labels.
 */
function* tokenPieces(text: string): Generator<{ piece: string; position: number }> {
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const whole = normalizeToken(match[0]);
    if (!whole) continue;
    const pieces = whole.includes(":") ? colonPrefixes(whole) : [whole];
    for (const piece of pieces) yield { piece, position: match.index };
  }
}

/** What one source matched: its score, and for each query word, the keys of the source that word matched. */
interface TermHit {
  score: number;
  matched: Map<number, string[]>;
}

/**
 * Look up each query word on its own. A combined query would merge the matched
 * keys of all words, and then a hit could not say which word matched which
 * document word. Each word's `match` gives exactly those keys.
 */
function searchWords(engine: MiniSearch<IndexedSource>, words: readonly string[]): Map<number, TermHit> {
  const hits = new Map<number, TermHit>();
  words.forEach((word, position) => {
    for (const result of engine.search(word, WORD_SEARCH)) {
      const id = result.id as number;
      let hit = hits.get(id);
      if (!hit) {
        hit = { score: 0, matched: new Map() };
        hits.set(id, hit);
      }
      hit.score += result.score;
      hit.matched.set(position, Object.keys(result.match));
    }
  });
  return hits;
}

interface Ranked {
  index: number;
  score: number;
  /** Earliest position of the quoted phrases in the source, when phrases were required. */
  phrase?: number;
}

/**
 * The sources that are results, best first. A quoted phrase is a required
 * filter: every phrase must appear. Words then rank the sources that contain
 * the phrases. Without phrases, any word can match. Scope is applied here, before
 * the caller pages the result.
 */
function rank(corpus: Corpus, phrases: readonly string[], inScope: InScope, termHits: ReadonlyMap<number, TermHit>): Ranked[] {
  const ranked: Ranked[] = [];
  if (phrases.length) {
    for (const [index, phrase] of phrasePositions(corpus, phrases, inScope)) {
      ranked.push({ index, score: termHits.get(index)?.score ?? 0, phrase });
    }
  } else {
    for (const [index, hit] of termHits) {
      if (inScope(corpus.sources[index].scopeBlockIds)) ranked.push({ index, score: hit.score });
    }
  }
  // Branch order breaks ties, so the same query always gives the same order.
  return ranked.sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * The in-scope sources that contain every phrase, with the earliest position of
 * the phrases in each. A phrase is an exact substring of the lowercased text, so
 * it is case-insensitive, as it was before MiniSearch. It needs no index.
 */
function phrasePositions(corpus: Corpus, phrases: readonly string[], inScope: InScope): Map<number, number> {
  const found = new Map<number, number>();
  corpus.sources.forEach((source, index) => {
    if (!inScope(source.scopeBlockIds)) return;
    // Lowercasing copies the whole text, so it is paid only when a phrase was asked for.
    const lower = source.text.toLowerCase();
    let first = Number.POSITIVE_INFINITY;
    for (const phrase of phrases) {
      const at = lower.indexOf(phrase);
      if (at < 0) return;
      first = Math.min(first, at);
    }
    found.set(index, first);
  });
  return found;
}

/** Where an excerpt centres, and the `term~form` pairs for query words that matched only approximately. */
interface HitDetail {
  position: number;
  approximate: string[];
}

/**
 * Find the excerpt centre and the approximate labels of one hit.
 *
 * The excerpt centres on the earliest exact match, a query word or a phrase, so
 * a typo that comes earlier in the text does not pull the excerpt away from the
 * real hit. Only when nothing matches exactly does it centre on the earliest
 * approximate match.
 *
 * A query word gets labels only when the source has no exact form of it. This
 * is the rule that keeps `matched approximately` from appearing on a hit that
 * also has the exact word. The index stores stems, not surface words, so a
 * stem match is turned back into the words of this source by scanning the text.
 */
function describeHit(text: string, words: readonly string[], matched: ReadonlyMap<number, readonly string[]> | undefined, phrase: number | undefined): HitDetail {
  const ownKeys = new Set(words.map((word) => termKeys(word)[0]));
  const approximateWords: number[] = [];
  words.forEach((word, position) => {
    const keys = matched?.get(position);
    if (keys && !keys.includes(termKeys(word)[0])) approximateWords.push(position);
  });

  let exactAt = phrase ?? Number.POSITIVE_INFINITY;
  let approximateAt = Number.POSITIVE_INFINITY;
  const labels = new Set<string>();
  for (const { piece, position } of tokenPieces(text)) {
    // Tokens come in text order, so once one is past the best exact match, and
    // no label is left to find, the rest of the text cannot change the result.
    if (approximateWords.length === 0 && position > exactAt) break;
    const [own, stem] = termKeys(piece);
    if (ownKeys.has(own) && position < exactAt) exactAt = position;
    for (const word of approximateWords) {
      const keys = matched!.get(word)!;
      // A typo matches the piece itself. A word form matches its stem key.
      if (!keys.includes(own) && !(stem !== undefined && keys.includes(stem))) continue;
      labels.add(`${words[word]}~${piece}`);
      approximateAt = Math.min(approximateAt, position);
    }
  }

  const position = Number.isFinite(exactAt) ? exactAt : Number.isFinite(approximateAt) ? approximateAt : 0;
  return { position, approximate: [...labels] };
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
  // An approximate hit can show a word that looks like the query word without
  // being it. The line names the word that matched, so the model can judge the excerpt.
  // A common word can match many forms, so the pairs shown are capped. The count
  // of the rest is still shown, so the model knows the list is not complete.
  const shown = hit.approximate.slice(0, MAX_APPROXIMATE_LABELS);
  const more = hit.approximate.length - shown.length;
  const approximate = shown.length ? `\n   matched approximately: ${shown.join(", ")}${more ? ` (and ${more} more)` : ""}` : "";
  return `${number}. ${hit.source.ref} (${hit.source.kind}) | ${hit.source.label} | topic: ${hit.source.topic}${timestamp}\n   ${hit.excerpt}${approximate}`;
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
