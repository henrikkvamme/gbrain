/** Exclusive process handoff: a job never starts before the HTTP owner exits. */
export interface RuntimeChild {
  stop(): Promise<void>;
}

export class ExclusiveLifecycle {
  private server: RuntimeChild | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly startServer: () => Promise<RuntimeChild>) {}

  async start() {
    if (!this.closing) this.server = await this.startServer();
  }

  run(job: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      if (this.closing) throw new Error('Runtime is shutting down');
      if (this.server) {
        // Keep the reference on stop failure: shutdown still owns this child.
        await this.server.stop();
        this.server = undefined;
      }
      try {
        await job();
      } finally {
        if (!this.closing) this.server = await this.startServer();
      }
    });
    this.tail = next.catch(() => {});
    return next;
  }

  async close() {
    this.closing = true;
    await this.tail;
    if (this.server) await this.server.stop();
    this.server = undefined;
  }
}
