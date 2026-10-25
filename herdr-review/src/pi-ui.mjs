import { readFile } from "node:fs/promises";
import path from "node:path";
import { createReviewController } from "./controller.mjs";
import { plain } from "./view.mjs";

const cleanText = (text) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 20_000);

/**
 * Pi owns terminal modes, input parsing and rendering. This adapter must never
 * write terminal escapes, attach stdin listeners, or enable raw/mouse modes.
 * Host width helpers and Editor keep wide text and IME cursors correct.
 */
export function createPiReviewComponent({ controller, tui, theme, keybindings, toolkit }) {
  const { Editor, Key, matchesKey, truncateToWidth, sliceByColumn } = toolkit;
  const state = controller.state;
  const editor = new Editor(tui, {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  });
  editor.disableSubmit = true;
  let focused = true, boundEditor, editorBounds, editorRowOffset = 1, editorFullHeight = 0, inPaste = false, pasteTail = "";
  function bindEditor() {
    if (boundEditor !== state.editor) {
      boundEditor = state.editor;
      editor.setText(cleanText(state.editor.text));
    }
    editor.focused = focused && state.mode === "edit";
  }
  function syncText() {
    const text = editor.getExpandedText();
    state.editor.text = cleanText(text);
    if (text !== state.editor.text) editor.setText(state.editor.text);
  }
  function keyEvent(data) {
    const actions = [
      [Key.ctrl("c"), "quit"], [Key.ctrl("s"), "save"],
      [Key.tab, "tab"], [Key.up, "up"], [Key.down, "down"],
      [Key.left, "left"], [Key.right, "right"], [Key.pageUp, "pageup"],
      [Key.pageDown, "pagedown"], [Key.home, "home"], [Key.end, "end"],
      [Key.enter, "enter"], [Key.escape, "escape"],
    ];
    // Respect Pi's configured selection keys as well as the documented keys.
    for (const [binding, key] of [["tui.select.up", "up"], ["tui.select.down", "down"], ["tui.select.confirm", "enter"], ["tui.select.cancel", "escape"]]) {
      if (keybindings.matches(data, binding)) return { type: "key", key };
    }
    for (const [binding, key] of actions) if (matchesKey(data, binding)) return { type: "key", key };
    // A pasted string must never turn into a sequence of UI commands.
    return /^[acdnprsqS]$/.test(data) ? { type: "text", text: data } : undefined;
  }
  return {
    get focused() { return focused; },
    set focused(value) { focused = value; editor.focused = value && state.mode === "edit"; },
    render(width) {
      const height = Math.max(1, tui.terminal.rows);
      const fitLine = (value, size, offset = 0) => truncateToWidth(sliceByColumn(plain(value), offset, size, true), size, "", true);
      const rendered = controller.render(width, height, fitLine, (bodyWidth, maxRows) => {
        bindEditor();
        const full = editor.render(bodyWidth);
        editorFullHeight = full.length;
        // The shared view owns the single draft box. Remove Pi Editor's own
        // top/bottom borders instead of drawing a second box inside that box.
        const body = full.slice(1, -1);
        const cursorRow = toolkit.CURSOR_MARKER ? body.findIndex((line) => line.includes(toolkit.CURSOR_MARKER)) : -1;
        const start = Math.max(0, cursorRow - maxRows + 1);
        editorRowOffset = start + 1;
        const visible = body.slice(start, start + maxRows);
        if (!state.editor.text) {
          const cursor = editor.focused ? (toolkit.CURSOR_MARKER || "") : "";
          const first = editor.focused && toolkit.renderFakeCursor ? toolkit.renderFakeCursor("W") : "W";
          visible[0] = theme.fg("dim", cursor + first + "rite a note…");
        }
        return visible.map((line) => truncateToWidth(line, bodyWidth, "", true));
      });
      editorBounds = rendered.editorBounds;
      editor.focused = focused && state.mode === "edit";
      return rendered.lines.map((line) => truncateToWidth(line, width, "", true));
    },
    handleInput(data) {
      // Remember paste framing at arrival, not after queued work completes.
      // Pi normally sends complete paste packets; retaining the tail also
      // prevents split delimiters from exposing their payload as commands.
      const probe = pasteTail + data;
      const start = probe.lastIndexOf("\x1b[200~"), end = probe.lastIndexOf("\x1b[201~");
      const paste = inPaste || start >= 0;
      if (start >= 0 || end >= 0) inPaste = start > end;
      pasteTail = probe.slice(-5);
      controller.enqueue(async () => {
        if (state.mode === "edit") {
          bindEditor();
          if (!paste && matchesKey(data, Key.ctrl("c"))) await controller.handle({ type: "key", key: "quit" });
          else if (!paste && matchesKey(data, Key.escape)) await controller.handle({ type: "key", key: "escape" });
          else if (!paste && matchesKey(data, Key.ctrl("s"))) { syncText(); await controller.handle({ type: "key", key: "save" }); }
          else {
            if (!paste && matchesKey(data, Key.enter)) editor.insertTextAtCursor("\n");
            else editor.handleInput(data);
            syncText();
          }
        } else if (!paste) {
          const event = keyEvent(data);
          if (event) await controller.handle(event);
        }
      });
    },
    handleMouse(event) {
      if (event.type === "move") {
        controller.point(event.x + 1, event.y + 1);
        return { handled: true, render: false };
      }
      if (event.type === "click") return { handled: true, render: false };
      if (state.mode === "edit" && editorBounds && event.x >= editorBounds.x - 1 && event.x < editorBounds.x - 1 + editorBounds.width &&
          event.y >= editorBounds.y - 1 && event.y < editorBounds.y - 1 + editorBounds.height) {
        const bounds = editorBounds, rowOffset = editorRowOffset, fullHeight = editorFullHeight;
        controller.enqueue(() => {
          bindEditor();
          editor.handleMouse({ ...event, x: event.x - bounds.x + 1, y: event.y - bounds.y + 1 + rowOffset, width: bounds.width, height: fullHeight });
        });
        return { handled: true, focus: true, render: false };
      }
      if (event.type !== "wheel" && (event.type !== "press" || event.button !== "left")) return undefined;
      const input = controller.capture({ type: "mouse", down: true,
        button: event.type === "wheel" ? ((event.wheelDelta || 0) < 0 ? 64 : 65) : 0,
        x: event.x + 1, y: event.y + 1,
      });
      controller.enqueue(() => {
        if (state.mode === "edit" && input.hit?.type === "editorSave") syncText();
        return controller.handle(input);
      });
      return { handled: true, focus: true, render: false };
    },
    invalidate() { editor.invalidate(); },
    dispose() { controller.stop(); },
  };
}

