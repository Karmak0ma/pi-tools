# Git review inside Pi or Herdr

Review the current repository, leave comments on source lines, then submit them as user feedback to the Pi session that opened the review. No browser is needed.

Outside Herdr, the **Pi extension** opens a review screen inside Pi's existing terminal. Inside Herdr, the optional **Herdr plugin** launches the same review behavior in a focused split pane on the right. The extension uses the host's Pi TUI package; the separate terminal reviewer uses Node's standard library, with no bundled runtime npm dependencies.

## Install

Requires Node.js 22+, Git, and interactive terminal Pi. Linux is the initial supported platform. RPC, JSON, and print modes cannot display this custom review screen.

Run the following commands from the **pi-tools repository root**, not from the `herdr-review` directory or the repository you want to review. Alternatively, replace `$PWD/herdr-review` with the absolute path to this extension.

Install the Pi extension:

```bash
pi install "$PWD/herdr-review"
```

Herdr is **not required** for the in-Pi screen. If Pi runs inside Herdr, `/review` selects the Herdr pane automatically, so you must also register the pane launcher. It requires a Herdr release that supports `herdr plugin pane open`:

```bash
herdr plugin link "$PWD/herdr-review"
```

Run `/reload` in the existing Pi session after installation. Open with `/review` or **Alt+R**. Pi shortcuts can conflict with other extensions or terminal bindings; `/review` remains available.

**Outside Herdr:** the review fills Pi's terminal viewport. The conversation stays behind the review; `q`, Esc, or Ctrl+C closes the review and returns to Pi. Pi owns rendering and terminal modes throughout—no extra window, subprocess TUI, or browser is opened. Each comparison has separate drafts; reopening the same comparison restores them.

**Inside Herdr:** the review opens in a **split to the right of the calling Pi pane**, with focus on the review. The pane label and entry in Herdr's **Agents** list are named **review**. The shared conversation tab is not renamed. Repeating the same `/review` command focuses its existing review. Each comparison has a separate pane and saved notes. Closing and reopening the same comparison in the same Pi runtime and repository restores those notes, including delivery status.

In Herdr, the reviewer reports its own `review` lifecycle label to Herdr; it does not pretend to be Pi or start another AI agent. It releases that report on normal close, Ctrl+C, and termination signals. No Herdr source changes or global keybinding changes are needed. Keep Herdr mouse capture enabled for mouse comments. Plain left-clicks are used; Ctrl-click is reserved for Herdr link handling.

## Typical workflow

1. Open `/review` for working-tree changes, or `/review develop...HEAD` for a committed branch comparison.
2. Select a file in the left pane. Read its unified diff in the right pane.
3. Hover a source line and click its `[+]`, or select the line with the keyboard and press Enter.
4. Write a comment in the inline **Draft note** box. Press **Ctrl+S** to save it as **Unsent**, or Esc to cancel.
5. Repeat for other lines. Use `n` / `p` to visit saved comments and `r` to refresh the diff.
6. Press `s` or Shift+S, review the unsent count, and press Enter to send. Accepted notes remain visible as **Sent to Pi**.

**Saving is not sending.** You can collect and edit several unsent notes before submitting one feedback message. “Sent to Pi” means accepted or queued by Pi, not that the model has acted on the feedback.

## Choose the comparison

```text
/review                  Working tree against HEAD (the default)
/review develop...HEAD   Committed feature changes since the merge base with develop
/review develop..HEAD    Direct comparison of the two committed endpoints
```

Three dots use Git's merge-base rule: compare the common ancestor of `develop` and `HEAD` with `HEAD`. Changes made only on `develop` after the branches split do not appear. Two dots compare the named commits directly, so changes unique to either endpoint can appear.

**Revision-pair views contain committed changes only.** They exclude staged, unstaged, and untracked edits. Use plain `/review` or Alt+R to review those edits. Branches, tags, commit IDs and revisions such as `HEAD~2..HEAD` are supported; both endpoints must be explicit. Refs are local: the reviewer does not fetch remote branches.

The header and submitted feedback identify the comparison. Named refs are resolved again on refresh, so new commits appear automatically. Each line comment also keeps its original resolved base/tip commit IDs, even if the branches later advance.

Pass one revision pair, not `git diff`, shell commands, paths, or Git flags. Arguments are never executed through a shell. Unknown revisions, unrelated histories with three dots, and ambiguous multiple merge bases fail with an error instead of silently changing scope. For unrelated histories or multiple merge bases, use an explicit `base..tip` comparison.

## What changes are shown?

With no command arguments:

- All current changes against **HEAD**, combining staged and unstaged edits.
- Untracked files, excluding ignored files.
- File status and added/deleted line counts, plus a unified diff with old/new line numbers.
- Renames, deleted files, and binary-file indicators.
- Git worktrees and invocation from a subdirectory of a repository.
- New repositories without a first commit.

Git is read-only here: this extension never stages, commits, or edits repository files. It disables external diff programs and text conversion. Git shows **all repository changes**, not which agent made each edit. Edits from you or another agent are included too.

