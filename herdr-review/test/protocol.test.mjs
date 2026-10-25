import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createBridge, submitBatch, validateBatch, feedbackMessage } from "../src/protocol.mjs";

const comment = { path: "src/a.ts", side: "old", line: 42, quote: "removed();", text: "Keep the empty case.", revision: "a".repeat(64), outdated: true };
const batch = () => ({ id: "batch-1", comments: [{ ...comment }] });

test("feedback preserves deleted-line identity, quote and outdated warning", () => {
  const text = feedbackMessage("/repo", validateBatch(batch()));
  assert.match(text, /The user left feedback/);
  assert.match(text, /src\/a.ts.*:42.*old\/deleted/);
  assert.match(text, /OUTDATED/);
  assert.match(text, /removed\(\);/);
  const committed = batch();
  committed.comments[0].baseCommit = 'b'.repeat(40);
  committed.comments[0].tipCommit = 'c'.repeat(40);
  const rangeText = feedbackMessage('/repo', validateBatch(committed), 'develop...HEAD');
  assert.match(rangeText, /Comparison: develop\.\.\.HEAD \(committed changes only\)/);
  assert.ok(rangeText.includes(`Reviewed commits: ${'b'.repeat(40)} → ${'c'.repeat(40)}`));
  committed.comments[0].tipCommit = 'not-a-commit';
  assert.throws(() => validateBatch(committed), /Invalid/);
});

test("feedback rejects invalid paths and line anchors", () => {
  for (const invalid of [{ path: "../other" }, { path: "/abs" }, { line: 0 }, { side: "guess" }, { revision: "HEAD" }, { text: " " }]) {
    const b = batch(); Object.assign(b.comments[0], invalid);
    assert.throws(() => validateBatch(b), /Invalid/);
  }
  assert.throws(() => validateBatch({ id: "empty", comments: [] }));
  assert.throws(() => validateBatch({ id: "huge", comments: Array.from({ length: 100 }, () => ({ ...comment, text: "x".repeat(20_000) })) }), /too large/);
});

test("private bridge queues once, retries idempotently, rejects wrong token and stale session", async (t) => {
  const messages = [];
  let current = true;
  const bridge = await createBridge({ root: "/repo", sessionId: "origin", comparison: "develop...HEAD", isCurrent: () => current, deliver: (text) => messages.push(text) });
  t.after(async () => { await bridge.close(); await rm(bridge.dir, { recursive: true, force: true }); });
  const connection = JSON.parse(await readFile(path.join(bridge.dir, "connection.json"), "utf8"));
  await assert.rejects(submitBatch({ ...connection, token: "wrong" }, batch()), /no longer available/);
  assert.equal(messages.length, 0);
  await submitBatch(connection, batch());
  await submitBatch(connection, batch());
  assert.equal(messages.length, 1);
  assert.equal(connection.comparison, 'develop...HEAD');
  assert.match(messages[0], /Comparison: develop\.\.\.HEAD/);
  const conflicting = batch(); conflicting.comments[0].text = "Different feedback";
  await assert.rejects(submitBatch(connection, conflicting), /different comments/);
  assert.equal(messages.length, 1);
  current = false;
  await assert.rejects(submitBatch(connection, { ...batch(), id: "batch-2" }), /no longer available/);
  assert.equal(messages.length, 1);
  await bridge.close(); await bridge.close();
  await assert.rejects(submitBatch(connection, batch()));
});

test("delivery failure does not acknowledge or discard a retry", async (t) => {
  let fail = true, count = 0;
  const bridge = await createBridge({ root: "/repo", sessionId: "s", isCurrent: () => true, deliver: () => { if (fail) throw new Error("queue failed"); count++; } });
  t.after(async () => { await bridge.close(); await rm(bridge.dir, { recursive: true, force: true }); });
  const connection = JSON.parse(await readFile(path.join(bridge.dir, "connection.json"), "utf8"));
  await assert.rejects(submitBatch(connection, batch()), /queue failed/);
  fail = false;
  await submitBatch(connection, batch());
  assert.equal(count, 1);
});
