#!/usr/bin/env bun
// Complete unit coverage with one Bun module registry / WASM lifetime per file.
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

export interface FileResult {
  file: string;
  exit: number;
  pass: number;
  fail: number;
  skip: number;
  timedOut: boolean;
  complete: boolean;
  log: string;
}

export function unitFiles(root: string): string[] {
  return [...new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: root })]
    .filter(file => !file.startsWith('test/e2e/')).sort();
}

export async function runFiles(files: string[], logDir: string, timeoutMs = 180_000): Promise<FileResult[]> {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(resolve(logDir, 'manifest.txt'), files.join('\n') + '\n');
  const results: FileResult[] = [];
  for (const [index, file] of files.entries()) {
    const log = resolve(logDir, `${index + 1}-${basename(file)}.log`);
    const fd = openSync(log, 'w');
    let exit = 1;
    let timedOut = false;
    try {
      const child = Bun.spawn([process.execPath, 'test', '--timeout=120000', file], {
        stdout: fd, stderr: fd,
        // Set before Bun starts so Date.parse and the real ps subprocess agree.
        env: { ...process.env, TZ: process.env.TZ ?? 'UTC', LC_ALL: 'C' },
      });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      try { exit = await child.exited; } finally { clearTimeout(timer); }
    } finally {
      closeSync(fd);
    }
    const output = readFileSync(log, 'utf8');
    const count = (kind: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${kind}\\s*$`, 'm'))?.[1] ?? 0);
    const result = {
      file, exit, pass: count('pass'), fail: count('fail'), skip: count('skip'),
      timedOut, complete: /^\s*\d+ pass\s*$/m.test(output) && /^\s*\d+ fail\s*$/m.test(output), log,
    };
    results.push(result);
    writeFileSync(resolve(logDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    if (import.meta.main && ((index + 1) % 25 === 0 || exit !== 0)) {
      console.error(`[unit-isolated] files=${index + 1}/${files.length} failed=${results.filter(failed).length} last=${file}`);
    }
  }
  return results;
}

export function failed(result: FileResult): boolean {
  return result.exit !== 0 || result.fail !== 0 || result.timedOut || !result.complete;
}

async function main(): Promise<number> {
  const root = resolve(import.meta.dir, '..');
  process.chdir(root);
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('usage: bun run test:isolated [--dry-run-list]\nlogs: .context/unit-isolated\nscope: all non-E2E test files, including slow and serial');
    return 0;
  }
  if (args.length > 0 && !(args.length === 1 && args[0] === '--dry-run-list')) {
    console.log('error: unknown arguments\nhelp: bun run test:isolated --help');
    return 2;
  }
  const files = unitFiles(root);
  if (args[0] === '--dry-run-list') {
    console.log(files.join('\n'));
    return 0;
  }
  if (process.env.DATABASE_URL || process.env.GBRAIN_DATABASE_URL) {
    console.log('error: unit runner requires DATABASE_URL and GBRAIN_DATABASE_URL unset');
    return 2;
  }
  if (files.length === 0) {
    console.log('error: no unit test files found');
    return 2;
  }
  const results = await runFiles(files, resolve(root, '.context/unit-isolated'));
  const failures = results.filter(failed);
  const sum = (key: 'pass' | 'fail' | 'skip') => results.reduce((n, row) => n + row[key], 0);
  console.log(`files: ${results.length}\nfailed_files: ${failures.length}\npass: ${sum('pass')}\nfail: ${sum('fail')}\nskip: ${sum('skip')}\nlogs: .context/unit-isolated`);
  if (failures.length) {
    console.log(`failures[${failures.length}]{file,exit,complete,timedOut}:`);
    for (const row of failures) console.log(`  ${row.file},${row.exit},${row.complete},${row.timedOut}`);
  }
  return failures.length ? 1 : 0;
}

if (import.meta.main) {
  try { process.exit(await main()); } catch (error) {
    console.error(`[unit-isolated] infrastructure failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
