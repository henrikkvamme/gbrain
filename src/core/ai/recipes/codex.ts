import type { Recipe } from '../types.ts';

/**
 * Codex CLI backed chat using the operator's existing Codex login.
 *
 * This is deliberately text-only. GBrain's durable tool loop has stricter
 * replay semantics than a nested Codex run can provide, while dream phases
 * only need structured text generation through gateway.chat().
 */
export const codex: Recipe = {
  id: 'codex',
  name: 'Codex CLI (subscription auth)',
  tier: 'native',
  implementation: 'codex-cli',
  auth_env: {
    required: [],
    optional: ['GBRAIN_CODEX_BIN', 'CODEX_HOME'],
    setup_url: 'https://developers.openai.com/codex/auth/',
  },
  touchpoints: {
    chat: {
      models: [
        'gpt-5.6-luna@low',
        'gpt-5.6-sol@high',
      ],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      // Subscription-backed runs have no gateway-level metered USD price.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-17',
    },
  },
  setup_hint:
    'Run `codex login`, verify `codex login status`, and optionally set GBRAIN_CODEX_BIN to a sandboxed Codex wrapper.',
};
