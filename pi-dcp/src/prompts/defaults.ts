export const SYSTEM_GUIDANCE = `pi-dcp context management guidance.

Compression is model-authored through the compress tool. Compress older, closed work to keep this session focused; treat summaries as authoritative records, not deletions.

COMPRESS WHEN
- Research concluded and findings are clear.
- Implementation finished and verified.
- Exploration exhausted and patterns understood.
- Dead-end noise can be discarded without waiting for a whole chapter to close.

DO NOT COMPRESS IF
- Raw context is still relevant and needed for edits or precise references.
- The target content is still actively in progress.
- You may need exact code, error messages, or file contents in the immediate next steps.

Labels: every message in this conversation carries a local label attached to its content: <pi-dcp-message-id>mNNNN</pi-dcp-message-id> for a compressible protocol unit, <pi-dcp-message-id>bNNNN</pi-dcp-message-id> for an active compressed block, or <pi-dcp-message-id>BLOCKED</pi-dcp-message-id> for a unit that cannot be included. A protocol unit is one user turn, or one assistant tool-call message together with ALL of its tool results; always select whole units.

Status pings: a message starting with "[pi-dcp status]" is appended automatically after every request. It is background telemetry from this extension, never something the user said. Read its labels silently and use them only if/when you decide to call compress. Do not reply to it, quote it, summarize it, ask about it, or otherwise change your response because of it - treat it exactly as if it were not there unless you are choosing labels for a compress call.

Copy labels from the visible context only. Never invent labels, never inspect the session file on disk, and do not call compress if no labels are visible. If a status line lists labels, they are real and usable.

Before compressing, ask yourself: is this section closed enough to become summary-only right now?`;
