# pi-opencode-bridge

`pi-opencode-bridge` registers an `opencode-cli` provider in Pi and delegates model calls to the local `opencode` CLI. It is a local replacement for the npm `opencode-pi` extension.

![opencode-pi screenshot](../../assets/opencode-pi.png)

![opencode-cli models in Pi model picker](../../assets/pi-opencode-cli-model-list.png)

![DeepSeek v4 flash free via opencode-cli](../../assets/pi-opencode-deepseek-4-flash.jpeg)

It is intended for the free OpenCode models that work without `opencode auth login`, such as:

- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/nemotron-3-super-free`
- `opencode/big-pickle`

## Requirements

- Pi Coding Agent
- OpenCode installed and available on the same machine:

```bash
opencode --version
opencode models opencode
```

No OpenCode login is required for the bundled free OpenCode models.

## Install

Published on npm: [`opencode-pi`](https://www.npmjs.com/package/opencode-pi). Use **Pi's package manager** (`pi install`), not `npm install` alone.

```bash
pi install npm:opencode-pi
pi install npm:opencode-pi@1.1.0   # pin version
pi install -l npm:opencode-pi      # project-local (.pi/settings.json)
pi -e npm:opencode-pi                # one session, no install
```

Then run `/reload` in Pi (or restart).

```bash
pi list
pi update npm:opencode-pi
pi remove npm:opencode-pi
```

**From [pi-extensions](https://github.com/luongnv89/pi-extensions) (git):**

```bash
cp -r extensions/opencode-pi ~/.pi/agent/extensions/
# or from repo root: npm run install-extensions
```

## Usage

Pick the provider from `/model`, or start Pi directly:

```bash
pi --provider opencode-cli --model opencode/deepseek-v4-flash-free
```

Print-mode smoke test:

```bash
pi -p --provider opencode-cli --model opencode/deepseek-v4-flash-free "Reply with exactly OK"
```

Commands:

```text
/opencode-pi status
/opencode-pi models
/opencode-pi test
/opencode-pi update
/opencode-pi help
```

### Refreshing the model list

OpenCode changes its free model roster frequently. Refresh the registered models at runtime:

```text
/opencode-pi update
```

This queries `opencode models opencode --verbose`, updates the provider's model list, and shows how many new models were added. The status command also displays the timestamp of the last discovery.

## Thinking effort

Models that report reasoning-effort variants (e.g. `opencode/deepseek-v4-flash-free` with `low`/`high`/`max`) are registered with extended thinking enabled, so Pi's thinking selector (`model • thinking`) offers the matching levels. Selecting a level passes `--variant <level> --thinking` to `opencode run`, and the model's reasoning text is forwarded to Pi as a thinking block; "off" runs without the flag (no reasoning tokens).

Models without variants stay `reasoning: false` and only offer "off".

## Configuration

| Environment variable | Description                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `OPENCODE_PI_BIN`    | Override the OpenCode executable path. Defaults to `opencode`.                                      |
| `OPENCODE_PI_MODELS` | Comma- or space-separated model list to register. Values without `/` are prefixed with `opencode/`. Bypasses discovery, so variant data is unavailable and the listed models are registered with thinking off. |

Example:

```bash
OPENCODE_PI_MODELS="opencode/deepseek-v4-flash-free,opencode/mimo-v2.5-free" pi
```

## How it works

For each Pi model call, the extension:

1. Creates a temporary OpenCode project with a locked-down `pi-model` agent.
2. Denies OpenCode's own tools (`bash`, `edit`, `read`, web tools, subagents, etc.).
3. Sends Pi's current prompt/context to `opencode run --format json` over stdin.
4. Streams the final OpenCode text back into Pi.
5. Converts `<pi_tool_call>{...}</pi_tool_call>` markers into real Pi tool calls, so Pi executes tools rather than OpenCode.
6. Validates tool names and required arguments, tolerates common formatting mistakes (including model-specific DSML closing tokens), and retries once only when tool intent is present but no valid call can be recovered.

This keeps file access and edits under Pi's normal tool pipeline.

## Notes and limitations

- This is a CLI bridge, not a native provider API. It is slower than direct HTTP providers because it starts `opencode run` for each model turn.
- Tool calling is prompt-bridged. This bridge treats an explicit opening marker plus balanced tool-call JSON as complete even if the model substitutes a malformed closing token. It preserves recovered valid calls, validates them, and makes one bounded repair attempt only when zero calls are executable. Native tool-call providers will still be more reliable.
- Image input is not registered; these models are exposed as text-only in Pi.
- If OpenCode ever attempts to use its own tools, the extension fails the turn instead of hiding it.
