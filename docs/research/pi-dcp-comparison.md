# pi-dcp vs Prefix Cache Compaction vs Billion Context

Research date: 2026-11-01. This is a source review, not a performance benchmark.

## Conclusion

**Keep DCP as the base. Borrow targeted retrieval and consider optional summary redistillation. Do not replace it just for a cache-hit claim.**

The packages optimize different things:

- **pi-dcp:** the main model chooses closed history ranges to replace with summaries. It also prunes selected tool content. Raw Pi history stays intact.
- **pi-prefix-cache-compaction:** makes Pi's normal summary-and-tail compaction cheaper or faster to prepare by reusing the server's cached prompt. It does not offer DCP-style selective range management.
- **billion-context:** model-driven range compression, recursive summary tiers, and retrieval tools. Its Pi integration normally includes a local proxy. It is the closest functional alternative to DCP, but has a much larger operational scope.

There is no reviewed head-to-head benchmark that establishes which beats DCP on cost, latency, or task accuracy.

## Scope and primary sources

Versions inspected:

| Project | Reviewed source |
| --- | --- |
| pi-dcp | Local working tree, based on `db9490b33f10c2116e71183e35f0d4569938adab` |
| pi-prefix-cache-compaction | Published `0.6.0`; repository commit `27dd09ef7c96d867e21298574fedb59ccdfc6f06` |
| billion-context | Linked Pi listing resolves to `billion-context@0.1.210`; repository tag `v0.1.210` |

The DCP working tree already had changes in `src/compression/tool.ts`. Those were inspected, not changed. The older standalone `billion-context-pi` is **not** the package compared here.

Source entry points:

