/**
 * Codex CLI chat provider contract.
 *
 * SERIAL: configureGateway() is process-global and these tests exercise the
 * real subprocess boundary through a temporary fake Codex executable.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  chat,
  configureGateway,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

async function makeFakeCodex(): Promise<{ bin: string; record: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gbrain-codex-provider-'));
  const bin = join(dir, 'codex-fixture');
  const record = join(dir, 'invocation.json');
  await Bun.write(bin, `#!${process.execPath}
const args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
await Bun.write(process.env.CODEX_ADAPTER_TEST_RECORD, JSON.stringify({ args, prompt }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item-0', type: 'agent_message', text: 'fixture response' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 321, cached_input_tokens: 123, output_tokens: 45, reasoning_output_tokens: 6 } }));
`);
  await chmod(bin, 0o755);
  return { bin, record };
}

afterEach(() => resetGateway());

describe('Codex CLI provider', () => {
  test('is registered as subscription-auth chat without an API key', () => {
    const recipe = getRecipe('codex');
    expect(recipe).toBeDefined();
    expect(recipe?.implementation).toBe('codex-cli');
    expect(recipe?.auth_env?.required).toEqual([]);
    expect(recipe?.touchpoints.chat?.supports_tools).toBe(false);

    configureGateway({
      chat_model: 'codex:gpt-5.6-sol@high',
      env: {},
    });
    expect(isAvailable('chat')).toBe(true);
  });

  test('invokes Codex with model, effort, transcript, and usage round-trip', async () => {
    const fixture = await makeFakeCodex();
    configureGateway({
      chat_model: 'codex:gpt-5.6-sol@high',
      env: {
        GBRAIN_CODEX_BIN: fixture.bin,
        CODEX_ADAPTER_TEST_RECORD: fixture.record,
      },
    });

    const result = await chat({
      system: 'Follow the private brain synthesis policy.',
      messages: [
        { role: 'user', content: 'Synthesize the recent observations.' },
        { role: 'assistant', content: 'I need one more detail.' },
        { role: 'user', content: 'Prefer durable workflow improvements.' },
      ],
      maxTokens: 700,
    });

    const invocation = JSON.parse(await readFile(fixture.record, 'utf8')) as {
      args: string[];
      prompt: string;
    };
    expect(invocation.args).toContain('--ask-for-approval');
    expect(invocation.args).toContain('never');
    expect(invocation.args).toContain('--ephemeral');
    expect(invocation.args).toContain('--ignore-user-config');
    expect(invocation.args).toContain('--ignore-rules');
    expect(invocation.args).toContain('--sandbox');
    expect(invocation.args).toContain('read-only');
    expect(invocation.args).toContain('--model');
    expect(invocation.args).toContain('gpt-5.6-sol');
    expect(invocation.args).toContain('model_reasoning_effort="high"');
    expect(invocation.prompt).toContain('Follow the private brain synthesis policy.');
    expect(invocation.prompt).toContain('Synthesize the recent observations.');
    expect(invocation.prompt).toContain('Prefer durable workflow improvements.');

    expect(result).toMatchObject({
      text: 'fixture response',
      blocks: [{ type: 'text', text: 'fixture response' }],
      stopReason: 'end',
      model: 'codex:gpt-5.6-sol@high',
      providerId: 'codex',
      usage: {
        input_tokens: 321,
        output_tokens: 45,
        cache_read_tokens: 123,
        cache_creation_tokens: 0,
      },
    });
  });

  test('fails closed when tools are requested', async () => {
    const fixture = await makeFakeCodex();
    configureGateway({
      chat_model: 'codex:gpt-5.6-luna@low',
      env: {
        GBRAIN_CODEX_BIN: fixture.bin,
        CODEX_ADAPTER_TEST_RECORD: fixture.record,
      },
    });

    await expect(chat({
      messages: [{ role: 'user', content: 'Call a tool.' }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
    })).rejects.toThrow('does not support GBrain tool calls');
  });
});
