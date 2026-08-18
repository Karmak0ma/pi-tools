import { Type, type Static } from "typebox";

/** Version-2 is intentionally free of model-echoed snapshot credentials. */
export const CompressionParametersV2 = Type.Object({
  topic: Type.String({ minLength: 1, maxLength: 120 }),
  content: Type.Array(Type.Object({
    startId: Type.String({ pattern: "^(m|b)[0-9]{4}$" }),
    endId: Type.String({ pattern: "^(m|b)[0-9]{4}$" }),
    summary: Type.String({ minLength: 1, maxLength: 100000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });
export const CompressionParameters = CompressionParametersV2;
export type CompressionParams = Static<typeof CompressionParametersV2>;

export function isCompressionParams(value: unknown): value is CompressionParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  // Reject old calls rather than silently interpreting v1 authorization state.
  if (Object.keys(input).some((key) => !["topic", "content"].includes(key))) return false;
  if (typeof input.topic !== "string" || input.topic.length < 1 || input.topic.length > 120) return false;
  if (!Array.isArray(input.content) || input.content.length < 1 || input.content.length > 16) return false;
  return input.content.every((range) => {
    if (!range || typeof range !== "object" || Array.isArray(range)) return false;
    const item = range as Record<string, unknown>;
    return typeof item.startId === "string" && /^(m|b)[0-9]{4}$/.test(item.startId)
      && typeof item.endId === "string" && /^(m|b)[0-9]{4}$/.test(item.endId)
      && typeof item.summary === "string" && item.summary.length >= 1 && item.summary.length <= 100000
      && Object.keys(item).every((key) => ["startId", "endId", "summary"].includes(key));
  });
}
