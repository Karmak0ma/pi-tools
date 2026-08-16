/**
 * Session-scoped broker for blocking child extension UI requests.
 *
 * The broker owns parent presentation and queue state. The runner's child-bound
 * channel owns wire state. Keeping those state machines separate is what makes
 * child exit, timeout, and user input races safe and testable.
 */

import {
  cancelledResponse,
  confirmResponse,
  localDeadline,
  type ActiveChildToolCall,
  type ChildExtensionUIDialogRequest,
  type ChildExtensionUIResponse,
} from "./rpc-extension-ui.js";
import type { ChildExtensionUIChannel } from "./runner.js";

export interface ChildUIRequestOwner {
  instanceId: string;
  agent: string;
  task: string;
  cwd: string;
}

export interface ChildUIDialogPresenter {
  present(
    item: QueuedChildUIRequest,
    signal: AbortSignal,
    queueDepth: number,
  ): Promise<ChildUIDialogDecision>;
}

export type ChildUIDialogDecision =
  | { kind: "value"; value: string }
  | { kind: "confirmed"; confirmed: boolean }
  | { kind: "cancelled"; reason?: string };

export interface QueuedChildUIRequest {
  key: string;
  owner: ChildUIRequestOwner;
  request: ChildExtensionUIDialogRequest;
  activeToolCalls: ActiveChildToolCall[];
  channel: ChildExtensionUIChannel;
  receivedAt: number;
  deadline?: number;
  presenter: ChildUIDialogPresenter;
  /** Additional FIFO items at presentation time; presenter-only metadata. */
  queueDepth?: number;
  state?: "queued" | "presenting" | "responded" | "cancelled" | "expired" | "orphaned";
}

export interface EnqueueChildUIRequestOptions {
  owner: ChildUIRequestOwner;
  request: ChildExtensionUIDialogRequest;
  activeToolCalls?: ActiveChildToolCall[];
  channel: ChildExtensionUIChannel;
  presenter: ChildUIDialogPresenter;
  receivedAt?: number;
}

export interface ChildExtensionUIBrokerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onDiagnostic?: (message: string, owner?: ChildUIRequestOwner) => void;
  onPendingCountChange?: (instanceId: string, count: number) => void;
}

type InternalItem = QueuedChildUIRequest & { sensitiveCleared: boolean };

function keyFor(owner: ChildUIRequestOwner, request: ChildExtensionUIDialogRequest): string {
  return `${owner.instanceId}:${request.id}`;
}

function normalizeDecision(
  request: ChildExtensionUIDialogRequest,
  decision: ChildUIDialogDecision,
): ChildExtensionUIResponse | null {
  if (decision.kind === "cancelled") return cancelledResponse(request.id);
  if (request.method === "select" || request.method === "input" || request.method === "editor") {
    return decision.kind === "value" ? selectOrTextResponse(request, decision.value) : null;
  }
  return decision.kind === "confirmed" ? confirmResponse(request.id, decision.confirmed) : null;
}

function selectOrTextResponse(
  request: ChildExtensionUIDialogRequest,
  value: string,
): ChildExtensionUIResponse {
  // The runner performs the final child-bound validation. Keeping this builder
  // method-specific makes the intended response shape obvious to callers.
  return { type: "extension_ui_response", id: request.id, value };
}

/** A small fake-friendly FIFO broker; no model or Pi process is needed to use it. */
export class ChildExtensionUIBroker {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onDiagnostic?: (message: string, owner?: ChildUIRequestOwner) => void;
  private readonly onPendingCountChange?: (instanceId: string, count: number) => void;

  private queue: InternalItem[] = [];
  private active: InternalItem | null = null;
  private activeAbort: AbortController | null = null;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private drainPromise: Promise<void> | null = null;
  private closed = false;
  private readonly pendingByKey = new Map<string, InternalItem>();
  private readonly settledKeys = new Set<string>();
  private readonly byOwner = new Map<string, Set<InternalItem>>();

