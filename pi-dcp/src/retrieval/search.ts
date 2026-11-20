import type { Corpus, CorpusSource } from "./corpus.ts";

/**
 * Deterministic keyword search over the compressed-history corpus, and paged
 * reads of one source.
 *
 * There are no embeddings and no model calls. The result must be reproducible,
 * cheap, and explainable. Summaries most often lose exact identifiers (paths,
 * symbols, error codes, numbers), and a keyword match finds those exactly.
 * Plain words also match word forms and small typos; identifiers never do.
 * See "Fuzzy matching" below for the rules and the reasons for them.
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
 * Search the corpus. The ranking is: distinct query terms matched, then exact
 * phrase matches, then term frequency, then branch order. A term counts by the
 * weight of its best match: 1.0 for an exact match, less for a word form or a
 * typo (see WEIGHT_STEM). The first key is the primary one because a source that
 * matches two different terms is much more likely to be the relevant one than a
 * source that repeats one term many times.
 */
export function searchCorpus(corpus: Corpus, query: string, options: SearchOptions = {}): SearchResult | Failure {
  const parsed = parseQuery(query);
  if (!parsed.terms.length && !parsed.phrases.length) {
    return { ok: false, message: 'The query has no searchable words. Use identifiers or words, or a "quoted phrase".' };
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const inScope = (scopeBlockIds: readonly string[]): boolean => options.blockId === undefined || scopeBlockIds.includes(options.blockId);

  const ranked = scoreSources(corpus, parsed, inScope);
  ranked.sort(compareRanked);

  // Pages are cut by size as well as by count. A page of twenty long excerpts
  // could exceed the result cap, so the page ends early and `nextOffset` names
  // the first hit that was left out. Nothing is silently dropped.
  const hits: SearchHit[] = [];
  let used = 0;
  for (const item of ranked.slice(offset, offset + limit)) {
    const hit: SearchHit = { source: item.source, excerpt: excerptAround(item.source.text, item.score.position), approximate: item.score.approximate };
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
 * because the vocabulary build runs over every token of every source on each search.
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

/**
 * Match weights, in tenths. An exact match counts 1.0, a word-form (stem)
 * match 0.7, and a typo match 0.5. Integers keep the sums exact, so equal
 * matches tie exactly. Weights only order results: a source with an exact match
 * for a term always outranks an otherwise equal source with only an approximate
 * match, and an approximate match never turns a miss into a hit.
 */
const WEIGHT_EXACT = 10;
const WEIGHT_STEM = 7;
const WEIGHT_TYPO = 5;

/*
 * Fuzzy matching: word forms (stems) and typos. Both are cheap, local, and
 * deterministic, and both are deliberately narrow. Code history is full of
 * identifiers, and a fuzzy match on an identifier points at the wrong file or the
 * wrong job, so only plain words qualify (see isFuzzyWord).
 */

/**
 * Fuzzy matching applies only to plain words: letters only, at least five of
 * them. Identifiers do not qualify. In `api.ts` or `bash17`, changing one
 * character names another file or job, not a typo. In a short word such as
 * `cat`, one changed letter gives another word (`car`). Such tokens match
 * exactly and nothing else.
 */
const MIN_FUZZY_LENGTH = 5;
const PLAIN_WORD = /^\p{L}+$/u;

/**
 * True when a word may take part in stem and typo matches. It runs for each
 * token that is not yet stored while fuzzy matching is on, so ASCII is checked in
 * a loop that stops at the first non-letter. Labels such as `bash17` fail early.
 * Other text falls back to the Unicode-aware pattern.
 */
function isFuzzyWord(key: string): boolean {
  if (key.length < MIN_FUZZY_LENGTH) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code >= 0x80) return PLAIN_WORD.test(key);
    const isLetter = (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
    if (!isLetter) return false;
  }
  return true;
}

/**
 * Expansions kept per query term. A common word can have hundreds of close
 * neighbours in a large session, and keeping the nearest fifty bounds the scoring
 * work in the worst case. Exact matches sort first, so the cut never drops them.
 */
const MAX_EXPANSIONS_PER_TERM = 50;

/**
 * One edit suits a word of five to eight letters. A longer word can take two
 * edits and still be recognisable, so the limit grows with the length.
 */
function typoLimit(term: string): number {
  return term.length >= 9 ? 2 : 1;
}

/**
 * Shortest stem that stemming may produce. Shorter stems merge unrelated words:
 * without this, `rats` would reduce to `rat`, the stem of `rate`.
 */
const MIN_STEM_LENGTH = 4;

/**
 * Suffixes that stem() strips, tried in this order on each pass. `es` is tried
 * before `s`, so `matches` loses `es` and not only the `s`.
 */
const STEM_SUFFIXES = ["ment", "ing", "ion", "er", "ed", "ly", "es", "s"];

/**
 * A light suffix stripper, not a Porter stemmer. It maps word forms to one
 * stem, so `migrate`, `migrated`, `migrating`, `migration`, and `migrations` all
 * reach `migrat`. Query words and document words go through this same function,
 * so both sides always reduce the same way.
 *
 * Suffixes are stripped repeatedly because they stack: `documents` loses its `s`
 * and then `ment` (`docu`), and `settings` loses `s` and then `ing` (`sett`).
 * The silent `e` goes last, after the suffixes, so `management` (which becomes
 * `manage`) and `manage` both reach `manag`.
 *
 * Known misses, accepted to keep this small: `configure` and `configuration` do
 * not meet, and `library` and `libraries` do not meet.
 */
export function stem(word: string): string {
  let base = word;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const suffix of STEM_SUFFIXES) {
      if (!base.endsWith(suffix) || base.length - suffix.length < MIN_STEM_LENGTH) continue;
      // `class` and `process` are not plurals.
      if (suffix === "s" && base.endsWith("ss")) continue;
      base = base.slice(0, -suffix.length);
      stripped = true;
      break;
    }
  }
  if (base.endsWith("e") && base.length - 1 >= MIN_STEM_LENGTH) base = base.slice(0, -1);
  return base;
}

