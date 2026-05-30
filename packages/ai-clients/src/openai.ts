/**
 * OpenAI GPT structured-output client.
 *
 * Mirrors the surface of `structuredClaude` in claude.ts so the orchestrator
 * stages don't care which provider is behind `structured()`. Selection is
 * controlled by LLM_PROVIDER:
 *
 *   LLM_PROVIDER=openai (or "gpt") → routes here
 *   LLM_PROVIDER=claude (default)  → routes to Anthropic
 *
 * Implementation notes:
 *   - Uses OpenAI's native JSON mode (`response_format: { type: 'json_object' }`),
 *     which guarantees parseable JSON. We still validate with the caller's Zod
 *     schema since JSON mode doesn't enforce shape — only validity.
 *   - The Claude prompts already instruct the model to output a single JSON
 *     object with literal field names; that instruction also works for GPT, so
 *     we just append a "respond with valid JSON" reminder.
 *   - System prompt caching: OpenAI auto-caches prompt prefixes longer than
 *     1024 tokens, so no explicit cache_control flag needed (Anthropic
 *     requires it; OpenAI doesn't).
 */
import OpenAI from 'openai';
import { z, type ZodTypeAny } from 'zod';
import { withRetry } from './retry.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? process.env.GPT_KEY,
});

// Logical model keys (shared with claude.ts) → concrete OpenAI model ids.
// Overridable via env so you can pin a specific revision without rebuilding.
const MODELS = {
  opus: process.env.OPENAI_MODEL_OPUS ?? 'gpt-4o',          // analyze + segment (heaviest)
  sonnet: process.env.OPENAI_MODEL_SONNET ?? 'gpt-4o',      // mid-tier
  haiku: process.env.OPENAI_MODEL_HAIKU ?? 'gpt-4o-mini',   // classify (per-scene, runs often)
} as const;
type ModelKey = keyof typeof MODELS;

interface StructuredOpts<TSchema extends ZodTypeAny> {
  model: ModelKey;
  system: string;
  user: string;
  schema: TSchema;
  maxTokens?: number;
  cacheSystem?: boolean; // accepted for API parity; not used on OpenAI
}

export async function structuredGpt<TSchema extends ZodTypeAny>(
  opts: StructuredOpts<TSchema>,
): Promise<z.infer<TSchema>> {
  const systemContent =
    opts.system +
    '\n\nRespond with a SINGLE valid JSON object matching the requested schema. No prose, no markdown fences, just JSON.';

  const call = async (extraHint?: string) =>
    withRetry(() =>
      openai.chat.completions.create({
        model: MODELS[opts.model],
        max_tokens: opts.maxTokens ?? 16_000,
        response_format: { type: 'json_object' },
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: opts.user + (extraHint ? `\n\n${extraHint}` : '') },
        ],
      }),
    );

  let resp = await call();
  let parsed = tryParse(resp);
  if (!parsed) {
    resp = await call('Your previous response was not valid JSON. Reply with a single JSON object.');
    parsed = tryParse(resp);
  }
  if (!parsed) throw new Error('OpenAI failed to produce parsable JSON twice');
  return opts.schema.parse(parsed);
}

function tryParse(resp: OpenAI.Chat.Completions.ChatCompletion): unknown | null {
  const text = resp.choices[0]?.message?.content ?? '';
  if (!text) return null;
  // JSON mode SHOULD always produce a valid JSON object, but be defensive in
  // case the model wraps it (e.g. ```json … ```).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fenced ? fenced[1] : text;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
