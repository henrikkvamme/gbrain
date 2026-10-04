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
  interrupted: boolean;
  complete: boolean;
  log: string;
}

export function unitFiles(root: string): string[] {
  return [...new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: root })]
    .filter(file => !file.startsWith('test/e2e/')).sort();
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function cleanupGroup(child: Bun.Subprocess): Promise<void> {
  // detached makes this PID the session/group leader on Mac and Linux. Never
  // signal the runner's group or scan/kill unrelated host processes by name.
  signalGroup(child.pid, 'SIGKILL');
  const deadline = Date.now() + 2000;
  while (signalGroup(child.pid, 0)) {
    if (Date.now() >= deadline) throw new Error(`process group ${child.pid} survived cleanup; stopping before the next file`);
    await Bun.sleep(20);
  }
  await child.exited;
}

export async function runFiles(files: string[], logDir: string, timeoutMs = 180_000): Promise<FileResult[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('isolated unit runner requires Mac or Linux process groups');
  }
  mkdirSync(logDir, { recursive: true });
  writeFileSync(resolve(logDir, 'manifest.txt'), files.join('\n') + '\n');
  const results: FileResult[] = [];
  let interrupted = false;
  let stopFile: (() => void) | undefined;
  const interrupt = () => { interrupted = true; stopFile?.(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    for (const [index, file] of files.entries()) {
      if (interrupted) break;
      const log = resolve(logDir, `${index + 1}-${basename(file)}.log`);
      const fd = openSync(log, 'w');
      let exit = 1;
      let timedOut = false;
      try {
        const child = Bun.spawn([process.execPath, 'test', '--timeout=120000', file], {
          detached: true,
          stdout: fd, stderr: fd,
          // Set before Bun starts so Date.parse and the real ps subprocess agree.
          env: { ...process.env, TZ: process.env.TZ ?? 'UTC', LC_ALL: 'C' },
        });
        const stopped = new Promise<void>(resolve => { stopFile = resolve; });
        const timer = setTimeout(() => { timedOut = true; stopFile?.(); }, timeoutMs);
        try {
          await Promise.race([child.exited.then(code => { exit = code; }), stopped]);
        } finally {
          clearTimeout(timer);
          stopFile = undefined;
          // Also remove descendants left behind by a successful or failing file.
          // A cleanup failure throws and prevents continuation/green accounting.
          await cleanupGroup(child);
          exit = child.exitCode ?? exit;
        }
      } finally {
        closeSync(fd);
      }
      const output = readFileSync(log, 'utf8');
      const count = (kind: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${kind}\\s*$`, 'm'))?.[1] ?? 0);
      const result = {
        file, exit, pass: count('pass'), fail: count('fail'), skip: count('skip'),
        timedOut, interrupted, complete: /^\s*\d+ pass\s*$/m.test(output) && /^\s*\d+ fail\s*$/m.test(output), log,
      };
      results.push(result);
      writeFileSync(resolve(logDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
      if (import.meta.main && ((index + 1) % 25 === 0 || exit !== 0)) {
        console.error(`[unit-isolated] files=${index + 1}/${files.length} failed=${results.filter(failed).length} last=${file}`);
      }
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  // An interruption between files must never turn a partial manifest green.
  if (interrupted && results.length) results[results.length - 1]!.interrupted = true;
  writeFileSync(resolve(logDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  return results;
}

export function failed(result: FileResult): boolean {
  return result.exit !== 0 || result.fail !== 0 || result.timedOut || result.interrupted || !result.complete;
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
    console.log(`failures[${failures.length}]{file,exit,complete,timedOut,interrupted}:`);
    for (const row of failures) console.log(`  ${row.file},${row.exit},${row.complete},${row.timedOut},${row.interrupted}`);
  }
  return failures.length || results.length !== files.length ? 1 : 0;
}

if (import.meta.main) {
  try { process.exit(await main()); } catch (error) {
    console.error(`[unit-isolated] infrastructure failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