The view refreshes every three seconds while open; `r` refreshes immediately. Diffs above 32 MiB are rejected rather than silently truncated. If Git cannot produce a complete snapshot, the old view remains and the error is shown. A snapshot is not an atomic filesystem transaction: another process can edit files during a Git read. Metadata and patches come from the same Git invocation, so separate reads cannot assign one file's patch to another. The original quoted line and diff fingerprint are always kept with a comment.

Initial limits: unresolved merge-conflict index entries are unsupported in the working-tree view; committed comparisons do not depend on the index. Copies are shown as additions; renames use Git's usual 50% similarity threshold. Submodules show pointer changes only, and untracked nested repositories are skipped. Git's built-in EOL and ident conversion still applies. Configured external filters are disabled when a snapshot starts; do not change filter configuration during a read.

## Controls

These controls apply while browsing the diff or comments. While editing a comment, letters such as `n`, `p`, `r`, and `s` are ordinary text.

| Control | Action |
| --- | --- |
| Click a file | Select its diff |
| Click source text | Select the source row only; does not open a comment |
| Hover a source row, then click its `[+]` on the right | Open a comment box immediately below that line |
| Click a note's `[Edit]` | Edit its text inline |
| Click an unsent note's `[x]` | Delete that unsent note |
| Tab | Switch keyboard focus between files and diff |
| Up/Down, Page Up/Down, Home/End | Navigate the focused list |
| Left/Right | Scroll long diff lines horizontally |
| Enter | Enter the diff from the file list; add/edit at the selected row or selected note |
| `n` / `p` | Next / previous saved comment in diff order, including sent revisions; wraps across files |
| `c` | List all comments and delivery status; Enter edits, `d` deletes an unsent note, Esc returns |
| `s`, Shift+S, or click Send | Confirm submission of **unsent** notes only; Enter sends, Esc cancels |
| `r` | Refresh the diff immediately without losing comments |
| `q`, Esc, Ctrl+C | Close the reviewer; saved drafts remain |

### Edit a comment

The inline **Draft note** box has a thin amber border, a file and line label (`R` for the new version, `L` for the old version), a muted **Write a note…** hint, and bottom-right Save/Cancel buttons.

| Editor control | Action |
| --- | --- |
| Ctrl+S or click Save | Save an unsent note; does not send feedback |
| Esc or click Cancel | Discard this edit; keep any previously saved note unchanged |
| Enter | Insert a new line |
| Backspace | Remove text |
| Ctrl+C | Close the reviewer; unfinished editor text is not saved |

Inside Pi, comments use Pi's multi-line editor with its normal cursor movement and text controls. The host editor's extra borders are hidden, while its text cursor and input-method support remain intact. The separate Herdr reviewer has an append-only editor without a movable text cursor; Ctrl+U clears its current line.

Bracketed paste is accepted as text, never as navigation or submission commands. **Save before closing:** unfinished editor text is not a saved comment.

## Appearance and mouse support

The review needs at least 64 columns and 16 rows, including space for the inline editor. Resize the terminal or zoom the Herdr pane if it is too small. Added source rows have a dark green background; deleted rows have a dark red background. A neutral gray background marks the hovered source row, and keyboard selection uses bold text without removing the diff background. These are display styles applied to the existing Git diff, not a different Git comparison tool.

Only the hovered source row displays `[+]`. Its action column stays fixed when panning, with a one-cell right margin. Moving over the file list, notes, or controls hides it. Clicking source text selects the row but does not start a comment.

Pi routes mouse clicks to custom components in its **fullscreen TUI mode**. In Pi's regular mode, mouse input stays with the terminal; use Tab, arrows, and Enter to comment. This extension does not change your `tuiMode` setting or enable raw mouse capture behind Pi's back. The review still fills the viewport in regular mode, but keyboard controls are the reliable input path. Herdr's standalone reviewer requests all-motion mouse reports while open and restores them on close. In Pi, hover is available only when Pi's own terminal mode delivers pointer moves; some nested terminal multiplexers suppress those reports even in fullscreen mode. The extension does not change host mouse settings to work around that limitation. Use Enter at the selected source row when hover is unavailable.

## Line identity and concurrent edits

Comments contain the repository-relative filename, line number, old/new side, quoted source (up to 20,000 characters), and the reviewed file-diff fingerprint. Committed comparisons also include the exact original base/tip commit IDs; these line numbers need not match the current working tree. Deleted lines use the old path and old line number. Diff headings and binary indicators cannot receive line comments.

If the file diff changes or disappears, its comments become **OUTDATED**. Comments are never silently moved to another line. Submission refreshes changes again and includes the original anchor plus an outdated warning. Returning to the exact original diff clears that warning.

## Sent and unsent notes

Saving with Ctrl+S creates an **Unsent** note; it does not send feedback to the model. Notes appear below their source line with an Unsent or **Sent to Pi** label and a revision number. The footer shows separate unsent/sent counts, and `c` lists all notes, including outdated ones.