/**
 * Optimal string alignment distance: insertions, deletions, substitutions, and
 * swaps of two adjacent letters, each counted once. So `recieve` is one edit from
 * `receive`. It returns `limit + 1` as soon as the distance must exceed `limit`.
 * Once a whole row of the table exceeds the limit, no later row can come back
 * under it, so the rest of the table is skipped. Unrelated words cost little.
 */
function boundedDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let grandparent: number[] = [];
  let parent = Array.from({ length: b.length + 1 }, (_unused, column) => column);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column++) {
      const substitution = parent[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      let value = Math.min(parent[column] + 1, current[column - 1] + 1, substitution);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        value = Math.min(value, grandparent[column - 2] + 1);
      }
      current.push(value);
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > limit) return limit + 1;
    grandparent = parent;
    parent = current;
  }
  return parent[b.length] <= limit ? parent[b.length] : limit + 1;
}

interface Score {
  /** Weighted distinct terms: each term's best weight once, and each phrase at the exact weight. */
  distinct: number;
  phrases: number;
  /** Occurrences of the best-weight match of each term. */
  occurrences: number;
  /** Start of the best match. The excerpt centres on it. */
  position: number;
  /** `term~form` pairs for terms whose best match in this source is approximate. */
  approximate: string[];
}

interface Ranked {
  source: CorpusSource;
  score: Score;
  index: number;
}

/**
 * The tokens that a search can match, built once per search over the in-scope
 * sources.
 *
 * Each stored token text gets an integer id the first time it is seen. An entry
 * then records one (token, source) pair: the token id, the source, how often the
 * token occurs there, and its first position there. Entries are kept in flat
 * parallel arrays, not one object per token, because a session can hold tens of
 * thousands of distinct words and an object per word is what made this slow.
 *
 * Query terms are expanded against the unique texts, not against every
 * occurrence, so the expensive comparison runs once per unique token. Scoring is
 * then one pass over the entries.
 */
interface Vocabulary {
  /** Stored token text, by id. */
  keys: string[];
  ids: Map<string, number>;
  /** Index into the entry arrays of each token's most recent entry, by id. */
  lastEntry: number[];
  entryIds: number[];
  entrySources: number[];
  entryCounts: number[];
  /** First occurrence of the token in its source. The excerpt centres on the best one. */
  entryPositions: number[];
  /** Plain words by stem, for word-form matches. */
  byStem: Map<string, string[]>;
  /** Plain words, for typo matches. */
  plainWords: string[];
}

/**
 * Index the tokens of the in-scope sources. A token is stored only if it can
 * match something: a query term (an exact match), or, when some query term can
 * take a fuzzy match, a plain word (a candidate for a word form or a typo). Every
 * other token, such as the line label `bash17:0`, matches no query that does not
 * name it, so it is skipped. A query of identifiers alone therefore pays for
 * almost no vocabulary, and the ordinary words of the session are not stored.
 */
