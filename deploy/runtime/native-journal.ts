import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One supervisor writes this journal; rename + file/directory fsync is the commit. */
export class NativeJournal<T> {
  value: T;
  constructor(readonly path: string, initial: T) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink() || existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('unsafe_journal');
    if (existsSync(path) && lstatSync(path).size > 64 * 1024 * 1024) throw new Error('journal_limit');
    this.value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : initial;
  }
  commit(value: T) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('journal_limit');
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    this.value = value;
  }
}
