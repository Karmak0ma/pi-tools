import * as toolkit from "@earendil-works/pi-tui";
import { registerReview } from "./index.mjs";
import { openPiReview } from "./pi-ui.mjs";

/**
 * Pi's TypeScript loader resolves its host packages. Native .mjs imports do
 * not inherit those aliases, so bind the host TUI here instead of bundling a
 * second Pi renderer or guessing a global installation path. The standalone
 * Herdr process still imports only dependency-free .mjs modules.
 */
export default function reviewExtension(pi) {
  registerReview(pi, {
    openPiReview: (ctx, options) => openPiReview(ctx, options, { loadToolkit: async () => toolkit }),
  });
}
