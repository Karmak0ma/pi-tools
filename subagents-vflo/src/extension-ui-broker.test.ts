import { describe, expect, it, vi } from "vitest";
import { ChildExtensionUIBroker, type ChildUIDialogPresenter, type QueuedChildUIRequest } from "./extension-ui-broker.js";
import { type ChildExtensionUIDialogRequest, type ChildExtensionUIResponse } from "./rpc-extension-ui.js";
import type { ChildExtensionUIChannel } from "./runner.js";

function request(id: string, title = id): ChildExtensionUIDialogRequest {
  return { type: "extension_ui_request", id, method: "select", title, options: ["Allow once", "Deny"] };
}

function channel(deadline?: number) {
  const writes: ChildExtensionUIResponse[] = [];
  const forgotten: string[] = [];
  const pending = new Set<string>();
  return {
    writes,
    forgotten,
    observe(id: string) { pending.add(id); },
    channel: {
      respond(response: ChildExtensionUIResponse) {
        if (!pending.has(response.id)) return false;
        pending.delete(response.id);
        writes.push(response);
        return true;
      },
      forget(id: string) { pending.delete(id); forgotten.push(id); },
      isOpen() { return true; },
      getDeadline() { return deadline; },
    } satisfies ChildExtensionUIChannel,
  };
}

function owner(instanceId: string) {
  return { instanceId, agent: `agent-${instanceId}`, task: "task text", cwd: "/tmp" };
}

function selectPresenter(decision: "allow" | "deny" = "deny") {
  const calls: QueuedChildUIRequest[] = [];
  const presenter: ChildUIDialogPresenter = {
    async present(item) {
      calls.push(item);
      return { kind: "value", value: decision === "allow" ? "Allow once" : "Deny" };
    },
  };
  return { presenter, calls };
}

describe("ChildExtensionUIBroker", () => {
  it("presents one request immediately and maps the exact option", async () => {
    const child = channel();
    child.observe("one");
    const { presenter, calls } = selectPresenter("allow");
    const broker = new ChildExtensionUIBroker();
    expect(broker.enqueue({ owner: owner("a"), request: request("one"), channel: child.channel, presenter })).toBe(true);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(child.writes).toEqual([{ type: "extension_ui_response", id: "one", value: "Allow once" }]);
  });

  it("serializes different owners in global FIFO order", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const presenter: ChildUIDialogPresenter = {
      async present(item) {
        order.push(item.owner.instanceId);
        if (item.request.id === "one") await first;
        return { kind: "value", value: "Deny" };
      },
    };
    const a = channel(); a.observe("one");
    const b = channel(); b.observe("two");
    const broker = new ChildExtensionUIBroker();
    broker.enqueue({ owner: owner("a"), request: request("one"), channel: a.channel, presenter });
    broker.enqueue({ owner: owner("b"), request: request("two"), channel: b.channel, presenter });
    await Promise.resolve();
    expect(order).toEqual(["a"]);
    releaseFirst();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(order).toEqual(["a", "b"]);
    expect(b.writes[0]).toMatchObject({ id: "two", value: "Deny" });
  });

  it("cancels only the owner being aborted and aborts its active presenter", async () => {
    const aborted = vi.fn();
    const presenter: ChildUIDialogPresenter = {
      present(item, signal) {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted(item.owner.instanceId);
            resolve({ kind: "cancelled" });
          });
        });
      },
    };
    const a = channel(); a.observe("one");
    const b = channel(); b.observe("two");
    const broker = new ChildExtensionUIBroker();
    broker.enqueue({ owner: owner("a"), request: request("one"), channel: a.channel, presenter });
    broker.enqueue({ owner: owner("b"), request: request("two"), channel: b.channel, presenter });
    await Promise.resolve();
    broker.cancelOwner("a", "abort");
    await Promise.resolve();
    await Promise.resolve();
    expect(aborted).toHaveBeenCalledWith("a");
    expect(a.writes).toEqual([{ type: "extension_ui_response", id: "one", cancelled: true }]);
    expect(b.writes).toEqual([]);
    broker.cancelOwner("b", "abort");
  });

  it("expires a queued request without writing a response", async () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const first = channel(); first.observe("one");
    const second = channel(50); second.observe("two");
    let release!: () => void;
    const presenter: ChildUIDialogPresenter = {
      async present(item) {
        if (item.request.id === "one") await new Promise<void>((resolve) => { release = resolve; });
        return { kind: "value", value: "Deny" };
      },
    };
    const broker = new ChildExtensionUIBroker({
      now: () => now,
      setTimer: (callback) => { timers.push(callback); return timers.length as any; },
      clearTimer: () => {},
    });
    broker.enqueue({ owner: owner("a"), request: request("one"), channel: first.channel, presenter, receivedAt: 0 });
    broker.enqueue({ owner: owner("b"), request: request("two"), channel: second.channel, presenter, receivedAt: 0 });
    await Promise.resolve();
    now = 100;
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(second.writes).toEqual([]);
    expect(second.forgotten).toEqual(["two"]);
  });
});