  constructor(options: ChildExtensionUIBrokerOptions = {}) {
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
    this.onDiagnostic = options.onDiagnostic;
    this.onPendingCountChange = options.onPendingCountChange;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get queueDepth(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  get activeRequest(): QueuedChildUIRequest | null {
    return this.active;
  }

  get queuedRequests(): readonly QueuedChildUIRequest[] {
    return this.queue;
  }

  getOwnerPendingCount(instanceId: string): number {
    return this.byOwner.get(instanceId)?.size || 0;
  }

  /**
   * Enqueue using one options object. This is intentionally the only path to
   * presentation so every request gets an owner, a presenter, and a channel.
   */
  enqueue(options: EnqueueChildUIRequestOptions): boolean {
    const receivedAt = options.receivedAt ?? this.now();
    const key = keyFor(options.owner, options.request);
    if (this.closed) {
      this.diagnostic("Blocking extension UI request rejected after broker shutdown", options.owner);
      options.channel.respond(cancelledResponse(options.request.id));
      options.channel.forget(options.request.id);
      return false;
    }
    if (this.pendingByKey.has(key) || this.settledKeys.has(key)) {
      this.diagnostic(`Duplicate extension UI request ignored (${options.request.id})`, options.owner);
      return false;
    }

    const item: InternalItem = {
      key,
      owner: { ...options.owner },
      request: options.request,
      activeToolCalls: [...(options.activeToolCalls || [])].sort((a, b) => b.startedAt - a.startedAt),
      channel: options.channel,
      receivedAt,
      deadline: options.channel.getDeadline?.(options.request.id) ?? localDeadline(receivedAt, options.request.timeout),
      presenter: options.presenter,
      state: "queued",
      sensitiveCleared: false,
    };

    this.pendingByKey.set(key, item);
    let ownerItems = this.byOwner.get(item.owner.instanceId);
    if (!ownerItems) {
      ownerItems = new Set();
      this.byOwner.set(item.owner.instanceId, ownerItems);
    }
    ownerItems.add(item);
    this.notifyPendingCount(item.owner.instanceId);
    this.queue.push(item);

    if (item.deadline !== undefined) {
      const remaining = item.deadline - this.now();
      if (remaining <= 0) {
        this.expire(item);
        this.queue = this.queue.filter((queued) => queued !== item);
        return false;
      }
      const timer = this.setTimer(() => {
        this.expiryTimers.delete(item.key);
        if (this.isSettled(item)) return;
        this.expire(item);
        if (this.active === item) this.activeAbort?.abort();
        else this.queue = this.queue.filter((queued) => queued !== item);
      }, remaining);
      this.expiryTimers.set(item.key, timer);
    }

    this.startDrain();
    return true;
  }

  /**
   * Cancel all requests belonging to one child. Exit does not write because
   * the child is already gone; parent abort/shutdown attempts a cancellation
   * while the channel is still available.
   */
  cancelOwner(instanceId: string, reason: "exit" | "abort" | "shutdown"): void {
    const items = [...(this.byOwner.get(instanceId) || [])];
    for (const item of items) {
      const isActive = this.active === item;
      this.settle(item, reason === "exit" ? "orphaned" : "cancelled", reason === "exit" ? undefined : cancelledResponse(item.request.id));
      if (isActive) this.activeAbort?.abort();
    }
    this.queue = this.queue.filter((item) => !items.includes(item));
    this.startDrain();
  }

  /**
   * Make the broker reject stale callbacks, cancel outstanding child dialogs,
   * and wait only for parent modal cleanup. Process termination is deliberately
   * owned by SubagentTracker.killAll().
   */
  async dispose(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const items = [...this.pendingByKey.values()];
      for (const item of items) {
        const isActive = this.active === item;
        this.settle(item, "cancelled", cancelledResponse(item.request.id));
        if (isActive) this.activeAbort?.abort();
      }
      this.queue = [];
      this.startDrain();
    }
    await this.drainPromise;
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (!this.closed && this.queue.length > 0) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (this.isSettled(item)) continue;
      if (!item.channel.isOpen()) {
        this.settle(item, "orphaned");
        continue;
      }
      if (this.isExpired(item)) {
        this.expire(item);
        continue;
      }

      this.active = item;
      item.state = "presenting";
      const controller = new AbortController();
      this.activeAbort = controller;

      if (this.isSettled(item)) {
        this.active = null;
        this.activeAbort = null;
        this.clearSensitive(item);
        continue;
      }

      try {
        const decision = await item.presenter.present(item, controller.signal, this.queue.length);
        if (this.isSettled(item)) continue;
        if (this.isExpired(item)) {
          this.expire(item);
          continue;
        }
        const response = normalizeDecision(item.request, decision);
        if (!response) {
          this.diagnostic("Presenter returned an incompatible decision; cancelling request", item.owner);
          this.settle(item, "cancelled", cancelledResponse(item.request.id));
          continue;
        }
        this.settle(item, "cancelled" in response ? "cancelled" : "responded", response);
      } catch (error) {
        this.diagnostic(
          `Extension UI presenter failed: ${error instanceof Error ? error.message : String(error)}`,
          item.owner,
        );
        this.settle(item, "cancelled", cancelledResponse(item.request.id));
      } finally {
        this.activeAbort = null;
        this.active = null;
        this.clearSensitive(item);
      }
    }
  }

