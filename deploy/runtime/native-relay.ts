import { NATIVE_LIMITS, validateResult } from './native-protocol';

/** CLI-compatible inference relay, not a Codex installation or arbitrary command. */
export async function relayCodex(args: string[], prompt: string, call: (op: string, value: Record<string, unknown>) => Promise<any>) {
  const expected = ['--ask-for-approval', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', args[10], '--config', args[12], '--json', '-'];
  // Gateway argv positions are fixed; accept no schema, output path, workspace or tool options.
  const actualModel = args[10], actualEffort = args[12]?.match(/^model_reasoning_effort="(low|high)"$/)?.[1];
  if (JSON.stringify(args) !== JSON.stringify(expected) || !actualEffort || !(actualModel === 'gpt-5.6-luna' && actualEffort === 'low' || actualModel === 'gpt-5.6-sol' && actualEffort === 'high')) throw new Error('unsupported_native_invocation');
  const { request } = await call('infer', { request: { model: actualModel, effort: actualEffort, prompt } });
  while (Date.now() < request.expires) {
    const response = await call('inference', { request: request.id, digest: request.digest });
    if (response.result) {
      const result = validateResult(response.result);
      return [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: result.text } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cached_input_tokens: result.cachedTokens } })].join('\n') + '\n';
    }
    await Bun.sleep(100);
  }
  throw new Error('native_inference_timeout');
}

if (import.meta.main) {
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of Bun.stdin.stream()) { size += chunk.length; if (size > NATIVE_LIMITS.prompt) throw new Error('invalid_prompt'); chunks.push(chunk); }
    const body = { brain: process.env.GBRAIN_NATIVE_BRAIN, client: process.env.GBRAIN_NATIVE_CLIENT, id: process.env.GBRAIN_NATIVE_RUN, epoch: process.env.GBRAIN_NATIVE_EPOCH };
    const call = async (op: string, value: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:3133/native/v1/${op}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.GBRAIN_NATIVE_RELAY_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...value }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('native_relay_rejected');
      return response.json();
    };
    process.stdout.write(await relayCodex(Bun.argv.slice(2), Buffer.concat(chunks).toString('utf8'), call));
  } catch { console.error('native inference unavailable'); process.exit(1); }
}
