import { describe, expect, it } from "vitest";
import { SubagentTuiManager } from "./tui.js";
import { SubagentTracker, createInstance } from "./tracker.js";

function createFakeTui() {
  const inputListeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  let renderRequests = 0;
  const tui = {
    mode: "fullscreen",
    inputListeners,
    terminal: { rows: 24, columns: 80 },
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },
    requestRender: () => {
      renderRequests++;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
  return tui;
}

describe("SubagentTuiManager page navigation routing", () => {
  it("routes PgUp/PgDn ahead of the fullscreen host viewport listener", async () => {
    const tracker = new SubagentTracker();
    tracker.add(
      createInstance({
        id: "subagent-1",
        agent: "worker",
        source: "builtin",
        task: "test",
        cwd: "/tmp",
      }),
    );

    const tui = createFakeTui();
    let hostConsumed = false;
    tui.inputListeners.add(() => {
      hostConsumed = true;
      return { consume: true };
    });

    const manager = new SubagentTuiManager(tracker);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    await manager.enter({
      ui: {
        custom: async (factory: any, options: any) => {
          const component = factory(tui, {}, undefined, finish);
          options.onHandle({ isFocused: () => true });

          const listeners = [...tui.inputListeners];
          expect(listeners).toHaveLength(2);

          const pageUpResult = listeners[0]("\x1b[5~");
          const pageDownResult = listeners[0]("\x1b[6~");
          expect(pageUpResult).toEqual({ consume: true });
          expect(pageDownResult).toEqual({ consume: true });
          expect(listeners[0]("\x1b[57421;1:3u")).toEqual({ consume: true });
          expect(tui.renderRequests).toBe(2);
          expect(hostConsumed).toBe(false);
          expect(component).toBeDefined();

          finish();
          await finished;
        },
      },
    });

    expect(manager.isActive).toBe(false);
  });
});

describe("SubagentTuiManager overlay teardown", () => {
  it("removes its own overlay entry and blocks pi's topmost-overlay pop", async () => {
    const tracker = new SubagentTracker();
    tracker.add(
      createInstance({
        id: "subagent-teardown",
        agent: "worker",
        source: "builtin",
        task: "test overlay teardown",
        cwd: "/tmp",
      }),
    );

    // Pi keeps `hideOverlay` on the TUI prototype. Mirror that so the test also
    // proves the working method is restored afterwards.
    const base = createFakeTui();
    let blindPops = 0;
    const prototype = { hideOverlay: () => { blindPops++; } };
    const tui = Object.assign(Object.create(prototype), base) as typeof base & { hideOverlay: () => void };

    let hideCalls = 0;
    const handle = { isFocused: () => true, hide: () => { hideCalls++; } };

    const manager = new SubagentTuiManager(tracker);
    let popsDuringDone = -1;
    let hideCallsDuringDone = -1;

    await manager.enter({
      ui: {
        custom: async (factory: any, options: any) => {
          // Pi's own close(): it pops whatever overlay is currently on top.
          const done = () => {
            hideCallsDuringDone = hideCalls;
            tui.hideOverlay();
            popsDuringDone = blindPops;
          };
          factory(tui, {}, undefined, done);
          options.onHandle(handle);
          manager.exit();
        },
      },
    });

    // Our own entry is removed through our own handle, before pi's close runs.
    expect(hideCallsDuringDone).toBe(1);
    // Pi's blind pop is neutralised, so no foreign overlay is destroyed.
    expect(popsDuringDone).toBe(0);
    // The stub is gone again, so later pops behave normally. The restored value
    // is written back as an own property on purpose: see overlay-close.ts, a
    // `delete` cannot pass through pi's Proxy and would strand the stub.
    tui.hideOverlay();
    expect(blindPops).toBe(1);
    expect(manager.isActive).toBe(false);
  });

  // Regression test for a total session freeze.
  //
  // Pi does not hand extensions the TUI itself. It hands a Proxy wrapped around
  // an EMPTY object, which forwards `get`, `set`, `has` and `getPrototypeOf` and
  // traps nothing else. The earlier teardown restored its stub with `delete`,
  // which the Proxy does not forward, so the real TUI kept a no-op
  // `hideOverlay`. Pi's exit path then spun forever in
  // `while (renderer.hasOverlayEntries) renderer.hideOverlay()`, which killed
  // the whole session: no repaint, no keys, not even SIGTERM.
  it("leaves a working hideOverlay on the real TUI behind pi's Proxy", async () => {
    const tracker = new SubagentTracker();
    tracker.add(
      createInstance({
        id: "subagent-teardown-proxy",
        agent: "worker",
        source: "builtin",
        task: "test overlay teardown through pi's proxy",
        cwd: "/tmp",
      }),
    );

    const base = createFakeTui();
    let blindPops = 0;
    const prototype = { hideOverlay: () => { blindPops++; } };
    const realTui = Object.assign(Object.create(prototype), base) as typeof base & { hideOverlay: () => void };

    // Same shape as pi's `createInteractiveTuiReference`: a Proxy over `{}`.
    const proxyTui = new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, property) => Reflect.get(realTui, property, realTui),
      set: (_target, property, value) => Reflect.set(realTui, property, value, realTui),
      has: (_target, property) => Reflect.has(realTui, property),
      getPrototypeOf: () => Reflect.getPrototypeOf(realTui),
    }) as unknown as typeof realTui;

    const handle = { isFocused: () => true, hide: () => {} };
    const manager = new SubagentTuiManager(tracker);
    let popsDuringDone = -1;

    await manager.enter({
      ui: {
        custom: async (factory: any, options: any) => {
          const done = () => {
            proxyTui.hideOverlay();
            popsDuringDone = blindPops;
          };
          factory(proxyTui, {}, undefined, done);
          options.onHandle(handle);
          manager.exit();
        },
      },
    });

    // The stub still protected foreign overlays during pi's close().
    expect(popsDuringDone).toBe(0);
    // And the real TUI can pop again, so pi's exit loop terminates.
    realTui.hideOverlay();
    expect(blindPops).toBe(1);
  });

  it("still closes when the host gives no usable overlay handle", async () => {
    const tracker = new SubagentTracker();
    tracker.add(
      createInstance({
        id: "subagent-teardown-fallback",
        agent: "worker",
        source: "builtin",
        task: "test overlay teardown fallback",
        cwd: "/tmp",
      }),
    );

    const tui = createFakeTui();
    const manager = new SubagentTuiManager(tracker);
    let doneCalls = 0;

    await manager.enter({
      ui: {
        custom: async (factory: any, options: any) => {
          factory(tui, {}, undefined, () => { doneCalls++; });
          // No `hide` method: an older or partial host handle.
          options.onHandle({ isFocused: () => true });
          manager.exit();
        },
      },
    });

    expect(doneCalls).toBe(1);
    expect(manager.isActive).toBe(false);
  });
});

