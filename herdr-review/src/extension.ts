import * as toolkit from "@earendil-works/pi-tui";
import { loadReviewLauncher } from "./load-launcher.mjs";
import { openPiReview } from "./pi-ui.mjs";

/**
 * Pi's TypeScript loader resolves its host packages. Native .mjs imports do
 * not inherit those aliases, so bind the host TUI here instead of bundling a
 * second Pi renderer or guessing a global installation path. The standalone
 * Herdr process still imports only dependency-free .mjs modules.
 */
export default async function reviewExtension(pi) {
  // Pi reloads this TypeScript entrypoint, but Node caches native .mjs imports
  // across /reload. A static import kept the pre-update pane launcher alive,
  // even though newly spawned reviewers already used the updated renderer.
  // Give each extension runtime its own launcher URL so layout updates apply
  // on reload. Ordinary dependency modules remain shared; a full Pi restart
  // is still needed after changing those modules during development.
  const { registerReview } = await loadReviewLauncher();
  registerReview(pi, {
    openPiReview: (ctx, options) => openPiReview(ctx, options, { loadToolkit: async () => toolkit }),
  });
}
