Performance fixtures and scaling checks live here. Context performs no synchronous filesystem I/O.

`request-path.test.ts` drives the real lifecycle `context` handler over the deterministic synthetic session in `test/helpers/synthetic-session.ts` (1500 messages, more than 10 MB). It checks three things:

- the fixture runs the full transform path, not a raw fallback;
- the output matches a pinned SHA-256, so optimizations must keep the output byte-identical;
- the median request stays under a coarse ceiling, which catches only large regressions.

Measure real timings with `npm run bench`, or with `npm run bench -- <session.jsonl>` for a local Pi session file. Never commit a real session file as a fixture, because it contains private conversation data. Real sessions carry more nested structure per byte than the synthetic fixture (tool-call arguments, multi-part assistant content), so canonical JSON and cloning take a larger share of their time.