function buildVocabulary(corpus: Corpus, terms: readonly string[], inScope: InScope): Vocabulary {
  const vocabulary: Vocabulary = {
    keys: [],
    ids: new Map(),
    lastEntry: [],
    entryIds: [],
    entrySources: [],
    entryCounts: [],
    entryPositions: [],
    byStem: new Map(),
    plainWords: [],
  };
  const wanted = new Set(terms);
  const fuzzy = terms.some(isFuzzyWord);
  corpus.sources.forEach((source, index) => {
    if (!inScope(source.scopeBlockIds)) return;
    // A plain loop, without a helper closure per token: it runs over every token
    // of every in-scope source on each search.
    for (const match of source.text.matchAll(TOKEN_PATTERN)) {
      const whole = normalizeToken(match[0]);
      if (!whole) continue;
      if (whole.includes(":")) {
        for (const key of colonPrefixes(whole)) addOccurrence(vocabulary, wanted, fuzzy, key, index, match.index);
      } else {
        addOccurrence(vocabulary, wanted, fuzzy, whole, index, match.index);
      }
    }
  });
  return vocabulary;
}

function addOccurrence(vocabulary: Vocabulary, wanted: ReadonlySet<string>, fuzzy: boolean, key: string, source: number, position: number): void {
  let id = vocabulary.ids.get(key);
  if (id === undefined) {
    const plain = fuzzy && isFuzzyWord(key);
    if (!plain && !wanted.has(key)) return;
    id = vocabulary.keys.length;
    vocabulary.keys.push(key);
    vocabulary.ids.set(key, id);
    vocabulary.lastEntry.push(-1);
    if (plain) registerPlainWord(vocabulary, key);
  }
  // Sources arrive in order, so a repeat within one source is the token's last entry.
  const last = vocabulary.lastEntry[id];
  if (last >= 0 && vocabulary.entrySources[last] === source) {
    vocabulary.entryCounts[last]++;
  } else {
    vocabulary.lastEntry[id] = vocabulary.entryIds.length;
    vocabulary.entryIds.push(id);
    vocabulary.entrySources.push(source);
    vocabulary.entryCounts.push(1);
    vocabulary.entryPositions.push(position);
  }
}

function registerPlainWord(vocabulary: Vocabulary, key: string): void {
  vocabulary.plainWords.push(key);
  const root = stem(key);
  const group = vocabulary.byStem.get(root);
  if (group) group.push(key);
  else vocabulary.byStem.set(root, [key]);
}

/** A stored token that answers one query term. `distance` orders typo matches; it is 0 for exact and stem matches. */
interface Candidate {
  key: string;
  weight: number;
  distance: number;
}

/**
 * Every stored token that answers one query term: the exact token, its word
 * forms, and its typos. The nearest MAX_EXPANSIONS_PER_TERM are kept, strongest
 * match first, then fewest edits, then alphabetical so the result is stable.
 */
