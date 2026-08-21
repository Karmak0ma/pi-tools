import { LABEL_TAG_NAME } from "../transform/labels.ts";
import { labelTagPattern } from "../transform/echo.ts";

/**
 * Remove any pi-dcp label tag from Markdown before Pi renders it.
 *
 * Labels are injected into the outgoing request so the model can see them
 * (src/transform/labels.ts), never into the stored session. But nothing
 * stops the model from imitating the pattern and writing a tag of its own
 * into a reply; when that happens the tag is genuine generated text and
 * would otherwise render like any other assistant output.
 *
 * This is the display half of the safety net. The history half lives in
 * transform/echo.ts stripEchoedLabels, which removes the same tags from the
 * stored assistant message so they never come back as context. Both share
 * labelTagPattern() so the two can never disagree.
 */
export function stripLeakedLabelTags(markdown: string): string {
  return markdown.includes(`<${LABEL_TAG_NAME}>`) ? markdown.replace(labelTagPattern(), "") : markdown;
}
