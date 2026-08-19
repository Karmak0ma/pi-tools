import { LABEL_TAG_NAME } from "../transform/labels.ts";

// Matches one inline label tag exactly as formatLabelTag() writes it,
// including the leading newline it always prepends. Global so a message
// with more than one leaked tag (e.g. after a retry) is fully cleaned.
const LABEL_TAG_PATTERN = new RegExp(`\\n?<${LABEL_TAG_NAME}>[^<]*</${LABEL_TAG_NAME}>`, "g");

/**
 * Remove any pi-dcp label tag from Markdown before Pi renders it.
 *
 * Labels are injected into the outgoing request so the model can see them
 * (src/transform/labels.ts), never into the stored session. But nothing
 * stops the model from imitating the pattern and writing a tag of its own
 * into a reply; when that happens the tag is genuine generated text and
 * would otherwise render like any other assistant output. This is a
 * display-only safety net: it never touches the session or the context sent
 * back to the model, so it is harmless even if the leak is fixed elsewhere
 * or never happens at all.
 */
export function stripLeakedLabelTags(markdown: string): string {
  return markdown.includes(`<${LABEL_TAG_NAME}>`) ? markdown.replace(LABEL_TAG_PATTERN, "") : markdown;
}