function expandTerm(vocabulary: Vocabulary, term: string): Candidate[] {
  const found: Candidate[] = [];
  if (vocabulary.ids.has(term)) found.push({ key: term, weight: WEIGHT_EXACT, distance: 0 });
  if (!isFuzzyWord(term)) return found;

  const root = stem(term);
  for (const key of vocabulary.byStem.get(root) ?? []) {
    if (key !== term) found.push({ key, weight: WEIGHT_STEM, distance: 0 });
  }
  const limit = typoLimit(term);
  for (const key of vocabulary.plainWords) {
    if (key === term || Math.abs(key.length - term.length) > limit) continue;
    const distance = boundedDistance(term, key, limit);
    // A word form was listed above at its higher weight, so it is not repeated as a typo.
    if (distance <= limit && stem(key) !== root) found.push({ key, weight: WEIGHT_TYPO, distance });
  }
  found.sort((a, b) => b.weight - a.weight || a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return found.slice(0, MAX_EXPANSIONS_PER_TERM);
}

interface TermMatch {
  /** Index of the query term. */
  term: number;
  weight: number;
}

/** The query terms that each stored token answers, indexed by token id. */
function matchesById(vocabulary: Vocabulary, terms: readonly string[]): (TermMatch[] | undefined)[] {
  const byId: (TermMatch[] | undefined)[] = new Array(vocabulary.keys.length);
  terms.forEach((term, index) => {
    for (const candidate of expandTerm(vocabulary, term)) {
      // Every candidate is a stored text, so it has an id.
      const id = vocabulary.ids.get(candidate.key)!;
      const match: TermMatch = { term: index, weight: candidate.weight };
      const list = byId[id];
      if (list) list.push(match);
      else byId[id] = [match];
    }
  });
  return byId;
}

/** What one source has matched so far. */
interface Accumulator {
  /** Per query term: the best weight matched in this source, 0 for none. */
  best: number[];
  /** Per query term: occurrences of tokens at that best weight. */
  occurrences: number[];
  phrases: number;
  /** Best weight matched here, and the earliest position at that weight. */
  top: number;
  position: number;
  /** Ids of the approximate tokens matched here. Only terms that stayed approximate are shown. */
  approximate: Set<number>;
}

function accumulatorFor(all: (Accumulator | undefined)[], source: number, termCount: number): Accumulator {
  let acc = all[source];
  if (!acc) {
    acc = {
      best: new Array<number>(termCount).fill(0),
      occurrences: new Array<number>(termCount).fill(0),
      phrases: 0,
      top: 0,
      position: Number.POSITIVE_INFINITY,
      approximate: new Set(),
    };
    all[source] = acc;
  }
  return acc;
}

/**
 * Keep the highest weight seen so far, and the earliest position at that weight.
 * The excerpt centres on an exact match even when an approximate one comes first
 * in the text.
 */
function noteMatch(acc: Accumulator, weight: number, position: number): void {
  if (weight > acc.top) {
    acc.top = weight;
    acc.position = position;
  } else if (weight === acc.top && position < acc.position) {
    acc.position = position;
  }
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Score every in-scope source that matches a term or a phrase. Terms match
 * through the vocabulary: each query term is expanded once against the unique
 * tokens, and each source is scored from the entries of the tokens that matched.
 * Phrases are exact substrings, so they are still scanned per source.
 */
function scoreSources(corpus: Corpus, query: ParsedQuery, inScope: InScope): Ranked[] {
  const termCount = query.terms.length;
  const accumulators: (Accumulator | undefined)[] = new Array(corpus.sources.length);

  let keys: string[] = [];
  let matchesOf: (TermMatch[] | undefined)[] = [];
  if (termCount) {
    const vocabulary = buildVocabulary(corpus, query.terms, inScope);
    keys = vocabulary.keys;
    matchesOf = matchesById(vocabulary, query.terms);
    const { entryIds, entrySources, entryCounts, entryPositions } = vocabulary;
    for (let i = 0; i < entryIds.length; i++) {
      const id = entryIds[i];
      const termMatches = matchesOf[id];
      if (!termMatches) continue;
      const acc = accumulatorFor(accumulators, entrySources[i], termCount);
      const count = entryCounts[i];
      // One token can answer several terms. Its best weight here decides where
      // the excerpt is centred.
      let tokenWeight = 0;
      for (const { term, weight } of termMatches) {
        if (weight > acc.best[term]) {
          acc.best[term] = weight;
          acc.occurrences[term] = count;
        } else if (weight === acc.best[term]) {
          acc.occurrences[term] += count;
        }
        if (weight < WEIGHT_EXACT) acc.approximate.add(id);
        tokenWeight = Math.max(tokenWeight, weight);
      }
      noteMatch(acc, tokenWeight, entryPositions[i]);
    }
  }

  if (query.phrases.length) {
    corpus.sources.forEach((source, index) => {
      if (!inScope(source.scopeBlockIds)) return;
      // Lowercasing allocates a copy of the whole text, so it runs only when a
      // phrase was requested.
      const lower = source.text.toLowerCase();
      for (const phrase of query.phrases) {
        const at = lower.indexOf(phrase);
        if (at < 0) continue;
        const acc = accumulatorFor(accumulators, index, termCount);
        acc.phrases++;
        noteMatch(acc, WEIGHT_EXACT, at);
      }
    });
  }

  /** The `term~form` pairs to show: terms whose best match in this source is approximate. */
  const approximateLabels = (acc: Accumulator): string[] => {
    const labels = new Set<string>();
    for (const id of acc.approximate) {
      for (const { term, weight } of matchesOf[id]!) {
        if (weight < WEIGHT_EXACT && acc.best[term] < WEIGHT_EXACT) labels.add(`${query.terms[term]}~${keys[id]}`);
      }
    }
    return [...labels];
  };

  const ranked: Ranked[] = [];
  accumulators.forEach((acc, index) => {
    if (!acc) return;
    ranked.push({
      source: corpus.sources[index],
      index,
      score: {
        // A phrase counts as one exact term, as it did before weights existed.
        distinct: sum(acc.best) + acc.phrases * WEIGHT_EXACT,
        phrases: acc.phrases,
        occurrences: sum(acc.occurrences),
        position: acc.position,
        approximate: approximateLabels(acc),
      },
    });
  });
  return ranked;
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
