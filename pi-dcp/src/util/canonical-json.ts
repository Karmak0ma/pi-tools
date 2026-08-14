export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value, new WeakSet());
}

function stringifyCanonical(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return "null";
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "bigint": return JSON.stringify(`${value}n`);
    case "undefined": return "null";
    case "function": return JSON.stringify("[function]");
    case "symbol": return JSON.stringify(String(value));
    case "object": break;
  }
  if (typeof value === "object" && value !== null) { if (seen.has(value)) return JSON.stringify("[cycle]"); seen.add(value); }
  if (Array.isArray(value)) return `[${value.map((item) => stringifyCanonical(item, seen)).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringifyCanonical(object[key], seen)}`).join(",")}}`;
}

export function canonicalPlainObject(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value && typeof value === "object") { if (seen.has(value)) return "[cycle]"; seen.add(value); }
  if (Array.isArray(value)) return value.map((item) => canonicalPlainObject(item, seen));
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalPlainObject(value[key], seen);
    }
    return result;
  }
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try { const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null; } catch { return false; }
}
