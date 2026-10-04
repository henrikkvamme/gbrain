import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEngine } from '../../src/core/engine-factory';
import { loadConfig, loadConfigWithEngine, toEngineConfig } from '../../src/core/config';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config';
import { configureGateway, getEmbeddingModel, reconfigureGatewayWithEngine } from '../../src/core/ai/gateway';
import { runCycle, type CyclePhase } from '../../src/core/cycle';
import { runSync } from '../../src/commands/sync';
import { operationsByName } from '../../src/core/operations';
import { fetchSource } from '../../src/core/sources-load';
import { nativeMaintenanceRefusals } from '../../src/core/ai/native-maintenance-policy';
import { NATIVE_LIMITS, validateNativeRun, type NativeRun } from './native-protocol';

export function confinedPagePath(repo: string, path: string): string {
  if (realpathSync(repo) !== repo || lstatSync(repo).isSymbolicLink()) throw new Error('unsafe_projection');
  const target = join(repo, path);
  for (let part = target; part !== repo; part = dirname(part)) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('unsafe_projection');
  }
  return target;
}
export async function publishBehaviorPages(repo: string, run: NativeRun, sync: () => Promise<void>) {
  const pages = validateNativeRun(run).pages!;
  // Validate the complete batch before changing any path. No deletions.
  const targets = pages.map(page => confinedPagePath(repo, page.path));
  for (let i = 0; i < pages.length; i++) {
    mkdirSync(dirname(targets[i]), { recursive: true, mode: 0o700 });
    const temp = `${targets[i]}.${randomUUID()}.native.tmp`;
    writeFileSync(temp, pages[i].content, { mode: 0o600, flag: 'wx' });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, targets[i]);
    const dir = openSync(dirname(targets[i]), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  const git = async (args: string[]) => {
    const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const output = await new Response(proc.stdout).text();
    if (await proc.exited !== 0) throw new Error('projection_git_failed');
    return output;
  };
  const paths = pages.map(p => p.path);
  if ((await git(['status', '--porcelain', '--', ...paths])).trim()) {
    await git(['add', '--', ...paths]);
    await git(['-c', 'user.name=Memory service', '-c', 'user.email=memory@localhost', 'commit', '--only', '-m', 'Record behavior review', '--', ...paths]);
  }
  await sync(); // Always retry sync after a projection commit, including exact replay.
  return { published: pages.length };
}

/** Called only as a gated child of the external-lock-owning supervisor. */
export async function runNativeWorker(run: NativeRun) {
  if (process.env.GBRAIN_NATIVE_MAINTENANCE !== '1' || !process.env.GBRAIN_NATIVE_EPOCH) throw new Error('native_worker_not_admitted');
  const cfg = loadConfig();
  if (!cfg || cfg.engine !== 'pglite') throw new Error('existing_config_required');
  const engine = await createEngine(toEngineConfig(cfg));
  await engine.connect(toEngineConfig(cfg));
  try {
    const merged = await loadConfigWithEngine(engine, cfg) ?? cfg;
    configureGateway(buildGatewayConfig(merged));
    await reconfigureGatewayWithEngine(engine);
    if (!getEmbeddingModel().startsWith('ollama:')) throw new Error('unsupported_embedding_provider');
    const sourceId = run.action === 'communications-dream' ? 'bender-communications' : 'bender-behavior';
    const source = await fetchSource(engine, sourceId);
    if (!source?.local_path || source.archived) throw new Error('existing_source_required');
    const repo = realpathSync(source.local_path);
    if (repo !== source.local_path || !existsSync(join(repo, '.git'))) throw new Error('unsafe_projection');
    const checked = <T>(result: T): T => { if (nativeMaintenanceRefusals()) throw new Error('unsupported_native_phase_transport'); return result; };
    if (run.action === 'communications-dream') {
      // These existing phases require durable tool loops. The Codex recipe is
      // text-only. Never enqueue unavailable server harness work or change flags.
      const corpus = await engine.getConfig('dream.synthesize.session_corpus_dir');
      if (corpus && await engine.getConfig('dream.synthesize.enabled') !== 'false' || await engine.getConfig('dream.patterns.enabled') !== 'false') throw new Error('unsupported_native_phase_transport');
    }
    if (run.action === 'behavior-publish') return checked(await publishBehaviorPages(repo, run, async () => { await runSync(engine, ['--repo', repo, '--source', sourceId, '--no-pull']); }));
    if (run.action === 'behavior-search') return checked(await operationsByName.search.handler({ engine, config: merged, remote: true, sourceId, logger: { info() {}, warn() {}, error() {} } } as never, { query: 'repeated workflow friction user feedback batching shortcut interruption', limit: 20 }));
    const report = await runCycle(engine, { brainDir: repo, sourceId, ...(run.action === 'behavior-dream' ? { phases: ['propose_takes'] as CyclePhase[] } : {}) });
    if (report.status === 'failed' || report.status === 'skipped') throw new Error('native_cycle_failed');
    return checked(report);
  } finally { await engine.disconnect(); }
}

if (import.meta.main) {
  try {
    // Parent journals the child's boot/birth fence BEFORE delivering stdin.
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > NATIVE_LIMITS.wire) throw new Error('payload_limit');
    const run = validateNativeRun(JSON.parse(input));
    const result = JSON.stringify(await runNativeWorker(run));
    if (Buffer.byteLength(result) > NATIVE_LIMITS.result) throw new Error('response_limit');
    const path = process.env.GBRAIN_NATIVE_OUTPUT!;
    writeFileSync(`${path}.tmp`, result, { mode: 0o600, flag: 'wx' }); renameSync(`${path}.tmp`, path);
  } catch { console.error('native maintenance failed'); process.exit(1); }
}
