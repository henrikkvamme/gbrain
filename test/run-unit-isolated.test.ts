import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { failed, runFiles, unitFiles } from '../scripts/run-unit-isolated.ts';

let scratch: string;
afterEach(() => {
  // Red runs must not leave their intentionally leaked fixture descendants alive.
  const pids = scratch && join(scratch, 'pids.json');
  if (pids && existsSync(pids)) {
    for (const pid of JSON.parse(readFileSync(pids, 'utf8'))) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, source: string): string {
  const file = join(scratch, `${name}.test.ts`);
  writeFileSync(file, source);
  return file;
}


function descendantFixture(mode: 'timeout' | 'fail' | 'pass'): string {
  const pids = join(scratch, 'pids.json');
  const worker = join(scratch, 'worker.ts');
  writeFileSync(worker, `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    const child = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdout: 'ignore', stderr: 'ignore',
    });
    child.unref();
    writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `);
  return fixture(mode, `
    import { existsSync } from 'node:fs';
    import { beforeAll, test, expect } from 'bun:test';
    beforeAll(async () => {
      const child = Bun.spawn([process.execPath, ${JSON.stringify(worker)}], { stdout: 'ignore', stderr: 'ignore' });
      child.unref();
      while (!existsSync(${JSON.stringify(pids)})) await Bun.sleep(10);
      ${mode === 'timeout' ? 'await new Promise(() => {});' : ''}
    });
    test('fixture', () => expect(true).toBe(${mode === 'fail' ? 'false' : 'true'}));
  `);
}

function descendantsGoneFixture(): string {
  return fixture('green-after-cleanup', `
    import { readFileSync } from 'node:fs';
    import { test, expect } from 'bun:test';
    // Check on module entry, before any test or setup for the next file begins.
    for (const pid of JSON.parse(readFileSync(${JSON.stringify(join(scratch, 'pids.json'))}, 'utf8'))) {
      let gone = false;
      try { process.kill(pid, 0); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        gone = true;
      }
      if (!gone) throw new Error('previous file descendant is still alive: ' + pid);
    }
    test('green after cleanup', () => expect(true).toBe(true));
  `);
}

describe('complete isolated unit runner', () => {
  test('discovers fast, serial and slow files and excludes every E2E file', () => {
    const files = unitFiles(resolve(import.meta.dir, '..'));
    expect(files.some(f => f.endsWith('.serial.test.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('.slow.test.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('/markdown.test.ts'))).toBe(true);
    expect(files.some(f => f.startsWith('test/e2e/'))).toBe(false);
    expect(files).toEqual([...new Set(files)].sort());
  });

  test('continues after a failed file and preserves its failing aggregate status', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-unit-runner-'));
    const red = fixture('red', "import { test, expect } from 'bun:test'; test('red', () => expect(1).toBe(2));");
    const green = fixture('green', "import { test, expect } from 'bun:test'; test('green', () => expect(1).toBe(1));");
    const rows = await runFiles([red, green], join(scratch, 'logs'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pass: 0, fail: 1, complete: true });
    expect(rows[1]).toMatchObject({ pass: 1, fail: 0, exit: 0, complete: true });
    expect(rows.filter(failed)).toHaveLength(1);
  });

  test('timeout kills real children and grandchildren before advancing, preserving unrelated processes', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-unit-runner-'));
    const unrelated = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      stdout: 'ignore', stderr: 'ignore',
    });
    try {
      const rows = await runFiles([descendantFixture('timeout'), descendantsGoneFixture()], join(scratch, 'logs'), 1000);
      expect(rows[0]).toMatchObject({ timedOut: true, complete: false });
      expect(readFileSync(rows[1]!.log, 'utf8')).not.toContain('previous file descendant is still alive');
      expect(rows[1]).toMatchObject({ pass: 1, fail: 0, exit: 0, complete: true });
      expect(rows.filter(failed)).toHaveLength(1);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      unrelated.kill('SIGKILL');
      await unrelated.exited;
    }
  });

  for (const mode of ['fail', 'pass'] as const) {
    test(`cleans up descendants after a ${mode} file before advancing`, async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-unit-runner-'));
      const rows = await runFiles([descendantFixture(mode), descendantsGoneFixture()], join(scratch, 'logs'));
      expect(rows[0]).toMatchObject({ pass: mode === 'pass' ? 1 : 0, fail: mode === 'fail' ? 1 : 0, complete: true });
      expect(rows[1]).toMatchObject({ pass: 1, fail: 0, exit: 0, complete: true });
      expect(rows.filter(failed)).toHaveLength(mode === 'fail' ? 1 : 0);
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`${signal} cleans up descendants, fails the partial run and stops advancing`, async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-unit-runner-'));
      const wedge = descendantFixture('timeout');
      const marker = join(scratch, 'next-started');
      const next = fixture('next', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');`);
      const output = join(scratch, 'interrupted.json');
      const helper = join(scratch, 'runner.ts');
      writeFileSync(helper, `
        import { writeFileSync } from 'node:fs';
        import { runFiles, failed } from ${JSON.stringify(resolve(import.meta.dir, '../scripts/run-unit-isolated.ts'))};
        const rows = await runFiles(${JSON.stringify([wedge, next])}, ${JSON.stringify(join(scratch, 'logs'))}, 10000);
        writeFileSync(${JSON.stringify(output)}, JSON.stringify(rows));
        process.exit(rows.some(failed) || rows.length !== 2 ? 1 : 0);
      `);
      const runner = Bun.spawn([process.execPath, helper], {
        stdout: 'ignore', stderr: 'ignore', timeout: 4000, killSignal: 'SIGKILL',
        env: { ...process.env },
      });
      try {
        const deadline = Date.now() + 2000;
        while (!existsSync(join(scratch, 'pids.json'))) {
          if (Date.now() >= deadline) throw new Error('fixture descendants did not start');
          await Bun.sleep(10);
        }
        process.kill(runner.pid, signal);
        expect(await runner.exited).toBe(1);
        const rows = JSON.parse(readFileSync(output, 'utf8'));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ interrupted: true, timedOut: false, complete: false });
        expect(failed(rows[0])).toBe(true);
        expect(existsSync(marker)).toBe(false);
        for (const pid of JSON.parse(readFileSync(join(scratch, 'pids.json'), 'utf8'))) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally {
        if (runner.exitCode === null) runner.kill('SIGKILL');
        await runner.exited;
      }
    });
  }

  test('a wedged process is killed and counted as an incomplete failure', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-unit-runner-'));
    const wedge = fixture('wedge', "import { beforeAll, test } from 'bun:test'; beforeAll(() => new Promise(() => {})); test('unreached', () => {});");
    const rows = await runFiles([wedge], join(scratch, 'logs'), 1000);
    expect(rows[0]).toMatchObject({ timedOut: true, complete: false });
    expect(failed(rows[0]!)).toBe(true);
  });
});
