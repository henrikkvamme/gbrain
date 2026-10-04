import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExclusiveLifecycle } from './lifecycle';
import { publishedBundles, slotFor, validatePersistence } from './state';

type Child = ReturnType<typeof Bun.spawn>;
type State = { slots: Partial<Record<'seafile' | 'gmail', number>>; gmail?: { generation: number; revision: string }; lastJob?: { name: string; ok: boolean; at: string } };

export async function runRuntime() {
  const root = process.env.GBRAIN_DATA_ROOT!;
  const { config } = validatePersistence(root); // Refuse fresh init, path rewrites, or missing copied state.
  const statePath = join(root, 'gbrain-runtime', '.runtime-schedule.json');
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { slots: {} };
  if (!state.slots || typeof state.slots !== 'object') throw new Error('Invalid schedule state');
  const persist = () => {
    const temp = `${statePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temp, statePath);
  };
  const enabled = (key: string) => {
    const value = process.env[key] ?? 'false';
    if (value !== 'true' && value !== 'false') throw new Error('Schedule flags must be true or false');
    return value === 'true';
  };
  const seafile = enabled('GBRAIN_ENABLE_SEAFILE');
  const gmail = enabled('GBRAIN_ENABLE_GMAIL_APPLY');
  const publicUrl = process.env.GBRAIN_PUBLIC_URL;
  if (!publicUrl || new URL(publicUrl).protocol !== 'https:') throw new Error('Private HTTPS issuer is required');
  if (!/^[A-Za-z0-9_-]{32,}$/.test(process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN ?? '')) throw new Error('A strong admin token is required');
  if (!process.env.OLLAMA_MODEL || !process.env.OLLAMA_BASE_URL) throw new Error('Existing Ollama configuration is required');
  const freeDisk = async () => {
    const probe = Bun.spawn(['df', '-Pk', root], { stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(probe.stdout).text();
    if (await probe.exited !== 0 || Number(text.trim().split('\n').at(-1)?.split(/\s+/)[3] ?? 0) < 5_242_880) {
      throw new Error('At least 5 GiB free product storage is required');
    }
  };
  await freeDisk();
  // Validate only. Never pull a model or submit an embedding/inference request.
  const tagsUrl = new URL('/api/tags', process.env.OLLAMA_BASE_URL);
  const tags = await fetch(tagsUrl, { signal: AbortSignal.timeout(10_000) });
  if (!tags.ok) throw new Error('Ollama model inventory unavailable');
  const inventory = await tags.json() as { models?: { name: string }[] };
  const tag = process.env.OLLAMA_MODEL.includes(':') ? process.env.OLLAMA_MODEL : `${process.env.OLLAMA_MODEL}:latest`;
  const configuredModel = String(config.embedding_model).replace(/^ollama:/, '');
  const configuredTag = configuredModel.includes(':') ? configuredModel : `${configuredModel}:latest`;
  if (tag !== configuredTag) throw new Error('Model inventory tag differs from the existing embedding configuration');
  if (!inventory.models?.some(model => model.name === tag)) throw new Error('Existing Ollama model is missing; no automatic pull is permitted');

  let shuttingDown = false;
  let maintenance = false;
  let server: Child | undefined;
  let job: Child | undefined;
  // A tracked session confines job descendants so timeout/shutdown cannot leave a writer.
  const spawn = (args: string[]) => Bun.spawn(args, { detached: true, stdout: 'ignore', stderr: 'ignore' });
  const signalGroup = (child: Child, signal: NodeJS.Signals) => {
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = async (child: Child) => {
    // Signal the whole group even if its parent has already exited.
    signalGroup(child, 'SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.exited, new Promise<void>((resolve) => {
        timer = setTimeout(() => { signalGroup(child, 'SIGKILL'); resolve(); }, 30_000);
      })]);
      await child.exited;
      // Sweep descendants after graceful parent exit before starting another owner.
      signalGroup(child, 'SIGKILL');
      const deadline = Date.now() + 10_000;
      while (true) {
        try { process.kill(-child.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        if (Date.now() > deadline) throw new Error('Child process group did not drain');
        await Bun.sleep(20);
      }
    } finally { if (timer) clearTimeout(timer); }
  };
  const lifecycle = new ExclusiveLifecycle(async () => {
    server = spawn(['bun', '/app/deploy/runtime/http-worker.ts']);
    const child = server;
    return { stop: async () => { await stop(child); if (child.exitCode !== 0) throw new Error('HTTP owner did not close cleanly'); server = undefined; } };
  });
  const health = Bun.serve({
    hostname: '127.0.0.1', port: 3132,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/health') return new Response(null, { status: 404 });
      let ok = !shuttingDown && (maintenance || !!server && server.exitCode === null);
      if (ok && !maintenance) {
        try { ok = (await fetch('http://127.0.0.1:3131/health', { signal: AbortSignal.timeout(4000) })).ok; }
        catch { ok = false; }
      }
      return Response.json({ ok, maintenance, lastJob: state.lastJob ?? null }, { status: ok ? 200 : 503 });
    },
  });
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (job) void stop(job);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const boot = Date.now();
  try {
    await lifecycle.start();
    while (!shuttingDown) {
      if (server?.exitCode !== null && !maintenance) throw new Error('HTTP owner exited');
      const now = Date.now();
      for (const name of ['seafile', 'gmail'] as const) {
        if (shuttingDown || !(name === 'seafile' ? seafile : gmail)) continue;
        // Stagger hourly work at +5m and Gmail at +2m, with a 5m boot delay.
        const slot = slotFor(name, now - (name === 'seafile' ? 300_000 : 120_000));
        if (now - boot < 300_000 || state.slots[name] === slot) continue;
        state.slots[name] = slot;
        persist(); // Failures retry next slot, never in a busy loop.
        maintenance = true;
        let ok = false;
        try {
          await lifecycle.run(async () => {
            await freeDisk();
            const run = async (args: string[], timeoutMs: number) => {
              job = spawn(['/bin/bash', '/app/deploy/runtime/jobs.sh', ...args]);
              const child = job;
              const timeout = setTimeout(() => { void stop(child); }, timeoutMs);
              try {
                const rc = await child.exited;
                // Parent exit must not leave grandchildren holding the brain.
                await stop(child);
                if (rc !== 0) throw new Error('Ingestion child failed');
              } finally { clearTimeout(timeout); job = undefined; }
              if (shuttingDown) throw new Error('Job interrupted by shutdown');
            };
            if (name === 'seafile') await run(['seafile'], 900_000);
            else {
              for (const bundle of publishedBundles(join(root, 'gbrain-ingestion/gmail/ready'))) {
                if (state.gmail && bundle.generation < state.gmail.generation) continue;
                if (state.gmail?.generation === bundle.generation) {
                  if (state.gmail.revision !== bundle.revision) throw new Error('Conflicting published generation');
                  continue;
                }
                await run(['apply-gmail', bundle.path], 1_800_000);
                state.gmail = { generation: bundle.generation, revision: bundle.revision };
                persist();
              }
            }
          });
          ok = true;
        } catch {
          console.error(`runtime job ${name} failed; retained state, retry next slot`);
        } finally {
          maintenance = false;
          state.lastJob = { name, ok, at: new Date().toISOString() };
          persist();
        }
      }
      if (!shuttingDown) await Bun.sleep(1000);
    }
  } finally {
    shutdown();
    if (job) await stop(job);
    try { await lifecycle.close(); } finally { health.stop(true); }
  }
}

if (import.meta.main) runRuntime().catch((error) => {
  // Never put paths, page contents, provider errors, or credentials in app logs.
  const known = [
    'Data root must be a canonical absolute path',
    'Expected the existing PGlite configuration at its unchanged absolute path',
    'Existing database is missing', 'Existing source repository is missing',
    'Invalid schedule state', 'Schedule flags must be true or false',
    'Private HTTPS issuer is required', 'A strong admin token is required',
    'Existing Ollama configuration is required',
    'At least 5 GiB free product storage is required',
    'Ollama model inventory unavailable',
    'Model inventory tag differs from the existing embedding configuration',
    'Existing Ollama model is missing; no automatic pull is permitted',
    'HTTP owner exited', 'HTTP owner did not close cleanly', 'Child process group did not drain',
  ];
  const message = error instanceof Error && known.includes(error.message) ? error.message : 'check persistence, lock, model inventory and schedule metadata';
  console.error(`runtime stopped: ${message}`);
  process.exit(1);
});
