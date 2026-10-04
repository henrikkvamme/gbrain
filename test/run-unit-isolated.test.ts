import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { failed, runFiles, unitFiles } from '../scripts/run-unit-isolated.ts';

let scratch: string;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

function fixture(name: string, source: string): string {
  const file = join(scratch, `${name}.test.ts`);
  writeFileSync(file, source);
  return file;
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

  test('a wedged process is killed and counted as an incomplete failure', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-unit-runner-'));
    const wedge = fixture('wedge', "import { beforeAll, test } from 'bun:test'; beforeAll(() => new Promise(() => {})); test('unreached', () => {});");
    const rows = await runFiles([wedge], join(scratch, 'logs'), 1000);
    expect(rows[0]).toMatchObject({ timedOut: true, complete: false });
    expect(failed(rows[0]!)).toBe(true);
  });
});
