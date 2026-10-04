import { describe, expect, test } from 'bun:test';
import { ExclusiveLifecycle } from '../../deploy/runtime/lifecycle';

describe('exclusive container lifecycle', () => {
  test('waits for the HTTP owner to exit before jobs and serializes simultaneous jobs', async () => {
    const events: string[] = [];
    let release!: () => void;
    const exited = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    const runtime = new ExclusiveLifecycle(async () => {
      const id = ++starts;
      events.push(`start${id}`);
      return { stop: async () => {
        events.push(`stop${id}`);
        if (id === 1) await exited;
        events.push(`exit${id}`);
      } };
    });
    await runtime.start();
    const a = runtime.run(async () => { events.push('jobA'); });
    const b = runtime.run(async () => { events.push('jobB'); });
    await Bun.sleep(5);
    expect(events).toEqual(['start1', 'stop1']);
    release();
    await Promise.all([a, b]);
    await runtime.close();
    expect(events).toEqual(['start1', 'stop1', 'exit1', 'jobA', 'start2', 'stop2', 'exit2', 'jobB', 'start3', 'stop3', 'exit3']);
  });

  test('restarts HTTP after failed ingestion and accepts a later job', async () => {
    let running = false;
    const runtime = new ExclusiveLifecycle(async () => {
      expect(running).toBe(false);
      running = true;
      return { stop: async () => { running = false; } };
    });
    await runtime.start();
    await expect(runtime.run(async () => { expect(running).toBe(false); throw new Error('fixture'); })).rejects.toThrow('fixture');
    expect(running).toBe(true);
    await runtime.run(async () => { expect(running).toBe(false); });
    await runtime.close();
    expect(running).toBe(false);
  });

  test('refuses a job if HTTP termination cannot be established', async () => {
    let jobRan = false;
    const runtime = new ExclusiveLifecycle(async () => ({ stop: async () => { throw new Error('stop failed'); } }));
    await runtime.start();
    await expect(runtime.run(async () => { jobRan = true; })).rejects.toThrow('stop failed');
    expect(jobRan).toBe(false);
    await expect(runtime.close()).rejects.toThrow('stop failed');
  });

  test('shutdown drains the current job and cancels queued work without restarting HTTP', async () => {
    let release!: () => void;
    const drain = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    let queued = false;
    const runtime = new ExclusiveLifecycle(async () => {
      starts++;
      return { stop: async () => {} };
    });
    await runtime.start();
    const job = runtime.run(async () => { await drain; });
    await Bun.sleep(5);
    const queue = runtime.run(async () => { queued = true; });
    const closing = runtime.close();
    const rejected = queue.catch(error => error as Error);
    release();
    await Promise.all([job, closing]);
    expect(String(await rejected)).toContain('shutting down');
    expect(starts).toBe(1);
    expect(queued).toBe(false);
  });
});