  private isExpired(item: InternalItem): boolean {
    return item.deadline !== undefined && this.now() >= item.deadline;
  }

  private expire(item: InternalItem): void {
    if (this.isSettled(item)) return;
    item.channel.forget(item.request.id);
    this.settle(item, "expired");
  }

  private isSettled(item: InternalItem): boolean {
    return this.settledKeys.has(item.key);
  }

  private settle(
    item: InternalItem,
    state: "responded" | "cancelled" | "expired" | "orphaned",
    response?: ChildExtensionUIResponse,
  ): void {
    if (this.settledKeys.has(item.key)) return;
    this.settledKeys.add(item.key);
    this.pendingByKey.delete(item.key);
    const expiryTimer = this.expiryTimers.get(item.key);
    if (expiryTimer !== undefined) {
      this.clearTimer(expiryTimer);
      this.expiryTimers.delete(item.key);
    }
    item.state = state;

    const ownerItems = this.byOwner.get(item.owner.instanceId);
    ownerItems?.delete(item);
    if (ownerItems && ownerItems.size === 0) this.byOwner.delete(item.owner.instanceId);
    this.notifyPendingCount(item.owner.instanceId);

    if (response) {
      const wrote = item.channel.respond(response);
      if (!wrote && state === "responded") {
        item.state = "orphaned";
        this.diagnostic("Extension UI response could not be written to child", item.owner);
      }
    }

    // Queued requests can release their sensitive snapshot immediately. An
    // active presenter is cleared after its promise returns in drain().
    if (this.active !== item) this.clearSensitive(item);
  }

  private clearSensitive(item: InternalItem): void {
    if (item.sensitiveCleared) return;
    item.sensitiveCleared = true;
    item.activeToolCalls.length = 0;
    // Keep the structural object inspectable for diagnostics, but erase fields
    // that can contain task text, commands, prefill text, or secrets.
    item.request = undefined as never;
    item.owner = undefined as never;
    item.presenter = undefined as never;
  }

  private notifyPendingCount(instanceId: string): void {
    this.onPendingCountChange?.(instanceId, this.getOwnerPendingCount(instanceId));
  }

  private diagnostic(message: string, owner?: ChildUIRequestOwner): void {
    this.onDiagnostic?.(message, owner);
  }
}

export function createCancelledDecision(reason?: string): ChildUIDialogDecision {
  return { kind: "cancelled", reason };
}
