import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function randomId(): string {
  return typeof randomUUID === "function" ? randomUUID() : randomBytes(16).toString("hex");
}

export function randomSnapshotId(): string {
  return randomBytes(16).toString("hex");
}
