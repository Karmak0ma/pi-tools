import test from "node:test";
import assert from "node:assert/strict";
import { registerReview } from "../src/index.mjs";

function harness(overrides = {}) {
  const handlers = new Map(), shortcuts = new Map(), events = new Map(), calls = [], messages = [], notices = [];
  let sessionId = "first", closed = 0, bridgeArgs, paneCount = 1;
  const bridges = [];
  let tabCount = 1, callerTab = 'w1:t1';
  const paneTabs = new Map();
  const pi = {
    registerCommand: (name, spec) => handlers.set(name, spec.handler),
    registerShortcut: (name, spec) => shortcuts.set(name, spec.handler),
    on: (name, handler) => events.set(name, handler),
    sendUserMessage: (...args) => messages.push(args),
  };
  registerReview(pi, {
    env: { HERDR_ENV: "1" },
    repositoryRoot: async () => "/repo",
    resolveComparison: async () => ({}),
    createBridge: async (args) => { bridgeArgs = args; bridges.push(args); return { dir: `/private/review-${bridges.length}`, close: async () => { closed++; } }; },
    herdr: async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "current") return { pane: { pane_id: "w1:p1", tab_id: callerTab, workspace_id: "w1" } };
      if (args[0] === "pane" && args[1] === "move") {
        const tab = args.includes('--new-tab') ? `w1:t${++tabCount}` : args[args.indexOf('--tab') + 1];
        if (args[2] === 'w1:p1') callerTab = tab;
        else paneTabs.set(args[2], tab);
        return { move_result: { pane: { pane_id: args[2], tab_id: tab } } };
      }
      if (args[2] === "open") {
        const id = `w1:p${++paneCount}`;
        paneTabs.set(id, callerTab);
        return { plugin_pane: { pane: { pane_id: id, tab_id: callerTab } } };
      }
      if (args[2] === 'focus') return { plugin_pane: { pane: { pane_id: args[3], tab_id: paneTabs.get(args[3]) } } };
      return {};
    },
    ...overrides,
  });
  const ctx = { mode: "tui", hasUI: true, cwd: "/repo/subdir", sessionManager: { getSessionId: () => sessionId }, ui: { notify: (...args) => notices.push(args) } };
  return { ctx, calls, messages, notices, events, shortcuts, bridges, open: (args = "") => handlers.get("review")(args, ctx), switch: () => { sessionId = "second"; }, get closed() { return closed; }, get bridgeArgs() { return bridgeArgs; } };
}

test("command and shortcut reuse the review pane; feedback uses follow-up with no template expansion", async () => {
  const h = harness();
  await Promise.all([h.open(), h.open()]);
  assert.equal(h.calls.filter((args) => args[2] === "open").length, 1);
  const open = h.calls.find((args) => args[2] === "open");
  assert.equal(open[open.indexOf("--placement") + 1], "split");
  assert.deepEqual(h.calls.slice(0, 2), [["pane", "current", "--current"], ["pane", "move", "w1:p1", "--new-tab", "--no-focus"]]);
  assert.deepEqual(h.calls.at(-2), ["tab", "rename", "w1:t2", "Review"]);
  assert.deepEqual(h.calls.at(-1), ["tab", "focus", "w1:t2"]);
  assert.equal(open[open.indexOf("--target-pane") + 1], "w1:p1");
  assert.equal(open[open.indexOf("--direction") + 1], "right");
  assert.equal(open.includes("--focus"), true);
  assert.equal(open[open.indexOf("--cwd") + 1], "/repo");
  await h.shortcuts.get("alt+r")(h.ctx);
  assert.ok(h.calls.some((args) => args[2] === "focus" && args[3] === "w1:p2"));
  h.bridgeArgs.deliver("feedback");
  assert.deepEqual(h.messages, [["feedback", { deliverAs: "followUp", expandPromptTemplates: false }]]);
  assert.equal(h.bridgeArgs.isCurrent(), true);
  h.switch();
  assert.equal(h.bridgeArgs.isCurrent(), false);
  await h.events.get("session_shutdown")();
  assert.equal(h.closed, 1);
});

test("shutdown while Git lookup is pending cannot open a stale review", async () => {
  let finish;
  const h = harness({ repositoryRoot: () => new Promise((resolve) => { finish = resolve; }) });
  const opening = h.open();
  await Promise.resolve(); // Let the serialized request enter the Git lookup.
  await h.events.get("session_shutdown")();
  finish("/repo"); await opening;
  assert.equal(h.calls.length, 0);
});

test('shutdown during a caller move does not continue opening a reviewer', async () => {
  let finishMove, started;
  const moving = new Promise((resolve) => { started = resolve; });
  const commands = [];
  const h = harness({ herdr: async (args) => {
    commands.push(args);
    if (args[1] === 'current') return { pane: { pane_id: 'agent' } };
    if (args[1] === 'move') { started(); return new Promise((resolve) => { finishMove = resolve; }); }
    throw new Error('Unexpected command');
  } });
  const opening = h.open();
  await moving;
  await h.events.get('session_shutdown')();
  finishMove({ move_result: { pane: { pane_id: 'agent', tab_id: 'new-tab' } } });
  await opening;
  assert.equal(commands.length, 2);
  assert.equal(h.notices.length, 0);
});

