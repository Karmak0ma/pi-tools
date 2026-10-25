import { randomUUID } from "node:crypto";

import { validateBatch } from "./protocol.mjs";

const METADATA_KEYS = ["id", "threadId", "revisionNumber", "sentAt"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESTORE_BATCH_ID = "restore";

function clone(value) {
  return structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function metadataKeysPresent(record) {
  return METADATA_KEYS.filter((key) => hasOwn(record, key));
}

function assertUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid comment ${field}.`);
  }
}

function assertMetadata(record, { allowLegacy }) {
  if (!isObject(record)) throw new Error("Invalid comment record.");

  const supplied = metadataKeysPresent(record);
  if (allowLegacy && supplied.length === 0) return;

  // A partially persisted metadata set is corruption. Do not turn it into a
  // new draft, because doing so would hide the identity of a sent revision.
  if (!hasOwn(record, "id") || !hasOwn(record, "threadId") || !hasOwn(record, "revisionNumber")) {
    throw new Error("Invalid comment metadata.");
  }
  assertUuid(record.id, "id");
  assertUuid(record.threadId, "threadId");
  if (!Number.isSafeInteger(record.revisionNumber) || record.revisionNumber < 1) {
    throw new Error("Invalid comment revision number.");
  }
  if (hasOwn(record, "sentAt") &&
      (typeof record.sentAt !== "number" || !Number.isFinite(record.sentAt) || record.sentAt <= 0)) {
    throw new Error("Invalid comment sent timestamp.");
  }
}

function validateWireRecord(record) {
  // Validate one record at a time. The sent archive is allowed to grow beyond
  // validateBatch's 200-comment transport limit.
  validateBatch({ id: RESTORE_BATCH_ID, comments: [record] });
}

function validateCurrentRecord(record) {
  assertMetadata(record, { allowLegacy: false });
  validateWireRecord(record);
}

function assertLedger(comments) {
  if (!Array.isArray(comments)) throw new Error("Comments must be an array.");

  const ids = new Set();
  const revisions = new Set();
  const pendingThreads = new Set();
  for (const record of comments) {
    validateCurrentRecord(record);
    if (ids.has(record.id)) throw new Error("Duplicate comment id.");
    ids.add(record.id);

    const revisionKey = `${record.threadId}:${record.revisionNumber}`;
    if (revisions.has(revisionKey)) throw new Error("Duplicate comment revision.");
    revisions.add(revisionKey);

    if (record.sentAt === undefined) {
      if (pendingThreads.has(record.threadId)) throw new Error("Multiple unsent revisions in one thread.");
      pendingThreads.add(record.threadId);
    }
  }
  return comments;
}

function freshId(usedIds) {
  let id;
  do id = randomUUID(); while (usedIds.has(id));
  return id;
}

function identitySet(comments) {
  return new Set(comments.flatMap((record) => [record.id, record.threadId]));
}

function stripMetadata(value) {
  const result = { ...value };
  for (const key of METADATA_KEYS) delete result[key];
  return result;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

function sameCommentContent(left, right) {
  return sameValue(stripMetadata(left), stripMetadata(right));
}

function receiptContent(value) {
  return Object.fromEntries(Object.entries(stripMetadata(value)).filter(([key]) => key !== "outdated"));
}

function sameReceiptContent(left, right) {
  // `outdated` is refreshed local display state. It is not part of the
  // accepted wire fingerprint, so a refresh must not strand an old receipt.
  return sameValue(receiptContent(left), receiptContent(right));
}

function commentFromAnchor(anchor, text, metadata = {}) {
  if (!isObject(anchor)) throw new Error("Comment anchor must be an object.");
  const record = clone(anchor);
  for (const key of METADATA_KEYS) delete record[key];
  record.text = text;
  Object.assign(record, metadata);
  validateWireRecord(record);
  return record;
}

function normalizedText(text) {
  if (typeof text !== "string") throw new Error("Comment text must be a string.");
  const result = text.trim();
  if (!result) throw new Error("Comment text cannot be blank.");
  return result;
}

function nextRevision(comments, threadId) {
  const maximum = comments.reduce((value, record) =>
    record.threadId === threadId ? Math.max(value, record.revisionNumber) : value, 0);
  if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error("Comment revision number is exhausted.");
  return maximum + 1;
}

/**
 * Restore the durable comment ledger without applying the transport batch
 * limit. Old records have no identity, so each one becomes a fresh unsent
 * thread; they must never be guessed to be sent feedback.
 */
export function restoreComments(savedComments = []) {
  if (!Array.isArray(savedComments)) throw new Error("Saved comments must be an array.");

  // Reserve supplied identities first, so a generated migration identity
  // cannot collide with a valid identity that appears later in the archive.
  const usedIdentity = new Set(savedComments.flatMap((saved) =>
    isObject(saved) ? [saved.id, saved.threadId].filter((value) => typeof value === "string") : []));
  const restored = savedComments.map((saved) => {
    if (!isObject(saved)) throw new Error("Invalid comment record.");
    const record = clone(saved);
    assertMetadata(record, { allowLegacy: true });
    if (metadataKeysPresent(record).length === 0) {
      record.id = freshId(usedIdentity);
      usedIdentity.add(record.id);
      record.threadId = freshId(usedIdentity);
      record.revisionNumber = 1;
    }
    usedIdentity.add(record.id);
    usedIdentity.add(record.threadId);
    validateCurrentRecord(record);
    return record;
  });

  assertLedger(restored);
  return restored;
}

/** Return isolated unsent records for construction of a new wire batch. */
export function getUnsent(comments) {
  assertLedger(comments);
  return comments.filter((record) => record.sentAt === undefined).map(clone);
}

/**
 * Save a draft or correction. A sent revision is immutable: a changed sent
 * comment gets a new record in the same thread, preserving the sent copy as
 * the audit history. A pending revision in that thread is updated instead of
 * creating sibling drafts.
 */
export function saveComment(comments, { anchor, text, commentId } = {}) {
  assertLedger(comments);
  if (commentId !== undefined) assertUuid(commentId, "id");
  const trimmedText = normalizedText(text);
  const wireComment = commentFromAnchor(anchor, trimmedText);
  const result = comments.map(clone);
  const existingIndex = commentId === undefined ? -1 : result.findIndex((record) => record.id === commentId);

  if (existingIndex < 0) {
    const usedIdentity = identitySet(result);
    const id = freshId(usedIdentity);
    usedIdentity.add(id);
    const threadId = freshId(usedIdentity);
    result.push(commentFromAnchor(wireComment, trimmedText, { id, threadId, revisionNumber: 1 }));
    return { comments: result, commentId: id, changed: true };
  }

  const existing = result[existingIndex];
  if (existing.sentAt !== undefined) {
    // The UI can submit an older sent ID. Compare with the latest sent
    // revision, not that stale selection: returning to an older text must
    // create a correction, while resubmitting the reviewer's current text is
    // a no-op. If a pending correction exists, this no-op leaves it intact
    // rather than changing it into a redundant duplicate.
    const latestSent = result.reduce((latest, record) =>
      record.threadId === existing.threadId && record.sentAt !== undefined &&
      (!latest || record.revisionNumber > latest.revisionNumber) ? record : latest, undefined);
    if (latestSent.text === trimmedText) {
      return { comments: result, commentId: existing.id, changed: false };
    }

    const pendingIndex = result.findIndex((record) =>
      record.threadId === existing.threadId && record.sentAt === undefined);
    if (pendingIndex >= 0) {
      const pending = result[pendingIndex];
      const updated = commentFromAnchor(wireComment, trimmedText, {
        id: pending.id,
        threadId: pending.threadId,
        revisionNumber: pending.revisionNumber,
      });
      if (sameCommentContent(pending, updated)) {
        return { comments: result, commentId: pending.id, changed: false };
      }
      result[pendingIndex] = updated;
      return { comments: result, commentId: pending.id, changed: true };
    }

    const id = freshId(identitySet(result));
    result.push(commentFromAnchor(wireComment, trimmedText, {
      id,
      threadId: existing.threadId,
      revisionNumber: nextRevision(result, existing.threadId),
    }));
    return { comments: result, commentId: id, changed: true };
  }

  const updated = commentFromAnchor(wireComment, trimmedText, {
    id: existing.id,
    threadId: existing.threadId,
    revisionNumber: existing.revisionNumber,
  });
  if (sameCommentContent(existing, updated)) {
    return { comments: result, commentId: existing.id, changed: false };
  }
  result[existingIndex] = updated;
  return { comments: result, commentId: existing.id, changed: true };
}

/** Delete only an unsent draft; sent feedback is an immutable audit record. */
export function deleteComment(comments, id) {
  assertLedger(comments);
  const result = comments.map(clone);
  const index = result.findIndex((record) => record.id === id);
  if (index < 0) return result;
  if (result[index].sentAt !== undefined) {
    throw new Error("Sent feedback cannot be retracted; edit it to send a correction.");
  }
  result.splice(index, 1);
  return result;
}

/**
 * Mark only accepted records as sent. New batches carry comment IDs, while
 * an old pending batch does not. The legacy fallback compares the complete
 * anchor and text, but never rewrites that old batch object: the server uses
 * its exact comment array fingerprint for same-ID retries.
 */
export function acknowledgeComments(comments, batch, nowMs = Date.now()) {
  assertLedger(comments);
  if (!batch || !Array.isArray(batch.comments)) throw new Error("Invalid feedback batch.");
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs <= 0) {
    throw new Error("Invalid sent timestamp.");
  }

  const result = comments.map(clone);
  const used = new Set();
  const byId = new Map(result.map((record, index) => [record.id, index]));
  for (const wireComment of batch.comments) {
    if (!isObject(wireComment)) continue;
    let index;
    const hasId = wireComment.id !== undefined;
    if (hasId) {
      index = byId.get(wireComment.id);
      // The controller normally holds a pending lock, but this cheap check
      // also prevents a stale accepted batch from marking a newer same-ID
      // draft as sent if a caller violates that lock.
      if (index !== undefined && result[index].sentAt === undefined &&
          !sameReceiptContent(result[index], wireComment)) continue;
    } else {
      // The old wire format had no comment ID. It can only acknowledge an
      // exact, currently-unsent ledger record, and one wire item matches once.
      index = result.findIndex((record, candidateIndex) =>
        !used.has(candidateIndex) && record.sentAt === undefined &&
        sameReceiptContent(record, wireComment));
    }
    if (index === undefined || index < 0 || used.has(index) || result[index].sentAt !== undefined) continue;
    used.add(index);
    result[index].sentAt = nowMs;
  }
  return result;
}
