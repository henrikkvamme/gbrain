import { randomUUID, timingSafeEqual } from 'node:crypto';
import { NativeJournal } from './native-journal';
import { NATIVE_LIMITS, NATIVE_ROUTES, exactObject, nativeHash, nativeId, validateInference, validateNativeRun, validateResult, type NativeInference, type NativeResult, type NativeRole, type NativeRun } from './native-protocol';

export type NativeRecord = { run: NativeRun; digest: string; epoch: string; status: 'pending' | 'running' | 'complete' | 'failed' | 'uncertain'; result?: unknown; error?: string; inference?: NativeInference; accepted?: NativeResult; owner?: unknown; ownerDrained?: boolean; expires: number };
type State = { version: 1; sequence: number; runs: Record<string, NativeRecord> };
export type NativeCredentials = { brain: string; client: string; scheduler: string; executor: string; relay: string };

/** Separate trusted product transport. Never registered as an MCP operation. */
export class NativeControl {
  readonly journal: NativeJournal<State>;
  private active?: string;
  private draining = false;
  private closing = false;
  constructor(path: string, readonly credentials: NativeCredentials, private readonly execute: (record: NativeRecord, control: NativeControl) => Promise<unknown>, private readonly now = Date.now) {
    for (const token of [credentials.scheduler, credentials.executor, credentials.relay]) if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('invalid_native_credentials');
    if (new Set([credentials.scheduler, credentials.executor, credentials.relay]).size !== 3) throw new Error('native_roles_must_be_distinct');
    this.journal = new NativeJournal(path, { version: 1, sequence: 0, runs: {} });
    const state = this.journal.value;
    if (state.version !== 1 || !Number.isSafeInteger(state.sequence) || !state.runs || Object.keys(state.runs).length > NATIVE_LIMITS.runs) throw new Error('invalid_native_journal');
    for (const r of Object.values(state.runs)) {
      if (!['pending', 'running', 'complete', 'failed', 'uncertain'].includes(r.status) || !Number.isSafeInteger(r.expires) || r.run.sequence > state.sequence || nativeHash(JSON.stringify(validateNativeRun(r.run))) !== r.digest) throw new Error('invalid_native_journal');
      if (r.status === 'running' || r.status === 'uncertain') { r.status = 'uncertain'; this.draining = true; }
    }
    this.persist();
  }
  private persist() { this.journal.commit(this.journal.value); }
  /** Recovery must prove old writers absent before any engine or HTTP owner opens. */
  async recover(proveDrained: (owner: unknown) => Promise<void>) {
    for (const r of Object.values(this.journal.value.runs)) if (r.status === 'uncertain') {
      if (!r.ownerDrained) await proveDrained(r.owner); // Missing/ambiguous ownership is an operator boundary.
      r.status = 'failed'; r.error = 'interrupted'; r.inference = undefined; r.accepted = undefined;
    }
    this.draining = false; this.persist();
  }
  owner(record: NativeRecord, owner: unknown) { record.owner = owner; record.ownerDrained = false; this.persist(); }
  close() { this.closing = true; }
  get uncertain() { return this.draining; }
  private tokenRole(token: string): NativeRole | undefined {
    for (const role of ['scheduler', 'executor', 'relay'] as const) {
      const a = Buffer.from(token), b = Buffer.from(this.credentials[role]);
      if (a.length === b.length && timingSafeEqual(a, b)) return role;
    }
  }
  async handle(request: Request): Promise<Response> {
    try {
      // Authorize the route BEFORE reading a body or resolving a run.
      const url = new URL(request.url);
      const op = url.pathname.slice('/native/v1/'.length);
      if (!url.pathname.startsWith('/native/v1/') || !NATIVE_ROUTES[op] || request.method !== 'POST' || url.search) return new Response(null, { status: 404 });
      const role = this.tokenRole(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if (role !== NATIVE_ROUTES[op]) return Response.json({ error: 'wrong_role' }, { status: 403 });
      if (this.closing || this.draining) return Response.json({ error: 'ownership_uncertain' }, { status: 503 });
      if (Number(request.headers.get('content-length') ?? 0) > NATIVE_LIMITS.wire) throw new Error('payload_limit');
      const reader = request.body?.getReader();
      if (!reader) throw new Error('invalid_payload');
      const chunks: Uint8Array[] = []; let length = 0;
      const deadline = setTimeout(() => { void reader.cancel(); }, 10_000);
      try {
        while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > NATIVE_LIMITS.wire) { await reader.cancel(); throw new Error('payload_limit'); } chunks.push(part.value); }
      } finally { clearTimeout(deadline); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      exactObject(body, ['brain', 'client', 'run', 'id', 'epoch', 'digest', 'request', 'result']);
      if (body.brain !== this.credentials.brain || body.client !== this.credentials.client) throw new Error('wrong_identity');
      const result = await this.dispatch(op, body);
      if (Buffer.byteLength(JSON.stringify(result)) > NATIVE_LIMITS.wire) throw new Error('response_limit');
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      // All errors are codes. Never emit page contents, prompts or provider diagnostics.
      const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'native_request_failed';
      return Response.json({ error: code }, { status: 409 });
    }
  }
  private async dispatch(op: string, body: Record<string, unknown>): Promise<unknown> {
    if (op === 'submit') {
      const run = validateNativeRun(body.run), digest = nativeHash(JSON.stringify(run));
      const old = this.journal.value.runs[run.id];
      if (old) { if (old.digest !== digest) throw new Error('replay_mismatch'); return this.receipt(old); }
      if (this.active || Object.values(this.journal.value.runs).some(r => r.status === 'pending' || r.status === 'running')) throw new Error('writer_busy');
      if (run.sequence <= this.journal.value.sequence) throw new Error('stale_generation');
      if (Object.keys(this.journal.value.runs).length >= NATIVE_LIMITS.runs) throw new Error('journal_full');
      const record: NativeRecord = { run, digest, epoch: randomUUID(), status: 'pending', expires: this.now() + NATIVE_LIMITS.runMs };
      this.journal.commit({ ...this.journal.value, runs: { ...this.journal.value.runs, [run.id]: record }, sequence: run.sequence });
      return this.receipt(record);
    }
    if (op === 'poll') {
      const r = this.active ? this.journal.value.runs[this.active] : undefined;
      return { request: r?.status === 'running' && r.inference && !r.accepted && r.inference.expires > this.now() ? r.inference : null };
    }
    nativeId(body.id);
    const r = this.journal.value.runs[body.id];
    if (!r) throw new Error('unknown_run');
    if (op === 'status') return this.receipt(r);
    if (r.status !== 'running' || this.active !== body.id || body.epoch !== r.epoch || r.expires <= this.now()) throw new Error('stale_result');
    if (op === 'infer') {
      const req = validateInference(body.request);
      if (r.inference && !r.accepted) throw new Error('inference_busy');
      const request: NativeInference = { ...req, id: randomUUID(), runId: r.run.id, epoch: r.epoch, digest: nativeHash(JSON.stringify(req)), expires: Math.min(this.now() + NATIVE_LIMITS.inferenceMs, r.expires) };
      r.inference = request; r.accepted = undefined; this.persist();
      return { request };
    }
    const inference = r.inference;
    if (!inference || body.digest !== inference.digest || !body.request || body.request !== inference.id || inference.expires <= this.now()) throw new Error('stale_result');
    if (op === 'inference') return { result: r.accepted ?? null };
    if (op === 'result') {
      const result = validateResult(body.result);
      if (r.accepted && JSON.stringify(result) !== JSON.stringify(r.accepted)) throw new Error('result_replay_mismatch');
      r.accepted = result; this.persist(); return { accepted: true };
    }
    throw new Error('invalid_action');
  }
  private receipt(r: NativeRecord) { return { id: r.run.id, sequence: r.run.sequence, digest: r.digest, epoch: r.epoch, status: r.status, ...(r.result === undefined ? {} : { result: r.result }), ...(r.error ? { error: r.error } : {}) }; }
  /** Called by the supervisor loop; all actual engine work goes through its lifecycle. */
  async tick() {
    if (this.closing || this.draining || this.active) return;
    const record = Object.values(this.journal.value.runs).find(r => r.status === 'pending');
    if (!record) return;
    this.active = record.run.id; record.status = 'running'; record.epoch = randomUUID(); this.persist();
    try {
      if (record.expires <= this.now()) throw new Error('run_expired');
      const result = await this.execute(record, this);
      if (Buffer.byteLength(JSON.stringify(result)) > NATIVE_LIMITS.result) throw new Error('response_limit');
      record.result = result; record.status = 'complete';
    } catch {
      // execute must prove cleanup. Uncertain cleanup poisons the entire listener.
      record.status = record.owner && !record.ownerDrained ? 'uncertain' : 'failed'; record.error = 'native_run_failed';
      if (record.owner && !record.ownerDrained) this.draining = true;
    } finally {
      record.inference = undefined; record.accepted = undefined; this.active = undefined; this.persist();
    }
  }
  drained(record: NativeRecord) { record.ownerDrained = true; this.persist(); }
}