test('shutdown during plugin startup closes only the newly created review pane', async () => {
  let finishOpen, started;
  const launching = new Promise((resolve) => { started = resolve; });
  const commands = [];
  const h = harness({ herdr: async (args) => {
    commands.push(args);
    if (args[1] === 'current') return { pane: { pane_id: 'agent' } };
    if (args[1] === 'move') return { move_result: { pane: { pane_id: 'agent', tab_id: 'new-tab' } } };
    if (args[2] === 'open') { started(); return new Promise((resolve) => { finishOpen = resolve; }); }
    if (args[1] === 'close') return {};
    throw new Error('Unexpected command');
  } });
  const opening = h.open();
  await launching;
  await h.events.get('session_shutdown')();
  finishOpen({ plugin_pane: { pane: { pane_id: 'owned-review', tab_id: 'new-tab' } } });
  await opening;
  assert.deepEqual(commands.at(-1), ['pane', 'close', 'owned-review']);
  assert.equal(h.notices.length, 0);
});

test("comparisons have separate panes/drafts and reopening reuses the matching scope", async () => {
  const h = harness();
  await Promise.all([h.open(), h.open(' develop...HEAD ')]);
  assert.equal(h.bridges.length, 2);
  assert.deepEqual(h.bridges.map((b) => b.comparison), ['', 'develop...HEAD']);
  assert.equal(h.closed, 0);
  await h.open('develop...HEAD');
  assert.equal(h.bridges.length, 2);
  assert.deepEqual(h.calls.at(-3), ['tab', 'rename', 'w1:t3', 'Review develop...HEAD']);
  assert.deepEqual(h.calls.at(-2), ['plugin', 'pane', 'focus', 'w1:p3']);
  assert.deepEqual(h.calls.at(-1), ['tab', 'focus', 'w1:t3']);
  const before = h.calls.length;
  await h.open();
  assert.deepEqual(h.calls.slice(before).filter((args) => args[1] === 'move'), [
    ['pane', 'move', 'w1:p1', '--new-tab', '--no-focus'],
    ['pane', 'move', 'w1:p2', '--tab', 'w1:t4', '--split', 'right', '--target-pane', 'w1:p1', '--ratio', '0.5', '--no-focus'],
  ]);
  assert.deepEqual(h.calls.at(-1), ['tab', 'focus', 'w1:t4']);
  await h.open('develop..HEAD');
  assert.equal(h.bridges.length, 3);
  assert.ok(h.bridges.every((b) => b.isCurrent()));
  await h.events.get('session_shutdown')();
  assert.equal(h.closed, 3);
  assert.ok(h.bridges.every((b) => !b.isCurrent()));
});

test("invalid comparisons leave existing reviews and drafts available", async () => {
  const h = harness({ resolveComparison: async () => { throw new Error('Cannot resolve revision missing'); } });
  await h.open();
  await h.open('--stat');
  assert.match(h.notices.at(-1)[0], /Usage/);
  await h.open('missing...HEAD');
  assert.match(h.notices.at(-1)[0], /Cannot resolve/);
  assert.equal(h.bridges.length, 1);
  assert.equal(h.closed, 0);
  assert.equal(h.calls.filter((args) => args[2] === 'open').length, 1);
  assert.equal(h.bridges[0].isCurrent(), true);
});

test("shutdown also cancels queued comparison requests before they start", async () => {
  const h = harness();
  const requests = [h.open(), h.open('develop...HEAD')];
  await h.events.get('session_shutdown')();
  await Promise.all(requests);
  assert.equal(h.calls.length, 0);
  assert.equal(h.bridges.length, 0);
});

test("outside Herdr opens inside Pi, reuses drafts, and closes on session shutdown", async () => {
  const screens = [];
  const h = harness({ env: {}, openPiReview: async (_ctx, options) => { screens.push(options); } });
  await h.open('develop...HEAD');
  await h.open('develop...HEAD');
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 0);
  assert.equal(h.bridges.length, 1);
  assert.equal(screens.length, 2);
  assert.equal(screens[0].dir, screens[1].dir);
  let closedUI = 0;
  screens[1].registerClose(() => { closedUI++; });
  await h.events.get('session_shutdown')();
  assert.equal(closedUI, 1);
  assert.equal(h.closed, 1);
  assert.equal(screens[1].isCurrent(), false);
});

test("RPC clients do not attempt custom terminal components", async () => {
  const h = harness({ env: {} });
  h.ctx.mode = 'rpc';
  await h.open();
  assert.equal(h.calls.length, 0);
  assert.equal(h.bridges.length, 0);
  assert.match(h.notices[0][0], /interactive terminal mode/);
});
