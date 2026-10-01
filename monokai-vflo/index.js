import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Patch the running host's class, not a separately installed copy. The CLI can
// start from dist/bundle/cli.js, so its directory is not always one level below
// the package root. Walk upward until the host entry point confirms the root.
// File URL conversion supports Windows drive letters and paths with spaces.
function findPiRoot(start) {
  let directory = start;
  while (true) {
    if (existsSync(resolve(directory, "dist/index.js"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find Pi package root above ${start}`);
    directory = parent;
  }
}

const PI_ROOT = findPiRoot(dirname(realpathSync(process.argv[1])));
const { AssistantMessageComponent } = await import(pathToFileURL(resolve(PI_ROOT, "dist/index.js")).href);
const { Box, Markdown, Spacer, Text } = await import(
  pathToFileURL(resolve(PI_ROOT, "node_modules/@earendil-works/pi-tui/dist/index.js")).href
);

const OSC_PREFIX_RE = /^(?:\x1b\][^\x07]*\x07)*/;
const assistantRenderCache = new WeakMap();
let patched = false;
let activeTheme;

function extractLeadingOsc(line) {
  const match = line.match(OSC_PREFIX_RE);
  const prefix = match?.[0] ?? "";
  return { prefix, rest: line.slice(prefix.length) };
}

function addThinAssistantBorder(instance, lines, width) {
  if (!activeTheme || lines.length === 0) return lines;

  // Retain the screenshot's sampled cache and weak ownership: completed messages
  // can reuse their decorated lines without keeping discarded components alive.
  // This is not a full-content comparison; see the compatibility notes in README.
  const middleIndex = Math.floor(lines.length / 2);
  const cached = assistantRenderCache.get(instance);
  if (
    cached &&
    cached.width === width &&
    cached.lineCount === lines.length &&
    cached.first === lines[0] &&
    cached.second === lines[1] &&
    cached.middle === lines[middleIndex] &&
    cached.last === lines[lines.length - 1]
  ) {
    return cached.result;
  }

  // OSC markers identify assistant output to the terminal. They must precede
  // the visible border so the added column does not move the zone boundary.
  const border = activeTheme.fg("success", "│");
  const result = lines.map((line, index) => {
    if (index === 0 && line === "") return line;
    const { prefix, rest } = extractLeadingOsc(line);
    return prefix + border + rest;
  });

  assistantRenderCache.set(instance, {
    width,
    lineCount: lines.length,
    first: lines[0],
    second: lines[1],
    middle: lines[middleIndex],
    last: lines[lines.length - 1],
    result,
  });
  return result;
}

function installPatches() {
  if (patched) return;
  patched = true;

  // A theme JSON cannot add borders or wrap assistant content in boxes. The
  // original extension therefore replaces the assistant's internal renderer.
  // Reserve one column before wrapping Markdown, keeping lines within width.
  const originalAssistantRender = AssistantMessageComponent.prototype.render;
  AssistantMessageComponent.prototype.render = function renderWithThinAssistantBorder(width) {
    const safeWidth = Math.max(1, Math.floor(width));
    const lines = originalAssistantRender.call(this, Math.max(1, safeWidth - 1));
    return addThinAssistantBorder(this, lines, safeWidth);
  };

  // Preserve the photographed layout, including the separate thinking heading
  // and its collapsed label. These fields are host internals, not a supported
  // extension API; Pi upgrades need a renderer compatibility check.
  AssistantMessageComponent.prototype.updateContent = function patchedAssistantUpdateContent(message) {
    this.lastMessage = message;
    this.contentContainer.clear();

    let hasVisibleBlocks = false;
    const addGap = () => {
      if (hasVisibleBlocks) this.contentContainer.addChild(new Spacer(1));
      hasVisibleBlocks = true;
    };
    const addBox = (bg, builder) => {
      const box = new Box(1, 1, (content) => (activeTheme ? activeTheme.bg(bg, content) : content));
      builder(box);
      this.contentContainer.addChild(box);
    };

    for (const content of message.content) {
      if (content.type === "text" && content.text.trim()) {
        addGap();
        addBox("customMessageBg", (box) => {
          box.addChild(new Markdown(content.text.trim(), 0, 0, this.markdownTheme));
        });
      } else if (content.type === "thinking" && content.thinking.trim()) {
        addGap();
        addBox("toolPendingBg", (box) => {
          const label = this.hideThinkingBlock ? this.hiddenThinkingLabel : "Thinking";
          const heading = activeTheme
            ? activeTheme.fg("thinkingMedium", activeTheme.bold(label))
            : label;
          box.addChild(new Text(heading, 0, 0));
          if (!this.hideThinkingBlock) {
            box.addChild(new Spacer(1));
            box.addChild(
              new Markdown(content.thinking.trim(), 0, 0, this.markdownTheme, {
                color: (text) => (activeTheme ? activeTheme.fg("thinkingText", text) : text),
                italic: true,
              }),
            );
          }
        });
      }
    }

    // Tool execution components own tool-call errors. Only messages without
    // tool calls get the standalone error/abort notice, matching the original.
    const hasToolCalls = message.content.some((c) => c.type === "toolCall");
    this.hasToolCalls = hasToolCalls;
    if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const abortMessage =
          message.errorMessage && message.errorMessage !== "Request was aborted"
            ? message.errorMessage
            : "Operation aborted";
        if (hasVisibleBlocks) this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(
          new Text(activeTheme ? activeTheme.fg("error", abortMessage) : abortMessage, 1, 0),
        );
      } else if (message.stopReason === "error") {
        const errorMsg = message.errorMessage || "Unknown error";
        if (hasVisibleBlocks) this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(
          new Text(activeTheme ? activeTheme.fg("error", `Error: ${errorMsg}`) : `Error: ${errorMsg}`, 1, 0),
        );
      }
    }
  };
}

export default function (pi) {
  // Match the source: loading this package offers the theme but does not select
  // it automatically. Layout patches apply regardless of the selected theme.
  pi.on("session_start", (_event, ctx) => {
    activeTheme = ctx.ui.theme;
    installPatches();
  });
}
