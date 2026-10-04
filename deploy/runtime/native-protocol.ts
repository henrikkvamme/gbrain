import { createHash } from 'node:crypto';

export const NATIVE_LIMITS = { wire: 2 * 1024 * 1024, prompt: 1024 * 1024, result: 512 * 1024, pages: 128, runs: 4096, runMs: 60 * 60_000, inferenceMs: 300_000 };
export type NativeRole = 'scheduler' | 'executor' | 'relay';
export type NativeAction = 'communications-dream' | 'behavior-dream' | 'behavior-publish' | 'behavior-search';
export type NativePage = { path: string; content: string };
export type NativeRun = { id: string; sequence: number; action: NativeAction; reconciliation?: { generation: number; revision: string }; pages?: NativePage[] };
export type NativeInference = { id: string; runId: string; epoch: string; digest: string; model: string; effort: string; prompt: string; expires: number };
export type NativeResult = { text: string; inputTokens: number; outputTokens: number; cachedTokens: number };
export const nativeHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function exactObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('invalid_payload');
}
export function nativeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('invalid_identity');
}
export function validateNativeRun(value: unknown): NativeRun {
  exactObject(value, ['id', 'sequence', 'action', 'reconciliation', 'pages']);
  nativeId(value.id);
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw new Error('invalid_generation');
  if (!['communications-dream', 'behavior-dream', 'behavior-publish', 'behavior-search'].includes(String(value.action))) throw new Error('invalid_action');
  if (value.action === 'communications-dream') {
    exactObject(value.reconciliation, ['generation', 'revision']);
    if (!Number.isSafeInteger(value.reconciliation.generation) || Number(value.reconciliation.generation) < 1 || !/^[a-f0-9]{64}$/.test(String(value.reconciliation.revision))) throw new Error('invalid_reconciliation');
  } else if (value.reconciliation !== undefined) throw new Error('invalid_scope');
  if (value.action === 'behavior-publish') {
    if (!Array.isArray(value.pages) || !value.pages.length || value.pages.length > NATIVE_LIMITS.pages) throw new Error('invalid_pages');
    const seen = new Set<string>();
    for (const page of value.pages) {
      exactObject(page, ['path', 'content']);
      if (typeof page.path !== 'string' || !/^(observations\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9_-]+|feedback\/[a-zA-Z0-9_-]+|patterns\/\d{4}-\d{2}-\d{2}-daily-review)\.md$/.test(page.path) || seen.has(page.path) || typeof page.content !== 'string' || Buffer.byteLength(page.content) > 64 * 1024) throw new Error('invalid_page');
      seen.add(page.path);
    }
  } else if (value.pages !== undefined) throw new Error('invalid_scope');
  // Canonical field order binds replay regardless of JSON object key order.
  return { id: value.id, sequence: Number(value.sequence), action: value.action as NativeAction,
    ...(value.reconciliation ? { reconciliation: { generation: Number(value.reconciliation.generation), revision: String(value.reconciliation.revision) } } : {}),
    ...(value.pages ? { pages: (value.pages as NativePage[]).map(p => ({ path: p.path, content: p.content })) } : {}) };
}
export function validateInference(value: unknown): { model: string; effort: string; prompt: string } {
  exactObject(value, ['model', 'effort', 'prompt']);
  if (!(value.model === 'gpt-5.6-luna' && value.effort === 'low' || value.model === 'gpt-5.6-sol' && value.effort === 'high')) throw new Error('unsupported_native_model');
  if (typeof value.prompt !== 'string' || !value.prompt || Buffer.byteLength(value.prompt) > NATIVE_LIMITS.prompt) throw new Error('invalid_prompt');
  return { model: value.model as string, effort: value.effort as string, prompt: value.prompt };
}
export function validateResult(value: unknown): NativeResult {
  exactObject(value, ['text', 'inputTokens', 'outputTokens', 'cachedTokens']);
  if (typeof value.text !== 'string' || !value.text || Buffer.byteLength(value.text) > NATIVE_LIMITS.result) throw new Error('invalid_result');
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens']) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new Error('invalid_usage');
  return { text: value.text, inputTokens: Number(value.inputTokens), outputTokens: Number(value.outputTokens), cachedTokens: Number(value.cachedTokens) };
}
export const NATIVE_ROUTES: Record<string, NativeRole> = { submit: 'scheduler', status: 'scheduler', poll: 'executor', result: 'executor', infer: 'relay', inference: 'relay' };
