import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import {
  acknowledgeComments,
  deleteComment,
  getUnsent,
  restoreComments,
  saveComment,
} from "../src/comments.mjs";

const revision = "a".repeat(64);

function anchor(line = 7, quote = "const value = 1;") {
  return {
    filePath: "src/example.mjs",
    path: "src/example.mjs",
    side: "new",
    line,
    quote,
    revision,
    outdated: false,
  };
}

function wire(record) {
  const { id, threadId, revisionNumber, sentAt, ...comment } = record;
  return comment;
}

function saveNew(text = "first draft", source = anchor()) {
  return saveComment([], { anchor: source, text });
}

test("saveComment creates a new unsent draft without mutating its inputs", () => {
  const source = anchor();
  const result = saveComment([], { anchor: source, text: "  first draft  " });

  assert.equal(result.changed, true);
  assert.match(result.commentId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].text, "first draft");
  assert.equal(result.comments[0].revisionNumber, 1);
  assert.equal(result.comments[0].sentAt, undefined);
  assert.deepEqual(source, anchor());
  assert.throws(() => saveComment([], { anchor: source, text: " \n\t" }), /blank/);
});

test("unsent edits keep the same record identity and only return a changed copy", () => {
  const draft = saveNew();
  const before = structuredClone(draft.comments);
  const result = saveComment(draft.comments, {
    anchor: anchor(8, "const value = 2;"),
    text: "updated draft",
    commentId: draft.commentId,
  });

  assert.equal(result.changed, true);
  assert.equal(result.commentId, draft.commentId);
  assert.equal(result.comments[0].id, draft.comments[0].id);
  assert.equal(result.comments[0].threadId, draft.comments[0].threadId);
  assert.equal(result.comments[0].revisionNumber, 1);
  assert.equal(result.comments[0].text, "updated draft");
  assert.deepEqual(draft.comments, before);
});

test("sent edits preserve the sent revision and update one pending correction", () => {
  const draft = saveNew("first draft");
  const sent = acknowledgeComments(draft.comments, {
    id: "accepted-1",
    comments: [{ ...wire(draft.comments[0]), id: draft.commentId }],
  }, 1000);
  const sentBefore = structuredClone(sent);

  const correction = saveComment(sent, {
    anchor: anchor(9, "const value = 3;"),
    text: "correction",
    commentId: draft.commentId,
  });
  assert.equal(correction.changed, true);
  assert.equal(correction.comments.length, 2);
  assert.equal(correction.comments[0].id, draft.commentId);
  assert.equal(correction.comments[0].sentAt, 1000);
  assert.equal(correction.comments[1].sentAt, undefined);
  assert.equal(correction.comments[1].threadId, draft.comments[0].threadId);
  assert.equal(correction.comments[1].revisionNumber, 2);

  const pendingId = correction.comments[1].id;
  const updatedPending = saveComment(correction.comments, {
    anchor: anchor(10, "const value = 4;"),
    text: "second correction",
    commentId: draft.commentId,
  });
  assert.equal(updatedPending.comments.length, 2);
  assert.equal(updatedPending.commentId, pendingId);
  assert.equal(updatedPending.comments[1].id, pendingId);
  assert.equal(updatedPending.comments[1].revisionNumber, 2);
  assert.equal(updatedPending.comments[1].text, "second correction");

  const directPendingEdit = saveComment(updatedPending.comments, {
    anchor: anchor(11),
    text: "direct pending edit",
    commentId: pendingId,
  });
  assert.equal(directPendingEdit.comments.length, 2);
  assert.equal(directPendingEdit.commentId, pendingId);
  assert.equal(directPendingEdit.comments[1].text, "direct pending edit");
  assert.deepEqual(sent, sentBefore);
});

test("unchanged sent text is a no-op", () => {
  const draft = saveNew("keep this");
  const sent = acknowledgeComments(draft.comments, {
    id: "accepted-2",
    comments: [{ ...wire(draft.comments[0]), id: draft.commentId }],
  }, 2000);
  const result = saveComment(sent, {
    anchor: anchor(99, "a different source snapshot"),
    text: "  keep this  ",
    commentId: draft.commentId,
  });

  assert.equal(result.changed, false);
  assert.equal(result.commentId, draft.commentId);
  assert.deepEqual(result.comments, sent);
});

