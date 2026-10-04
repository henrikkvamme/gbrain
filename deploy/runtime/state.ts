import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function validatePersistence(root: string) {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Data root must be a canonical absolute path');
  const home = join(root, 'gbrain-runtime');
  const config = JSON.parse(readFileSync(join(home, '.gbrain/config.json'), 'utf8'));
  if (config.engine !== 'pglite' || config.database_path !== join(home, 'brain.pglite')) {
    throw new Error('Expected the existing PGlite configuration at its unchanged absolute path');
  }
  if (!existsSync(join(config.database_path, 'PG_VERSION'))) throw new Error('Existing database is missing');
  for (const source of ['bender-authored', 'bender-communications']) {
    if (!existsSync(join(root, 'gbrain-sources', source, '.git'))) throw new Error('Existing source repository is missing');
  }
  return { home, config };
}

export interface PublishedBundle {
  path: string;
  generation: number;
  revision: string;
}

/** Producer publishes by atomic directory rename, then never modifies it. */
export function publishedBundles(ready: string): PublishedBundle[] {
  if (!existsSync(ready)) return [];
  if (lstatSync(ready).isSymbolicLink()) throw new Error('Bundle spool must not be a symlink');
  const bundles: PublishedBundle[] = [];
  for (const name of readdirSync(ready)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    const path = join(ready, name);
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) continue;
    const manifestPath = join(path, 'manifest.json');
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.adapterKey !== 'gmail-threads' || manifest.gbrainSourceId !== 'bender-communications' ||
        !Number.isSafeInteger(manifest.generation) || manifest.generation < 1 ||
        !/^[a-f0-9]{64}$/.test(manifest.sourceRevision)) throw new Error('Invalid published Gmail bundle identity');
    bundles.push({ path, generation: manifest.generation, revision: manifest.sourceRevision });
  }
  return bundles.sort((a, b) => a.generation - b.generation);
}

export function slotFor(name: 'seafile' | 'gmail', now: number): number {
  return Math.floor(now / (name === 'seafile' ? 3_600_000 : 900_000));
}
