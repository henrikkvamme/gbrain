import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeControl } from '../../deploy/runtime/native-control';

test('runtime publishes only authenticated brain listeners on host loopback', () => {
  const config = Bun.YAML.parse(readFileSync(new URL('../../deploy/runtime/compose.yaml', import.meta.url), 'utf8')) as any;
  expect(config.services.brain.ports).toEqual(['127.0.0.1:3131:3131', '127.0.0.1:3133:3133']);
  expect(config.services.ollama.ports).toBeUndefined();
  expect(config.services.brain.network_mode).toBeUndefined();
  expect(config.services.brain.networks).toEqual(['brain-private']);
  const env = config.services.brain.environment;
  for (const flag of ['GBRAIN_ENABLE_SEAFILE', 'GBRAIN_ENABLE_GMAIL_APPLY', 'GBRAIN_ENABLE_NATIVE']) {
    expect(env[flag]).toBe(`\${${flag}:-false}`);
  }
  expect(env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN).toContain(':?');
  expect(env.GBRAIN_PUBLIC_URL).toContain(':?');
  expect(env.GBRAIN_NATIVE_SCHEDULER_TOKEN).toBe('${GBRAIN_NATIVE_SCHEDULER_TOKEN:-}');
  expect(env.GBRAIN_NATIVE_EXECUTOR_TOKEN).toBe('${GBRAIN_NATIVE_EXECUTOR_TOKEN:-}');
});

test('native private ingress still rejects absent or unknown credentials before parsing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ingress-auth-fixture-'));
  try {
    let executions = 0;
    const control = new NativeControl(join(root, 'state.json'), {
      brain: 'host', client: 'fixture-mac', scheduler: 's'.repeat(40),
      executor: 'e'.repeat(40), relay: 'r'.repeat(40),
    }, async () => { executions++; return {}; });
    for (const authorization of [undefined, 'Bearer unknown-fixture-token']) {
      const headers = authorization ? { authorization } : undefined;
      const response = await control.handle(new Request('https://server.example.ts.net:3133/native/v1/submit', {
        method: 'POST', headers, body: 'invalid json',
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'wrong_role' });
    }
    expect(executions).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
