/** Exclusive process handoff: a job never starts before the HTTP owner exits. */
export interface RuntimeChild {
  stop(): Promise<void>;
}

export class ExclusiveLifecycle {
  private server: RuntimeChild | undefined;
  private job: RuntimeChild | undefined;
  private cleanup: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private uncertain = false;

  get ownershipUncertain() { return this.uncertain; }

  constructor(private readonly startServer: () => Promise<RuntimeChild>) {}

  async runChild(child: RuntimeChild & { exited: Promise<number> }): Promise<number> {
    if (this.job || this.server || this.closing) throw new Error('Runtime cannot accept an ingestion owner');
    this.job = child;
    try { return await child.exited; }
    finally { await this.stopJob(); }
  }

  stopJob(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    const child = this.job;
    if (!child) return Promise.resolve();
    this.cleanup = (async () => {
      try {
        await Promise.resolve().then(() => child.stop());
        this.job = undefined;
        this.uncertain = false;
      } catch (error) {
        this.uncertain = true;
        throw error;
      } finally {
        this.cleanup = undefined;
      }
    })();
    return this.cleanup;
  }

  async start() {
    await this.stopJob();
    if (!this.closing && !this.server) this.server = await this.startServer();
  }

  run(job: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      if (this.closing) throw new Error('Runtime is shutting down');
      // Retry any retained cleanup before admitting another writer.
      await this.stopJob();
      if (this.server) {
        // Keep the reference on stop failure: shutdown still owns this child.
        await this.server.stop();
        this.server = undefined;
      }
      try {
        await job();
      } finally {
        // A nonzero exit is recoverable only after termination is established.
        // stopJob retains ownership on failure and prevents the restart below.
        await this.stopJob();
        if (!this.closing) this.server = await this.startServer();
      }
    });
    this.tail = next.catch(() => {});
    return next;
  }

  async close() {
    this.closing = true;
    // Interrupt active ingestion before waiting on its exit-driven tail.
    await this.stopJob();
    await this.tail;
    await this.stopJob();
    if (this.server) await this.server.stop();
    this.server = undefined;
  }
}