test("sent edits compare with the latest sent revision when an older ID is selected", () => {
  const draft = saveNew("revision A");
  const firstSent = acknowledgeComments(draft.comments, {
    id: "revision-a-batch",
    comments: [{ ...wire(draft.comments[0]), id: draft.commentId }],
  }, 8000);
  const correction = saveComment(firstSent, {
    anchor: anchor(8),
    text: "revision B",
    commentId: draft.commentId,
  });
  const secondSent = acknowledgeComments(correction.comments, {
    id: "revision-b-batch",
    comments: [{ ...wire(correction.comments[1]), id: correction.comments[1].id }],
  }, 8001);

  const revert = saveComment(secondSent, {
    anchor: anchor(9),
    text: "revision A",
    commentId: draft.commentId,
  });
  assert.equal(revert.changed, true);
  assert.equal(revert.comments.length, 3);
  assert.equal(revert.comments[2].revisionNumber, 3);
  assert.equal(revert.comments[2].text, "revision A");

  const duplicateLatest = saveComment(secondSent, {
    anchor: anchor(9),
    text: "revision B",
    commentId: draft.commentId,
  });
  assert.equal(duplicateLatest.changed, false);
  assert.deepEqual(duplicateLatest.comments, secondSent);
});

test("acknowledgement handles IDs and immutable legacy batches without mutating the batch", () => {
  const first = saveNew("first");
  const second = saveComment(first.comments, { anchor: anchor(8), text: "second" });
  const legacyBatch = { id: "legacy-batch", comments: [wire(second.comments[1])] };
  const legacyBefore = structuredClone(legacyBatch);
  const afterLegacy = acknowledgeComments(second.comments, legacyBatch, 3000);

  assert.deepEqual(legacyBatch, legacyBefore);
  assert.equal(afterLegacy[0].sentAt, undefined);
  assert.equal(afterLegacy[1].sentAt, 3000);

  const legacyRetry = acknowledgeComments(afterLegacy, legacyBatch, 3100);
  assert.equal(legacyRetry[1].sentAt, 3000);

  const stale = acknowledgeComments(afterLegacy, {
    id: "stale-batch",
    comments: [{ ...wire(afterLegacy[0]), id: afterLegacy[0].id, text: "newer local text" }],
  }, 3500);
  assert.equal(stale[0].sentAt, undefined);

  const unknownId = acknowledgeComments(stale, {
    id: "unknown-id-batch",
    comments: [{ ...wire(stale[0]), id: randomUUID() }],
  }, 3600);
  assert.equal(unknownId[0].sentAt, undefined);

  const withId = acknowledgeComments(stale, {
    id: "new-batch",
    comments: [{ ...wire(afterLegacy[0]), id: afterLegacy[0].id }],
  }, 4000);
  assert.equal(withId[0].sentAt, 4000);
  assert.equal(withId[1].sentAt, 3000);

  const retry = acknowledgeComments(withId, {
    id: "retry",
    comments: [{ ...wire(withId[1]), id: withId[1].id }],
  }, 5000);
  assert.equal(retry[1].sentAt, 3000);
  assert.deepEqual(getUnsent(retry), []);
});

test("acknowledgement ignores refreshed outdated state for ID receipts", () => {
  const draft = saveNew("refresh-safe");
  const oldBatch = { id: "refresh-id-batch", comments: getUnsent(draft.comments) };
  const refreshed = draft.comments.map((record) => ({ ...record, outdated: true }));
  const acknowledged = acknowledgeComments(refreshed, oldBatch, 9000);

  assert.equal(acknowledged[0].sentAt, 9000);
  assert.equal(acknowledged[0].outdated, true);
  assert.equal(refreshed[0].sentAt, undefined);
  assert.equal(oldBatch.comments[0].outdated, false);
});

