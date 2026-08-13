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
