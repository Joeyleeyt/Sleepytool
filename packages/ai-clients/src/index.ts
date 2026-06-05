export * from './retry.js';
export * from './veo3.js';
export * from './labs69.js';
export * from './keyManager.js';
// Re-export Claude surface area EXCEPT `structured` — the local `structured`
// below routes between Claude and OpenAI based on LLM_PROVIDER.
export { claude, MODELS, type ModelKey } from './claude.js';
export { structuredGpt } from './openai.js';

import { structured as structuredClaude } from './claude.js';
import { structuredGpt as _structuredGpt } from './openai.js';

/**
 * Provider router for the LLM "structured output" call.
 *
 *   LLM_PROVIDER=gpt|openai  → OpenAI (gpt-4o family) via structuredGpt
 *   LLM_PROVIDER=claude      → Anthropic Claude (default)
 *   LLM_PROVIDER=none        → handled upstream; the orchestrator never reaches here
 *
 * Without this router every stage would call Claude regardless of LLM_PROVIDER,
 * which silently broke `LLM_PROVIDER=gpt` setups that had no Anthropic key.
 */
export const structured: typeof structuredClaude = (opts) => {
  const provider = (process.env.LLM_PROVIDER ?? 'claude').toLowerCase();
  // 'none' = labs-only / no-LLM mode. The orchestrator gates LLM stages on
  // this value and routes to deterministicSegmentStage instead. If structured()
  // is called anyway (a new stage that forgot the gate, a replay endpoint,
  // etc.) we must NOT silently fall through to Claude — that would hit
  // Anthropic without an API key and surface as a misleading 401.
  if (provider === 'none') {
    throw new Error(
      "structured() called with LLM_PROVIDER='none'. This mode disables LLM calls; " +
        'route through the deterministic stage instead, or set LLM_PROVIDER=claude|gpt.',
    );
  }
  const target = provider === 'gpt' || provider === 'openai' ? 'openai' : 'claude';
  // eslint-disable-next-line no-console
  console.log(
    `[llm.router] provider=${provider} → ${target} model=${opts.model} ` +
      `system=${opts.system.length}ch user=${opts.user.length}ch ` +
      `maxTokens=${opts.maxTokens ?? 'default'}`,
  );
  if (target === 'openai') return _structuredGpt(opts);
  return structuredClaude(opts);
};
