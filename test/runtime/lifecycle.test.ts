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

  test('retains an exited ingestion parent when descendant drain fails and retries cleanup', async () => {
    let starts = 0;
    let stops = 0;
    let drained = false;
    let laterRan = false;
    const runtime = new ExclusiveLifecycle(async () => {
      starts++;
      return { stop: async () => {} };
    });
    const child = {
      exited: Promise.resolve(0),
      stop: async () => {
        stops++;
        if (!drained) throw new Error('descendants did not drain');
      },
    };
    await runtime.start();
    await expect(runtime.run(async () => { await runtime.runChild(child); })).rejects.toThrow('descendants did not drain');
    expect(starts).toBe(1);
    expect(runtime.ownershipUncertain).toBe(true);
    await expect(runtime.run(async () => { laterRan = true; })).rejects.toThrow('descendants did not drain');
    expect(laterRan).toBe(false);
    expect(starts).toBe(1);
    const beforeClose = stops;
    await expect(runtime.close()).rejects.toThrow('descendants did not drain');
    expect(stops).toBeGreaterThan(beforeClose);
    drained = true;
    await runtime.close();
    expect(runtime.ownershipUncertain).toBe(false);
    expect(stops).toBeGreaterThan(beforeClose + 1);
    expect(starts).toBe(1);
  });

  test('restarts HTTP after nonzero ingestion exit with verified descendant drain', async () => {
    const events: string[] = [];
    const runtime = new ExclusiveLifecycle(async () => {
      events.push('http');
      return { stop: async () => { events.push('http-stop'); } };
    });
    await runtime.start();
    await expect(runtime.run(async () => {
      const rc = await runtime.runChild({ exited: Promise.resolve(1), stop: async () => { events.push('drained'); } });
      if (rc !== 0) throw new Error('ingestion failed');
    })).rejects.toThrow('ingestion failed');
    expect(events).toEqual(['http', 'http-stop', 'drained', 'http']);
    await runtime.close();
  });

  test('shutdown can retry cleanup while the ingestion parent is still running', async () => {
    let release!: (rc: number) => void;
    let attempts = 0;
    let starts = 0;
    const exited = new Promise<number>(resolve => { release = resolve; });
    const runtime = new ExclusiveLifecycle(async () => {
      starts++;
      return { stop: async () => {} };
    });
    await runtime.start();
    const run = runtime.run(async () => {
      await runtime.runChild({ exited, stop: async () => {
        if (++attempts === 1) throw new Error('inspection failed');
        release(0);
      } });
    });
    await Bun.sleep(5);
    await expect(runtime.close()).rejects.toThrow('inspection failed');
    await runtime.close();
    await run;
    expect(starts).toBe(1);
    expect(attempts).toBe(2);
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
