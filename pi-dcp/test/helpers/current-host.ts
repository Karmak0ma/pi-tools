import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { projectHostSessionProjection, type ProjectionResult } from "../../src/identity/project.ts";

/** Build the exact Pi 0.87 projection used by current-host test contexts. */
export function projectCurrentEntries(entries: readonly unknown[], leafId?: string): ProjectionResult {
  const resolvedLeafId = leafId ?? (entries.at(-1) as { id?: string } | undefined)?.id;
  return projectHostSessionProjection(() => buildSessionProjection(entries as any, resolvedLeafId));
}

/** Provide the SessionManager surface required by the current Pi host gate. */
export function currentHostSessionManager(entries: readonly unknown[], leafId?: string): Record<string, unknown> {
  const resolvedLeafId = leafId ?? (entries.at(-1) as { id?: string } | undefined)?.id ?? null;
  return {
    buildContextEntries: () => entries,
    buildSessionProjection: () => buildSessionProjection(entries as any, resolvedLeafId),
    getBranch: () => entries,
    getLeafId: () => resolvedLeafId,
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  };
}
