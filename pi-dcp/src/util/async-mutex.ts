export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;

  get isLocked(): boolean { return this.locked; }

  async runExclusive<T>(task: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    this.locked = true;
    try { return await task(); }
    finally { this.locked = false; release(); }
  }
}