/** Same private drafts/feedback as Herdr, but no child process or window. */
export async function openPiReview(ctx, { dir, isCurrent, registerClose }, dependencies = {}) {
  let controller, finish, closeRequested = false, requestRender = () => {}, getRows = () => 24;
  const close = () => { closeRequested = true; controller?.stop(); };
  registerClose(close);
  try {
    // Lazy import keeps the standalone Node reviewer independent of Pi packages.
    const toolkit = await (dependencies.loadToolkit || (() => import("@earendil-works/pi-tui")))();
    if (closeRequested || !isCurrent()) return;
    const connection = JSON.parse(await readFile(path.join(dir, "connection.json"), "utf8"));
    controller = await createReviewController({
      connection, dir, onChange: () => requestRender(), onClose: () => finish?.(), rows: () => getRows(),
      loadSnapshot: dependencies.loadSnapshot, send: dependencies.send,
    });
    if (closeRequested || !isCurrent()) return;
    await ctx.ui.custom((tui, theme, keybindings, done) => {
      let finished = false;
      finish = () => { if (!finished) { finished = true; done(undefined); } };
      getRows = () => tui.terminal.rows;
      requestRender = () => tui.requestRender();
      const component = createPiReviewComponent({ controller, tui, theme, keybindings, toolkit });
      void controller.start();
      return component;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
  } finally {
    controller?.stop();
    registerClose(undefined);
  }
}
