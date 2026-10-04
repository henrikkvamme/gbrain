import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedBundles, slotFor, validatePersistence } from '../../deploy/runtime/state';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporaryRoot = () => { const root = mkdtempSync(join(tmpdir(), 'runtime-fixture-')); roots.push(root); return root; };

test('bootstrap only accepts an existing brain and preserves the config bytes', () => {
  const root = temporaryRoot();
  expect(() => validatePersistence(root)).toThrow();
  const home = join(root, 'gbrain-runtime');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'brain.pglite'));
  writeFileSync(join(home, 'brain.pglite/PG_VERSION'), '17');
  for (const source of ['bender-authored', 'bender-communications']) mkdirSync(join(root, 'gbrain-sources', source, '.git'), { recursive: true });
  const file = join(home, '.gbrain/config.json');
  const text = JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite'), embedding_model: 'ollama:fixture', embedding_dimensions: 1024, search: { mode: 'conservative' } });
  writeFileSync(file, text);
  expect(validatePersistence(root).config.embedding_dimensions).toBe(1024);
  expect(readFileSync(file, 'utf8')).toBe(text);
  writeFileSync(file, JSON.stringify({ engine: 'pglite', database_path: '/missing/brain' }));
  expect(() => validatePersistence(root)).toThrow('unchanged absolute path');
});

test('published spool is ordered by generation, ignores temporary dirs and rejects foreign sources', () => {
  const ready = temporaryRoot();
  const publish = (name: string, generation: number, source = 'bender-communications') => {
    mkdirSync(join(ready, name));
    writeFileSync(join(ready, name, 'manifest.json'), JSON.stringify({ adapterKey: 'gmail-threads', gbrainSourceId: source, generation, sourceRevision: 'a'.repeat(64) }));
  };
  publish('later', 2);
  publish('earlier', 1);
  mkdirSync(join(ready, '.uploading'));
  symlinkSync(join(ready, 'earlier'), join(ready, 'symlink'));
  expect(publishedBundles(ready).map(x => x.generation)).toEqual([1, 2]);
  publish('foreign', 3, 'other-source');
  expect(() => publishedBundles(ready)).toThrow('identity');
});

test('hourly and fifteen-minute slots handle restart and clock boundaries', () => {
  expect(slotFor('gmail', 899999)).toBe(0);
  expect(slotFor('gmail', 900000)).toBe(1);
  expect(slotFor('seafile', 3599999)).toBe(0);
  expect(slotFor('seafile', 3600000)).toBe(1);
});
