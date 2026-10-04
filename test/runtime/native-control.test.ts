import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeControl, type NativeRecord } from '../../deploy/runtime/native-control';
import { validateNativeRun, NATIVE_LIMITS } from '../../deploy/runtime/native-protocol';
import { relayCodex } from '../../deploy/runtime/native-relay';
import { confinedPagePath, publishBehaviorPages } from '../../deploy/runtime/native-worker';
import { ExclusiveLifecycle } from '../../deploy/runtime/lifecycle';
import { operationsByName } from '../../src/core/operations';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const credentials = { brain: 'host', client: 'fixture-mac', scheduler: 's'.repeat(40), executor: 'e'.repeat(40), relay: 'r'.repeat(40) };
function fixture(execute: (record: NativeRecord, control: NativeControl) => Promise<unknown> = async () => ({ ok: true }), now = Date.now) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-control-fixture-'))); roots.push(root);
  const path = join(root, 'state.json'), control = new NativeControl(path, credentials, execute, now);
  const call = async (op: string, body: unknown, role: keyof typeof credentials = 'scheduler') => {
    const response = await control.handle(new Request(`http://localhost/native/v1/${op}`, { method: 'POST', headers: { authorization: `Bearer ${credentials[role]}` }, body: JSON.stringify({ brain: 'host', client: 'fixture-mac', ...body as object }) }));
    return { code: response.status, body: await response.json() as any };
  };
  return { root, path, control, call };
}
const run = { id: 'run-one', sequence: 1, action: 'behavior-dream' };

test('authenticates roles before decoding malformed bodies and confines identity/scope', async () => {
  const f = fixture();
  expect((await f.call('submit', { run }, 'executor')).code).toBe(403);
  expect((await f.call('result', {}, 'scheduler')).code).toBe(403);
  expect((await f.call('submit', { run, brain: 'other' })).body.error).toBe('wrong_identity');
  expect((await f.call('submit', { run, client: 'other' })).body.error).toBe('wrong_identity');
  expect((await f.call('submit', { run: { ...run, source: 'other' } })).body.error).toBe('invalid_payload');
  expect((await f.call('submit', { run: { ...run, action: 'shell' } })).body.error).toBe('invalid_action');
  const response = await f.control.handle(new Request('http://localhost/native/v1/submit', { method: 'POST', headers: { authorization: `Bearer ${credentials.executor}` }, body: 'invalid json' }));
  expect(response.status).toBe(403);
});

test('lost receipt restart returns completed result without another writer', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return { ok: true }; });
  expect((await f.call('submit', { run })).body.status).toBe('pending');
  await f.control.tick();
  const restarted = new NativeControl(f.path, credentials, async () => { calls++; return {}; });
  await restarted.tick();
  expect((await f.call('submit', { run })).body).toMatchObject({ status: 'complete', result: { ok: true } });
  expect(calls).toBe(1);
  expect((await f.call('submit', { run: { ...run, action: 'behavior-search' } })).body.error).toBe('replay_mismatch');
  expect((await f.call('submit', { run: { ...run, id: 'two' } })).body.error).toBe('stale_generation');
});

test('single admission rejects a concurrent writer and waits for verified HTTP exit', async () => {
  let release!: () => void; let started = false;
  const life = new ExclusiveLifecycle(async () => ({ stop: () => new Promise<void>(resolve => { release = resolve; }) }));
  await life.start();
  const f = fixture(async () => { await life.run(async () => { started = true; }); return {}; });
  await f.call('submit', { run }); const ticking = f.control.tick(); await Bun.sleep(5);
  expect(started).toBe(false);
  expect((await f.call('submit', { run: { ...run, id: 'two', sequence: 2 } })).body.error).toBe('writer_busy');
  release(); await ticking; expect(started).toBe(true);
  // Second HTTP owner cleanup uses the same explicit release fixture.
  const closing = life.close(); await Bun.sleep(1); release(); await closing;
});

test('rejects stale epoch/request/digest, accepts one result and identical result replay', async () => {
  let inference: any; let unblock!: () => void;
  const f = fixture(async r => { await new Promise<void>(resolve => { unblock = resolve; }); return { done: r.accepted?.text }; });
  await f.call('submit', { run }); const ticking = f.control.tick(); await Bun.sleep(1);
  const status = (await f.call('status', { id: run.id })).body;
  inference = (await f.call('infer', { id: run.id, epoch: status.epoch, request: { model: 'gpt-5.6-sol', effort: 'high', prompt: 'Synthetic text' } }, 'relay')).body.request;
  const result = { text: 'Synthetic answer', inputTokens: 2, outputTokens: 2, cachedTokens: 0 };
  const payload = { id: run.id, epoch: status.epoch, request: inference.id, digest: inference.digest, result };
  expect((await f.call('result', { ...payload, epoch: 'older' }, 'executor')).body.error).toBe('stale_result');
  expect((await f.call('result', { ...payload, request: 'other' }, 'executor')).body.error).toBe('stale_result');
  expect((await f.call('result', { ...payload, digest: '0'.repeat(64) }, 'executor')).body.error).toBe('stale_result');
  expect((await f.call('result', payload, 'executor')).body.accepted).toBe(true);
  expect((await f.call('result', payload, 'executor')).body.accepted).toBe(true);
  expect((await f.call('result', { ...payload, result: { ...result, text: 'changed' } }, 'executor')).body.error).toBe('result_replay_mismatch');
  expect((await f.call('poll', {}, 'executor')).body.request).toBeNull();
  unblock(); await ticking;
  expect((await f.call('result', payload, 'executor')).body.error).toBe('stale_result');
});

