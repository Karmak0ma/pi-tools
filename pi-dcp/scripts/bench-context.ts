/**
 * Measure one pi-dcp request (the lifecycle `context` handler) end to end.
 *
 * Usage:
 *   npm run bench                       # deterministic synthetic session
 *   npm run bench -- <session.jsonl>    # a real Pi session file (read only)
 *   npm run bench -- [file] --runs=15 --warmup=3
 *
 * The synthetic session is the regression reference that the performance test
 * also uses. A real session file is for local investigation only: it contains
 * private data and must never be committed as a fixture.
 *
 * The benchmark refuses to report timings for a raw fallback request. A raw
 * request skips most of the pipeline, so its timing would look fast while
 * measuring the wrong path.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contextEventMessages, createContextHarness, createSyntheticHarness, type ContextHarness } from "../test/helpers/synthetic-session.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const value = args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  return value === undefined ? fallback : Number(value);
};
const file = args.find((arg) => !arg.startsWith("--"));
const runs = option("runs", 9);
const warmup = option("warmup", 2);

let harness: ContextHarness;
if (file) {
  const sessionManager = SessionManager.open(file);
  const leafId = sessionManager.getLeafId();
  if (!leafId) throw new Error("session has no leaf entry");
  harness = createContextHarness(sessionManager, contextEventMessages(sessionManager.getBranch(), leafId));
} else {
  harness = createSyntheticHarness();
}

const megabytes = (value: unknown): string => (JSON.stringify(value).length / 1_000_000).toFixed(1);
let output = await harness.run();
if (harness.runtime.contextStats.rawRequests > 0) {
  console.error(`raw fallback (${harness.runtime.contextStats.lastRawReason}); timings would measure the wrong path`);
  process.exit(1);
}
for (let run = 1; run < warmup; run++) output = await harness.run();

const timings: number[] = [];
for (let run = 0; run < runs; run++) {
  const started = performance.now();
  await harness.run();
  timings.push(performance.now() - started);
}
timings.sort((a, b) => a - b);
const at = (fraction: number): string => timings[Math.min(timings.length - 1, Math.floor(fraction * timings.length))]!.toFixed(1);

console.log(`source:   ${file ?? "synthetic (test/helpers/synthetic-session.ts)"}`);
console.log(`messages: ${harness.incoming.length} in (${megabytes(harness.incoming)} MB) -> ${output.messages.length} out (${megabytes(output.messages)} MB)`);
console.log(`runs:     ${runs} timed after ${warmup} warmup`);
console.log(`ms:       min ${at(0)}  median ${at(0.5)}  p95 ${at(0.95)}  max ${at(1)}`);