test("legacy acknowledgement ignores refreshed outdated state", () => {
  const draft = saveNew("legacy-refresh-safe");
  const oldBatch = { id: "refresh-legacy-batch", comments: [wire(getUnsent(draft.comments)[0])] };
  const refreshed = draft.comments.map((record) => ({ ...record, outdated: true }));
  const acknowledged = acknowledgeComments(refreshed, oldBatch, 9001);

  assert.equal(acknowledged[0].sentAt, 9001);
  assert.equal(acknowledged[0].outdated, true);
  assert.equal(refreshed[0].sentAt, undefined);
  assert.equal(oldBatch.comments[0].outdated, false);
});

test("acknowledgement still rejects changed text when outdated also changed", () => {
  const draft = saveNew("original text");
  const idBatch = { id: "stale-text-id-batch", comments: getUnsent(draft.comments) };
  const legacyBatch = { id: "stale-text-legacy-batch", comments: [wire(getUnsent(draft.comments)[0])] };
  const refreshed = draft.comments.map((record) => ({
    ...record,
    outdated: true,
    text: "different local text",
  }));

  assert.equal(acknowledgeComments(refreshed, idBatch, 9002)[0].sentAt, undefined);
  assert.equal(acknowledgeComments(refreshed, legacyBatch, 9003)[0].sentAt, undefined);
});

test("restore migrates old records one at a time, including archives over 200 records", () => {
  const oldRecords = Array.from({ length: 201 }, (_, index) => ({
    ...anchor(index + 1),
    text: `legacy ${index}`,
  }));
  const before = structuredClone(oldRecords);
  const restored = restoreComments(oldRecords);

  assert.equal(restored.length, 201);
  assert.deepEqual(oldRecords, before);
  assert.ok(restored.every((record) =>
    /^[0-9a-f-]{36}$/i.test(record.id) &&
    /^[0-9a-f-]{36}$/i.test(record.threadId) &&
    record.revisionNumber === 1 && record.sentAt === undefined));
  assert.equal(new Set(restored.map((record) => record.id)).size, 201);
});

test("restore rejects partial or invalid supplied metadata instead of migrating it", () => {
  assert.throws(() => restoreComments([{ ...anchor(), text: "bad", id: randomUUID() }]), /metadata/);
  assert.throws(() => restoreComments([{
    ...anchor(),
    text: "bad",
    id: randomUUID(),
    threadId: randomUUID(),
    revisionNumber: 1,
    sentAt: 0,
  }]), /timestamp/);

  const valid = saveNew("valid").comments[0];
  assert.throws(() => restoreComments([valid, { ...valid, threadId: randomUUID() }]), /Duplicate comment id/);
  assert.throws(() => restoreComments([valid, { ...valid, id: randomUUID() }]), /Duplicate comment revision/);
  assert.throws(() => restoreComments([valid, { ...valid, id: randomUUID(), revisionNumber: 2 }]), /Multiple unsent/);
});

test("a legacy item matches only one of two identical unsent records", () => {
  const first = saveNew("same text");
  const second = saveComment(first.comments, { anchor: anchor(), text: "same text" });
  const legacyBatch = { id: "one-legacy-item", comments: [wire(first.comments[0])] };
  const acknowledged = acknowledgeComments(second.comments, legacyBatch, 7000);

  assert.equal(acknowledged.filter((record) => record.sentAt !== undefined).length, 1);
  assert.equal(acknowledged[0].sentAt, 7000);
  assert.equal(acknowledged[1].sentAt, undefined);
});

test("deleteComment cancels only unsent records and never mutates the source", () => {
  const draft = saveNew("cancel me");
  const before = structuredClone(draft.comments);
  const deleted = deleteComment(draft.comments, draft.commentId);
  assert.deepEqual(draft.comments, before);
  assert.deepEqual(deleted, []);

  const keepDraft = saveNew("keep me");
  const actuallySent = acknowledgeComments(keepDraft.comments, {
    id: "accepted-3",
    comments: [{ ...wire(keepDraft.comments[0]), id: keepDraft.comments[0].id }],
  }, 6000);
  assert.throws(
    () => deleteComment(actuallySent, actuallySent[0].id),
    { message: "Sent feedback cannot be retracted; edit it to send a correction." },
  );
});
