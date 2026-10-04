import { expect, test } from 'bun:test';
import { assertNativeMaintenanceInference } from '../../src/core/ai/native-maintenance-policy';

test('native confinement rejects other providers, models and tool loops without rewriting config', () => {
  const old = process.env.GBRAIN_NATIVE_MAINTENANCE;
  process.env.GBRAIN_NATIVE_MAINTENANCE = '1';
  try {
    assertNativeMaintenanceInference('chat', 'codex:gpt-5.6-sol@high');
    assertNativeMaintenanceInference('chat', 'codex:gpt-5.6-luna@low');
    for (const kind of ['tools', 'expansion', 'ocr'] as const) expect(() => assertNativeMaintenanceInference(kind)).toThrow('unsupported');
    expect(() => assertNativeMaintenanceInference('chat', 'anthropic:claude-sonnet-4-6')).toThrow('unsupported');
    expect(() => assertNativeMaintenanceInference('chat', 'codex:gpt-5.6-sol@low')).toThrow('unsupported');
  } finally { if (old === undefined) delete process.env.GBRAIN_NATIVE_MAINTENANCE; else process.env.GBRAIN_NATIVE_MAINTENANCE = old; }
});