- [DCP README](../../pi-dcp/README.md), [defaults](../../pi-dcp/src/config/defaults.ts), [lifecycle](../../pi-dcp/src/lifecycle.ts), [context pipeline](../../pi-dcp/src/transform/pipeline.ts).
- [Prefix package README](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/README.md), [extension](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/src/index.ts), [core](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/src/core.ts), [published tarball](https://registry.npmjs.org/pi-prefix-cache-compaction/-/pi-prefix-cache-compaction-0.6.0.tgz).
- [Billion Context README](https://github.com/ranxianglei/billion-context/blob/v0.1.210/README.md), [configuration](https://github.com/ranxianglei/billion-context/blob/v0.1.210/CONFIGURATION.md), [kernel defaults](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/config.ts), [Pi integration](https://github.com/ranxianglei/billion-context/blob/v0.1.210/src/agent/pi.ts), [published listing](https://pi.dev/packages/billion-context).

## Side-by-side

| Question | pi-dcp | Prefix Cache Compaction | Billion Context |
| --- | --- | --- | --- |
| What is replaced? | Selected complete history ranges, including middle ranges | Native Pi compacted prefix; recent tail remains | Selected history ranges and, later, older summary tiers |
| Who writes the summary? | Current main model, through a tool | Separate request to the same selected model, with the same thinking settings | Main model through a tool by default; optional alternate summary paths exist |
| When? | Model decides; context and semantic nudges help | Pi compaction event; optional advance preparation | Model decides; pressure, growth, range-benefit and tier rules help |
| Can a model recover omitted detail? | No built-in targeted search/decompression tool | No built-in targeted retrieval tool | `search_context` and `decompress`; optional large-output retrieval |
| Raw history on disk? | Preserved | Preserved by Pi's native history | Fold source/lineage retained in its store, subject to storage availability |
| Normal append stability? | Stable labels and tail-only transient nudge | Original provider payload reused for summarization | Incremental folding design; still rewrites at fold anchor |
| Compression changes cached history? | Yes, from earliest changed point | Yes for the post-compaction prompt; old cache helps generate summary | Yes, from fold anchor; retrieval can append detail without unfolding |
| Native overflow compaction? | Allowed | Falls back to native when its path cannot run | Cancelled when integration confirms it owns the routed session |
| Operational footprint | Pi extension and local operation/state records | Pi extension, payload cache, extra requests | Pi integration plus local proxy by default, routing and persistent stores; inline mode optional |

## 1. What Prefix Cache Compaction does well

### Reuse the exact provider request to make the summary

Native compaction normally builds a different summarization prompt. The package captures the outgoing provider payload and routing headers, keeps prompt-affecting fields, and appends a summarization instruction. This lets an automatic prefix-cache server reuse work it did for the preceding agent request.

It deliberately keeps the same model and thinking effort: changing those can change the server's prompt template and lose cache reuse. This is not a separate cheap summarizer model. Its prefix assertion checks the preserved request fields; it cannot guarantee that a remote server still has the cache or renders the template identically.

**Advantage over DCP:** a useful optimization for the *native compaction fallback*. DCP does not provide this exact-payload cached summarizer. Normal DCP tool-driven compression already uses the live conversation, so this is not a wholly missing cache benefit for its main path.

**Limit:** the old prompt must still leave output room. Defaults reserve an overhead of 3,000 tokens and require at least 4,000 summary tokens of available budget, with a 16,000-token maximum. Unsupported requests or insufficient budget fall back to native compaction.

Sources: [core prefix checks and budgets](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/src/core.ts), [request capture and compaction handler](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/src/index.ts).

### Warm the next prompt, optionally before compaction is needed

After compaction, a best-effort one-token request warms the new summary-plus-tail prompt. Optional experimental background mode starts preparation at 70% context by default, then extends the warmed tail as the session continues. When Pi compacts, it can use the prepared summary and keep subsequent entries verbatim. If the job is unfinished it may wait; stale or oversized prepared results may be discarded.

**Benefit:** less user-visible waiting, especially on local GPUs with expensive prompt processing.

**Cost:** extra requests, resource contention, and possible discarded work. Prewarming moves compute earlier; it does not eliminate it. An API may charge for the warmup, and a server may evict its cache before use. Background mode is off by default.

Experimental incremental mode is also off by default and requires Pi 0.99 or newer. It merges a previous summary with a delta, so it introduces the usual repeated-summary information-loss risk.

### Important limits

- Supports Anthropic Messages and OpenAI Chat Completions paths, not the OpenAI Responses path used by many native GPT/Codex configurations.
- The native `api.anthropic.com` endpoint is excluded by default: its explicit cache-control needs are not managed by this package. Do not read “Anthropic Messages support” as universal Anthropic cache support.
- Persists captured request payloads by default under `~/.pi/agent/cache/pi-prefix-cache-compaction`, with a 14-day retention policy. Header credential filtering does not remove secrets inside conversation content. Resume can restore payloads, not an expired remote KV cache.
- It still produces a native summary plus retained tail. It does not add DCP's arbitrary-range protection and model-selected middle-range compression.
- The README's timing and cache-hit examples are author measurements on particular servers/models, not DCP comparisons.

Sources: [README compatibility, background mode and measurements](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/README.md), [core persistence](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction/blob/27dd09ef7c96d867e21298574fedb59ccdfc6f06/src/core.ts).

## 2. What Billion Context does well

### Targeted model-callable recovery: the strongest missing DCP feature

Billion Context exposes `search_context` and `decompress`. Search covers stored block summaries, including inactive/consumed blocks, and can search folded originals when available. Decompression normally reads one tier upward; `full: true` can recover original content recursively. It can return detail as a new tool result rather than expanding old history in place.

Large results can go to a file instead of flooding the prompt. That file must be accessible to the agent: a file on a remote proxy filesystem is not automatically local to the agent.

**Why this matters:** summaries cannot retain every exact symbol, number, rejected approach, or test result. A model that can look up an omitted fact has a recovery path without rereading the repository or making the whole old range active again.

DCP has human `/dcp decompress` and `/dcp recompress` commands, but no equivalent model-callable search/retrieval API. Raw session preservation alone does not solve this model-access problem.

**Trade-off:** additional storage/index/tool logic and extra read requests. Models must remember to retrieve; the project's own evaluation warns that spontaneous retrieval is unreliable without instructions.

Sources: [tool definitions](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/compress-tools.ts), [retrieval handlers and file spill](https://github.com/ranxianglei/billion-context/blob/v0.1.210/src/decompress-shared.ts), [tier decompression](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/decompress.ts).

### Actual repeated distillation of summaries

Billion Context can replace existing child summaries with a new, shorter higher-tier summary. It keeps source lineage for retrieval. This controls accumulated summary size over very long conversations.

DCP supports nested blocks, but its [nesting implementation](../../pi-dcp/src/compression/nesting.ts) inserts each selected child summary **verbatim** into the new parent. It does not let the model silently rewrite away that old summary. This preserves prior summary wording, not all original facts. It also means old summary text cannot be made smaller through nesting alone.

**Billion Context advantage:** better control of summary growth over many phases.

**DCP advantage:** avoids another lossy rewrite of already summarized facts. Optional redistillation would be safer when paired with targeted original-history retrieval, not as a blind replacement for current nesting.

Sources: [summary tier processing](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/compress.ts), [tier defaults](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/config.ts).

### Growth-aware scheduling and recent-context protection

Billion Context combines context pressure, growth since previous compression, useful-range checks, and tier state. Its defaults use 45%/75% pressure bands and a 95% emergency threshold. Growth settings include a 50,000-token floor/cap, but it is **not** simply an unconditional “compress every 50k tokens” rule: pressure and other gates matter.

The kernel defaults preserve three recent messages and 5,000 recent tokens; recommendation logic protects first/latest user anchors and protocol pairs. These are kernel defaults, not a promise that every host configuration uses identical settings.

DCP already has pressure and semantic triggers, a useful-savings floor, complete-exchange validation, and optional recent/user protection. Current source defaults are 35%/70%/90% pressure, five-user-turn or fifteen-iteration semantic triggers, and **32,000 estimated saved tokens** before semantic nudges. The README's 12,000 figure is stale. Recent-turn and whole-user-message protection are opt-in.

**Useful idea:** remember how much the context has grown since the last expensive rewrite, and avoid repeated low-benefit rewrites. This could improve DCP's scheduling, but neither project demonstrates a complete provider-price-based break-even decision.

Sources: [Billion Context defaults](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/config.ts), [recommendation gates](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/recommend.ts), [DCP defaults](../../pi-dcp/src/config/defaults.ts), [DCP semantic gate](../../pi-dcp/src/transform/semantic-nudge.ts).

### Optional large-tool-output retrieval

The kernel also has an optional content-cache/retrieval path (`acp_retrieve`) for large tool output. This can keep most of a large result outside the active prompt and fetch detail later. It is a different technique from model-written summaries.

This is worth considering for huge logs and read-only results, but it must not become silent data loss. The reviewed kernel defaults disable CCR, absorb, and crush; do not credit all optional paths as default behavior.

Sources: [kernel defaults](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/config.ts), [CCR implementation](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/ccr.ts).

## 3. Cache claims: what is real and what is not

A provider prefix cache reuses the unchanged beginning of a request. Once old bytes change, later cached work generally cannot be reused as the same prefix.

DCP is already careful about ordinary appends: stable ordinal labels, stable system guidance, transient nudges at the tail, and an Anthropic cache-breakpoint adjustment that avoids placing the rolling breakpoint on the temporary nudge. These reduce accidental invalidation. They do **not** make compression free.

Billion Context's renderer also replaces a folded span at its source anchor. It does not keep the entire old prefix byte-identical. Its code explicitly notes cache loss from fold-anchor rewrites during distillation. Therefore “never invalidates prefix cache” is too broad if read as covering the actual compression operation.

Both can preserve the prefix *before* the earliest changed point. Both must balance the immediate rewrite cost against smaller future requests. Billion Context's append-only retrieval can avoid another rewrite when recovering detail.

Prefix Cache Compaction optimizes a different moment: use the old cached request to generate a summary, then warm the new request. It cannot make the old and newly summarized histories the same prefix.

Sources: [DCP stable labels](../../pi-dcp/src/transform/labels.ts), [DCP cache breakpoint](../../pi-dcp/src/transform/cache-breakpoint.ts), [Billion Context rendering](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/prune.ts), [distillation cache comment](https://github.com/ranxianglei/billion-context/blob/v0.1.210/kernel/src/compress.ts#L2059-L2066).

### Token savings are not dollar savings

A smaller prompt can cost more for a while if it replaces cheap cached tokens with a cold prefix and adds summary-generation tokens. Whether it pays off depends on future requests, cache pricing, cache survival, output cost, and local compute.

DCP's statistics are operation-level token estimates, not actual provider-cost accounting. Billion Context's headline cache/cost numbers are project measurements, not guarantees. Its “billions” refers to cumulative traffic, including repeatedly cached input, not a simultaneous billion-token model window.

The project's own paper reports workload-dependent results: a fixed cadence was cheaper on one repetitive workload; aggressive compression lost recall and increased execution errors in one phase study; prompt doctrine explains much of a reread reduction. These are useful warnings against declaring one universal winner.

Source: [project paper and evaluation limitations](https://github.com/ranxianglei/billion-context/blob/v0.1.210/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md), [DCP statistics](../../pi-dcp/src/stats.ts).

## 4. Reliability, privacy, and operational trade-offs

### DCP has valuable safeguards already

- Range selection is checked against the assistant response's own snapshot. Complete tool exchanges stay together; protected content and the latest user turn cannot be selected.
- Configured protected tool output is inserted verbatim. Rejected multi-range calls do not partially commit.
- Projection/join failures send raw context instead of guessing a destructive transformation.
- Model exclusions and unhealthy state allow native threshold compaction. Manual and overflow compaction remain allowed. Pi's effective `compaction.enabled` must stay true for automatic overflow fallback.
- Existing tests cover protocol boundaries, cache stability, provider fixtures, lifecycle, crashes and other failure modes. That is evidence of safeguards, not proof of better task accuracy.

Sources: [compression service](../../pi-dcp/src/compression/service.ts), [pipeline](../../pi-dcp/src/transform/pipeline.ts), [lifecycle](../../pi-dcp/src/lifecycle.ts), [tests](../../pi-dcp/test).

One DCP caution: its duplicate-output strategy groups by tool name and canonical arguments, not by equal output bytes. It can remove an older successful read even if the file or external world changed between calls. This is a deliberate latest-result policy, not lossless duplicate elimination. Protect tools where historical differences matter. Source: [deduplication](../../pi-dcp/src/strategies/deduplicate.ts).

### Billion Context owns more of the runtime

The linked package's native Pi entry normally starts/uses a local proxy; an inline engine is opt-in. The proxy handles protocol adaptation, routing, storage and other clients as well as compression. This broad support is useful, but brings more state and failure surfaces than a Pi-only context lens.

When the Pi integration confirms it owns the routed session, it cancels **both threshold and overflow** native compaction. Manual compaction remains possible. The kernel has emergency truncation and terminal-escape behavior, but this is not the same as DCP leaving Pi's automatic overflow compact-and-retry available.

Built-in Pi subagent support is enabled by default and can overlap with existing subagent extensions. Disable that feature if retaining another implementation. The standalone legacy Pi package should not be stacked with this package.

A local proxy is not automatically a third-party service. Nevertheless, it sees prompt contents and routed credentials; its stores and network configuration become part of the trust boundary. If copying implementation, review its MIT-plus-attribution license term rather than assuming plain MIT obligations.

Sources: [Pi compaction handler](https://github.com/ranxianglei/billion-context/blob/v0.1.210/src/agent/pi.ts#L947-L1022), [native entry](https://github.com/ranxianglei/billion-context/blob/v0.1.210/src/agent/pi-native.ts), [configuration](https://github.com/ranxianglei/billion-context/blob/v0.1.210/CONFIGURATION.md), [license](https://github.com/ranxianglei/billion-context/blob/v0.1.210/LICENSE).

### Do not assume these extensions compose safely

DCP deliberately joins provider-visible context back to canonical history. Another extension that rewrites those messages can cause it to fail closed and send raw context. Competing native-compaction cancellation handlers also depend on hook behavior/order.

Treat combined installation as an integration experiment, not a free additive improvement. In particular, test native manual/overflow compaction, restart, branch changes and provider switching before relying on a combined setup.

## 5. Recommended priorities for DCP

1. **Add model-callable search and read-only decompression.** Return selected original detail as a new tool result. Bound output, preserve protocol safety, and keep history/branch authorization explicit. This is the clearest useful gap.
2. **Evaluate optional summary redistillation.** Keep today's verbatim nesting as the safe default. Add a bounded, explicitly lossy mode only with original-history retrieval and clear lineage.
3. **Measure rewrite economics.** Track provider cache reads/writes, summary output, compression latency, and requests remaining after compression. Use those measurements to evaluate growth-aware scheduling rather than copying thresholds blindly.
4. **Consider prefix-cached native fallback only where it fits.** Most attractive for compatible local servers and automatic-cache APIs. Preserve DCP's overflow fallback; account for version/API constraints and extra warmup requests.
5. **Correct the README savings-floor drift.** Current source says 32,000; the README says 12,000. No implementation change is required to fix that documentation mismatch.

For a fair experiment, replay the same long tasks with the same model/provider and compare total price or local GPU time, first-token wait, cache reuse, exact-detail recovery, completion quality, and failure recovery. Include tasks with changing files, phase transitions, and many accumulated summaries. A cache-hit percentage alone is not enough.

## Validation limits

Inspected published package code, repository code and first-party documentation. Downloads were extracted under `/tmp`; no external package code was installed or executed. No live provider benchmark or code test suite was run. Only this research document was added; existing implementation changes were left untouched.
