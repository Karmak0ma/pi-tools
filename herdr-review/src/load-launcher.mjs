import { randomUUID } from "node:crypto";

/**
 * Keep this import in native ESM. Pi's TypeScript loader can strip query
 * strings when it transforms dynamic imports, so putting the cache-busting
 * import directly in extension.ts still reuses the old launcher on /reload.
 * This helper may be cached; each call must load a new launcher instance.
 */
export function loadReviewLauncher() {
  const launcher = new URL("./index.mjs", import.meta.url);
  launcher.searchParams.set("runtime", randomUUID());
  return import(launcher.href);
}