Submitting sends only unsent revisions. After Pi acknowledges them, the notes stay visible and are marked Sent to Pi; pressing Send again does not resend them. Editing a sent note creates a new unsent revision in the same comment thread. The original sent text is retained and cannot be retracted or deleted. Editing an unsent note updates that draft; Esc leaves it unchanged, and `[x]` deletes it.

Counts refer to comment revisions, not unique source lines: a sent original plus its unsent correction counts as one sent and one unsent note. Old saved drafts are migrated as unsent. Previously discarded sent notes from earlier versions cannot be reconstructed.

## Feedback delivery

Submission sends one message beginning **“The user left feedback on the repository changes.”** It includes each unsent comment revision and its source anchor. Thread IDs and revision numbers identify corrections to earlier feedback. Pi receives it through `sendUserMessage`, with prompt-template expansion disabled:

- **Pi idle:** the feedback starts a new turn.
- **Pi busy:** feedback is queued as a follow-up; it does not interrupt the current work.

A receipt means Pi accepted the message, not that the model has read or completed it. Only the opening session can receive feedback. `/new`, `/resume`, `/reload`, Pi shutdown, or opening a review for a different repository close the previous connection. An in-Pi review closes on session shutdown or replacement. Old Herdr review panes remain open for reading and draft recovery, but cannot send to a replacement session.

Feedback travels over a private local Unix socket, not terminal keystrokes. Requests have a per-runtime secret and are size-limited. The socket directory is owner-only and outside the repository. This is not isolation from other processes running as your own user.

Failed delivery keeps the drafts; Enter retries from the confirmation screen. Retry uses the same submission ID, so a lost receipt does not duplicate feedback in the same runtime. Reusing an ID with different comments is rejected. Comments are locked after an attempted submission until its receipt is obtained; this prevents an uncertain delivery from being resent as a different batch. Open a fresh review after a session replacement rather than trying to reconnect the old one.

Saved comments, sent-revision status, pending batches, and connection details are in an owner-only `pi-review-*` directory under the system temporary directory. Closing and reopening the same comparison in the same Pi runtime restores its notes automatically.

The files can remain after `/reload` or Pi shutdown until system temporary-file cleanup removes them, but a replacement runtime creates a new connection and does **not** automatically import the previous runtime's notes. For manual recovery, read the old directory's `drafts.json`; do not share `connection.json`, which contains the connection secret. This is recovery storage, not a permanent review archive.

## Troubleshooting

### `plugin_not_found`

Pi detected Herdr, but the `vflo.review` plugin is not registered. Link the extension directory, using its actual absolute path:

```bash
herdr plugin link /absolute/path/to/pi-tools/herdr-review
```

Then retry `/review`. The launcher does not silently switch to the in-Pi screen when the Herdr plugin is missing.

### `plugin_manifest_not_found`

The path passed to `herdr plugin link` does not contain [herdr-plugin.toml](herdr-plugin.toml). Check your shell's working directory or use the absolute extension path. `$PWD/herdr-review` is correct only from the pi-tools repository root.

### The pane is too narrow, or no `[+]` appears

The review needs **64 columns and 16 rows**. Widen or zoom the pane if necessary. Hover actions also require pointer-motion reports from the terminal. If the host does not supply them, use Tab, arrows, and Enter to add a comment.

### Changes to the extension are not visible

Run `/reload` in Pi, close the old Herdr review pane, and run `/review` again. Existing standalone panes keep running the code with which they started. Saved notes from an old runtime remain available only for manual recovery as described above.

## Development

```bash
npm run check --prefix herdr-review
```

Tests cover committed merge-base/direct comparisons and dirty-file exclusion, Git line mapping and unusual paths, source anchors, terminal input decoding and hit mapping, feedback receipts/retries, separate comparison panes, in-Pi keyboard/mouse/paste behavior, and Pi session lifecycle. A terminal smoke test is also useful for real Herdr mouse forwarding, scrolling, resizing, and focus behavior.

The package entrypoint is [src/extension.ts](src/extension.ts): it binds Pi's host TUI modules through Pi's loader instead of bundling another renderer. Load the [package manifest](package.json), or that entrypoint for development, not the standalone terminal app as an extension.

The implementation separates:

- [Git snapshots](src/git.mjs).
- [Immutable sent revisions and draft migration](src/comments.mjs).
- [Shared review state and actions](src/controller.mjs).
- [Layout, styling, and hit regions](src/view.mjs).
- [The host-owned Pi screen](src/pi-ui.mjs).
- [The standalone terminal adapter](src/tui.mjs) and [safe frame writer](src/terminal-frame.mjs).
- [Local feedback delivery](src/protocol.mjs).
- [Pi lifecycle and launch selection](src/index.mjs), with [Herdr lifecycle integration](src/herdr.mjs).

Both adapters share line anchoring, draft persistence, refresh, and retry rules. The standalone frame writer clears each row **before** writing it: clearing after a full-width row can erase its final character on real terminals.