describe("SubagentTuiManager displacement by a foreign overlay", () => {
  async function runDisplacementCase(options: { overlayFocused: boolean }) {
    const tracker = new SubagentTracker();
    tracker.add(
      createInstance({
        id: "subagent-displaced",
        agent: "worker",
        source: "builtin",
        task: "test displacement",
        cwd: "/tmp",
      }),
    );

    const tui = Object.assign(createFakeTui(), {
      hideOverlay: () => {},
      // True only when the focused component is itself a visible overlay.
      isOverlayFocused: () => options.overlayFocused,
    });
    // The inspector overlay is no longer the focus owner in either case.
    const handle = { isFocused: () => false, hide: () => {} };

    const manager = new SubagentTuiManager(tracker);
    // `enter()` always clears the active flag once the custom UI promise
    // settles, so sample the state inside the custom callback instead.
    let stillActiveAfterRenderTick = false;
    await manager.enter({
      ui: {
        custom: async (factory: any, opts: any) => {
          const component = factory(tui, {}, undefined, () => {});
          opts.onHandle(handle);
          // One render tick, exactly as the host would drive it.
          expect(component.render(80)).toEqual([]);
          // The close is deferred past the render pass, so it is still open here.
          expect(manager.isActive).toBe(true);
          // Let the deferred close run.
          await Promise.resolve();
          stillActiveAfterRenderTick = manager.isActive;
          if (stillActiveAfterRenderTick) manager.exit();
        },
      },
    });
    return stillActiveAfterRenderTick;
  }

  it("closes itself when a dialog overlay takes keyboard focus", async () => {
    expect(await runDisplacementCase({ overlayFocused: true })).toBe(false);
  });

  it("stays open for a non-overlay dialog that borrows focus", async () => {
    // The child extension UI presenter opens a dialog in place of the editor.
    // It is not an overlay, so the inspector must keep its slot and its state.
    expect(await runDisplacementCase({ overlayFocused: false })).toBe(true);
  });
});

describe("SubagentTuiManager inspector focus preparation", () => {
  it("focuses an unfocused visible inspector and restores its previous focus state", async () => {
    const tracker = new SubagentTracker();
    tracker.add(
      createInstance({
        id: "subagent-focus",
        agent: "worker",
        source: "builtin",
        task: "test focus recovery",
        cwd: "/tmp",
      }),
    );

    const tui = createFakeTui();
    let focused = false;
    let focusCalls = 0;
    let unfocusCalls = 0;
    const handle = {
      isFocused: () => focused,
      isHidden: () => false,
      focus: () => {
        focusCalls++;
        focused = true;
      },
      unfocus: () => {
        unfocusCalls++;
        focused = false;
      },
    };
    const manager = new SubagentTuiManager(tracker);
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });

    await manager.enter({
      ui: {
        custom: async (factory: any, options: any) => {
          factory(tui, {}, undefined, close);
          options.onHandle(handle);

          expect(manager.isOverlayFocusedVisible).toBe(false);
          const restore = manager.focusInspectorOverlayForDialog();
          expect(manager.isOverlayFocusedVisible).toBe(true);
          expect(focusCalls).toBe(1);

          restore?.();
          expect(focused).toBe(false);
          expect(unfocusCalls).toBe(1);

          close();
          await closed;
        },
      },
    });

    expect(manager.isActive).toBe(false);
  });
});
