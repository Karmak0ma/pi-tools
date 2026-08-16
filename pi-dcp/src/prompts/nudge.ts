export type NudgeKind = "context" | "turn" | "iteration";

/** Stable prompt text; usage measurements stay in diagnostics. */
export function nudgeText(kind: NudgeKind, force: "soft" | "strong", _estimate?: number): string {
  const prefix = force === "strong" ? "Important:" : "Reminder:";
  if (kind === "iteration") return `${prefix} consider faithful pi-dcp compression for an older resolved range when useful.`;
  if (kind === "turn") return `${prefix} preserve the newest user intent and compress only a complete, resolved range if useful.`;
  return `${prefix} use pi-dcp compress for an older resolved range when useful; keep active work and unresolved questions intact.`;
}
