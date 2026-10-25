# Upstream configuration inventory

Compared with [herdr-hunk-diff configuration](https://github.com/jhochenbaum/herdr-hunk-diff#configuration), at revision [`ac5eef7`](https://github.com/jhochenbaum/herdr-hunk-diff/tree/ac5eef7cec6a65fbf8f0c9bbd61b4383489beba5).

**herdr-review has no user configuration loader. None of these 14 settings is exposed here.** Some settings have a fixed equivalent; others are missing features. The three `hunk.*` settings do not apply because this extension uses its own renderer. This document is an inventory, not a promise to add these settings.

Upstream defaults and accepted values below come from its [configuration reference][configuration] and [configuration loader][loader]. Local behavior refers to the updated implementation in this repository.

## Review settings

| Upstream setting | Default | Accepted values and effect | herdr-review behavior or gap |
| --- | --- | --- | --- |
| `review.auto_open` | `false` | Boolean. Open or refresh on an associated agent's state event. | **Missing feature.** Open manually with `/review` or Alt+R. No state-triggered opening. |
| `review.on_states` | `["idle"]` | List of `idle`, `working`, `blocked`, `unknown`. Empty disables triggers. | **Missing feature.** No configurable agent-state triggers. |
| `review.reuse_pane` | `true` | Boolean. Reuse the worktree's existing review pane where possible. | **Fixed equivalent with different scope.** Repeated commands reuse the same comparison's review tab in the same Pi runtime. Switching comparisons brings the calling agent and matching reviewer together in a two-pane tab. No option to disable reuse. |
| `review.default_target` | `"auto"` | `auto`, `working`, `staged`, `branch`. Choose the standing default comparison. | **Missing target selection.** Default is always working tree against HEAD, including staged and unstaged edits together. Explicit `base..tip` / `base...tip` comparisons are supported, but staged-only and automatic branch selection are not. |
| `review.base` | `""` | Ref string. Empty means detect a base for branch reviews. | **Manual equivalent only.** Supply the base in `/review develop...HEAD`. No stored base or automatic base detection. |
| `review.watch` | `false` | Boolean. Pass `--watch` to Hunk to refresh when source changes. | **Fixed equivalent.** Refresh every three seconds, plus `r` for an immediate refresh. Herdr text selection and optional native copy mode pause automatic refresh. No configurable watch switch or interval. |
| `review.exclude_untracked` | `false` | Boolean. Exclude untracked files in working, staged and branch reviews; also affects automatic target selection. | **Missing switch.** Default working-tree review includes non-ignored untracked files. Explicit committed comparisons exclude all working-tree edits, not just untracked files. |
| `review.placement` | `"split"` | `overlay`, `split`, `tab`, `zoomed`. Choose the persistent Herdr placement. | **Fixed placement.** A dedicated Herdr tab with the calling agent on the left and reviewer on the right, each at half width. Outside Herdr, a viewport-filling Pi overlay. No placement setting. |
| `review.focus` | `false` | Boolean. Focus manual opens/reuses. Upstream automatic opens never take focus. | **Fixed enabled behavior.** `/review` explicitly focuses its new or reused Herdr tab. No background-open setting. |

Sources: [upstream review settings and defaults][configuration], [upstream target selection and placement details][targets]. Local: [launch and reuse](../src/index.mjs), [refresh and copy mode](../src/controller.mjs), [Git comparisons](../src/git.mjs), [Pi overlay](../src/pi-ui.mjs).

Upstream `auto` chooses the working tree when dirty; otherwise it chooses a branch comparison when ahead of the detected base, and falls back to the working tree. Our plain `/review` does not make this choice. See [upstream target rules][targets].

## Feedback settings

| Upstream setting | Default | Accepted values and effect | herdr-review behavior or gap |
| --- | --- | --- | --- |
| `roundtrip.clear_after_send` | `true` | Boolean. Remove comments after successful delivery; false retains them as sent. | **Fixed false-like behavior.** Retain accepted notes as `Sent to Pi`; send only unsent revisions. Editing a sent note creates a new unsent revision. No clear-after-send switch. |
| `roundtrip.prompt_template` | Built-in prompt below | String. Customize the message sent with comments. | **Missing customization.** Uses a fixed feedback message with line anchors and revision identity. Pi prompt-template expansion is disabled; that is not a substitute for this upstream setting. |

The upstream default prompt is:

```text
Human-authored inline review comments on your changes in {worktree}:

{comments}

Address each comment and verify the resulting changes. If a comment is unclear or requires a decision, ask a focused clarification question and continue with any unaffected comments. Then summarize what you changed and explain anything you did not implement.
```

Upstream supports `{comments}` (unsent notes as Markdown), `{count}` (number sent), `{worktree}` (absolute worktree path), and `{agent}` (associated name, or `agent`). Sources: [default prompt][loader], [template placeholders][prompts]. Local: [sent revisions](../src/comments.mjs), [feedback message](../src/protocol.mjs), [Pi delivery](../src/index.mjs).

## Hunk launch settings

| Upstream setting | Default | Accepted values and effect | herdr-review behavior or gap |
| --- | --- | --- | --- |
| `hunk.bin` | `"auto"` | `auto` for the bundled Hunk binary, or an absolute executable path. | **Not applicable.** No Hunk executable is launched. |
| `hunk.experimental` | `false` | Boolean. Pass `--experimental`, including STML-rendered agent notes. | **Not applicable.** No Hunk flags or STML integration. |
| `hunk.extra_args` | `[]` | List of strings appended to each Hunk launch. | **Not applicable.** No external renderer argument interface. |

Sources: [upstream executable settings][executable], [local standalone renderer](../src/tui.mjs), [local Pi renderer](../src/pi-ui.mjs).

## Configuration location and presentation settings

Upstream reads `config.toml` from the directory returned by `herdr plugin config-dir jhochenbaum.hunkdiff`. It ignores files elsewhere. This extension does **not** read that file. See [upstream configuration][configuration].

Theme, split/stack layout, line numbers, wrapping and tab width are **Hunk application settings**, not additional `herdr-hunk-diff` plugin settings. Upstream directs users to `~/.config/hunk/config.toml`. Those controls also have no configurable equivalent in our own renderer, but are not included in the 14-option plugin count. See [upstream presentation note][targets].

[configuration]: https://github.com/jhochenbaum/herdr-hunk-diff/blob/ac5eef7cec6a65fbf8f0c9bbd61b4383489beba5/README.md#configuration
[loader]: https://github.com/jhochenbaum/herdr-hunk-diff/blob/ac5eef7cec6a65fbf8f0c9bbd61b4383489beba5/src/config.ts
[targets]: https://github.com/jhochenbaum/herdr-hunk-diff/blob/ac5eef7cec6a65fbf8f0c9bbd61b4383489beba5/README.md#review-target-and-display
[prompts]: https://github.com/jhochenbaum/herdr-hunk-diff/blob/ac5eef7cec6a65fbf8f0c9bbd61b4383489beba5/README.md#round-trip-prompts
[executable]: https://github.com/jhochenbaum/herdr-hunk-diff/blob/ac5eef7cec6a65fbf8f0c9bbd61b4383489beba5/README.md#hunk-executable