test('restart and drain failure fence all roles until a verified absence proof', async () => {
  const f = fixture(async (r, c) => { c.owner(r, { fixture: 'birth' }); throw new Error('drain'); });
  await f.call('submit', { run }); await f.control.tick(); expect(f.control.uncertain).toBe(true);
  const restarted = new NativeControl(f.path, credentials, async () => ({}));
  await expect(restarted.recover(async () => { throw new Error('owner alive'); })).rejects.toThrow('owner alive');
  expect(restarted.uncertain).toBe(true);
  expect((await f.call('poll', {}, 'executor')).code).toBe(503);
  await restarted.recover(async owner => { expect(owner).toEqual({ fixture: 'birth' }); });
  expect(restarted.uncertain).toBe(false);
  expect(JSON.parse(readFileSync(f.path, 'utf8')).runs[run.id]).toMatchObject({ status: 'failed', error: 'interrupted' });
});

test('restarts a durably pending request without inferring completion from phase caches', async () => {
  const f = fixture(); await f.call('submit', { run }); let called = 0;
  const restarted = new NativeControl(f.path, credentials, async () => { called++; return { actualRunCompleted: true }; });
  await restarted.tick(); expect(called).toBe(1);
});

test('expired inference is not delivered or accepted and oversized payloads reject', async () => {
  let now = Date.now(), release!: () => void;
  const f = fixture(async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; }, () => now);
  await f.call('submit', { run }); const ticking = f.control.tick(); await Bun.sleep(1);
  const epoch = (await f.call('status', { id: run.id })).body.epoch;
  const { request } = (await f.call('infer', { id: run.id, epoch, request: { model: 'gpt-5.6-sol', effort: 'high', prompt: 'fixture' } }, 'relay')).body;
  now += NATIVE_LIMITS.inferenceMs + 1;
  expect((await f.call('poll', {}, 'executor')).body.request).toBeNull();
  expect((await f.call('result', { id: run.id, epoch, request: request.id, digest: request.digest, result: {} }, 'executor')).body.error).toBe('stale_result');
  release(); await ticking;
  expect((await f.call('submit', { run: { ...run, id: 'new', sequence: 2, pages: 'x'.repeat(NATIVE_LIMITS.wire) } })).body.error).toBe('payload_limit');
});

test('relay accepts exactly the existing text-only argv contract', async () => {
  const args = ['--ask-for-approval', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'gpt-5.6-sol', '--config', 'model_reasoning_effort="high"', '--json', '-'];
  const call = async (op: string) => op === 'infer' ? { request: { id: 'request', digest: 'digest', expires: Date.now() + 1000 } } : { result: { text: 'answer', inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
  const output = await relayCodex(args, 'fixture', call); expect(output).toContain('agent_message');
  await expect(relayCodex([...args, '--cd', '/tmp'], 'fixture', call)).rejects.toThrow('unsupported_native_invocation');
  await expect(relayCodex(args.map(a => a === 'gpt-5.6-sol' ? 'other' : a), 'fixture', call)).rejects.toThrow('unsupported_native_invocation');
});

test('behavior publication validates all paths and preserves unrelated Git edits', async () => {
  const f = fixture(), repo = join(f.root, 'repo'); mkdirSync(repo);
  Bun.spawnSync(['git', '-C', repo, 'init', '--initial-branch=main']); Bun.spawnSync(['git', '-C', repo, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'unrelated.txt'), 'retained'); Bun.spawnSync(['git', '-C', repo, 'add', 'unrelated.txt']);
  let synced = 0; const input = { id: 'publish', sequence: 1, action: 'behavior-publish' as const, pages: [{ path: 'feedback/fixture.md', content: 'Synthetic feedback' }] };
  await publishBehaviorPages(repo, input, async () => { synced++; });
  await publishBehaviorPages(repo, input, async () => { synced++; }); expect(synced).toBe(2);
  expect(Bun.spawnSync(['git', '-C', repo, 'status', '--porcelain']).stdout.toString()).toContain('A  unrelated.txt');
  expect(() => validateNativeRun({ ...input, pages: [{ path: '../outside.md', content: 'bad' }] })).toThrow('invalid_page');
  const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(repo, 'observations'));
  expect(() => confinedPagePath(repo, 'observations/2026-10-04/fixture.md')).toThrow('unsafe_projection');
});

test('ordinary MCP still rejects every protected maintenance name before engine access', async () => {
  for (const name of ['synthesize', 'patterns', 'consolidate', 'shell', 'subagent']) {
    for (const remote of [true, undefined]) await expect(operationsByName.submit_job.handler({ remote, engine: undefined } as never, { name })).rejects.toThrow('cannot be submitted over MCP');
  }
});
