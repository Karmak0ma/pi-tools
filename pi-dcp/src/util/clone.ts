export function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value as Readonly<T>;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
