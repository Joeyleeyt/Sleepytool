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
 *   - Uses OpenAI's **Structured Outputs** (strict JSON Schema) via
 *     `client.beta.chat.completions.parse()` + `zodResponseFormat()`. The
 *     model is forced to emit JSON that matches the Zod schema EXACTLY —
 *     enums, required fields, nested object shapes. Plain `json_object` mode
 *     only guarantees parseable JSON and would happily hallucinate enum
 *     values like `cameraMovement: "slow pan across the room"` even when
 *     the schema lists 13 specific allowed values.
 *   - `openaiStrictMode: true` (inside the helper) auto-converts `.optional()`
 *     fields to nullable+required and adds `additionalProperties: false`, so
 *     existing Zod schemas work without rewriting.
 *   - The caller's Zod schema still re-validates the result so refinements
 *     like `.min(3).max(20)` apply (strict mode honours structure, not
 *     numeric bounds).
 *   - System prompt caching: OpenAI auto-caches prompt prefixes longer than
 *     1024 tokens, so no explicit cache_control flag needed.
 */
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { withRetry } from './retry.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? process.env.GPT_KEY,
});

// Logical model keys (shared with claude.ts) → concrete OpenAI model ids.
// Overridable via env so you can pin a specific revision without rebuilding.
// Structured Outputs requires gpt-4o-2024-08-06+ or gpt-4o-mini-2024-07-18+;
// the unversioned aliases point at the latest stable in those families.
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

// GPT-4o caps total output at 16,384 tokens — sending more returns 400
// "max_tokens is too large" and silently kills the pipeline. Callers tuned
// for Claude (e.g. segment.ts passes 32k) get clamped here transparently.
const OPENAI_MAX_OUTPUT_TOKENS = 16_384;

export async function structuredGpt<TSchema extends ZodTypeAny>(
  opts: StructuredOpts<TSchema>,
): Promise<z.infer<TSchema>> {
  const systemContent = opts.system;
  const model = MODELS[opts.model];
  const maxTokens = Math.min(opts.maxTokens ?? 16_000, OPENAI_MAX_OUTPUT_TOKENS);

  const call = async (attempt: number, extraHint?: string) => {
    const started = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[openai.call] attempt=${attempt} model=${model} maxTokens=${maxTokens} ` +
        `system=${systemContent.length}ch user=${opts.user.length}ch strict=yes` +
        (extraHint ? ` retryHint=yes` : ''),
    );
    const resp = await withRetry(() =>
      openai.beta.chat.completions.parse({
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: opts.user + (extraHint ? `\n\n${extraHint}` : '') },
        ],
        response_format: zodResponseFormat(opts.schema, 'output'),
      }),
    );
    const elapsed = Date.now() - started;
    const usage = resp.usage;
    const msg = resp.choices[0]?.message;
    // eslint-disable-next-line no-console
    console.log(
      `[openai.resp] attempt=${attempt} ${elapsed}ms ` +
        `tokens=in:${usage?.prompt_tokens ?? '?'}/out:${usage?.completion_tokens ?? '?'} ` +
        `parsed=${msg?.parsed ? 'ok' : 'null'} finish=${resp.choices[0]?.finish_reason ?? '?'}` +
        (msg?.refusal ? ` refusal="${msg.refusal.slice(0, 80)}"` : ''),
    );
    return resp;
  };

  let resp = await call(1);
  let parsed = resp.choices[0]?.message?.parsed;
  let refusal = resp.choices[0]?.message?.refusal;

  // Detect the "hit the cap" case explicitly — both retrying with the same
  // cap and reporting "no parsed object" are useless when the model literally
  // ran out of tokens. Surface a clear error instead.
  if (!parsed && resp.choices[0]?.finish_reason === 'length') {
    throw new Error(
      `OpenAI output truncated at max_tokens=${maxTokens} (model=${model}). ` +
        `Reduce the per-call schema size, split the input, or pin a model with a larger output window.`,
    );
  }

  if (!parsed && !refusal) {
    // Rare: model returned no text and didn't hit length — retry once.
    // eslint-disable-next-line no-console
    console.warn('[openai.parse] attempt 1 produced no parsed output — retrying');
    resp = await call(2, 'Your previous response was incomplete. Emit the full JSON object now.');
    parsed = resp.choices[0]?.message?.parsed;
    refusal = resp.choices[0]?.message?.refusal;
    if (!parsed && resp.choices[0]?.finish_reason === 'length') {
      throw new Error(
        `OpenAI output truncated at max_tokens=${maxTokens} on retry (model=${model}).`,
      );
    }
  }

  if (refusal) {
    // eslint-disable-next-line no-console
    console.error('[openai.parse] model refused:', refusal);
    throw new Error(`OpenAI refused the request: ${refusal}`);
  }
  if (!parsed) throw new Error('OpenAI Structured Outputs returned no parsed object');

  // `parsed` is already schema-validated by the helper, but OpenAI strict mode
  // only enforces JSON-Schema structure (enums, required fields, types) — not
  // Zod refinements like `.min(3).max(20)`. Re-run through the caller's schema
  // here; on ZodError, give the model ONE focused retry with a hint that names
  // the invalid paths, so a single out-of-range field doesn't kill the stage.
  try {
    const validated = opts.schema.parse(parsed);
    // eslint-disable-next-line no-console
    console.log('[openai.parse] ok — schema validated');
    return validated;
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    const hint = formatZodHint(err);
    // eslint-disable-next-line no-console
    console.warn(`[openai.parse] refinement failure — retrying. ${hint}`);
    const retry = await call(2, hint);
    const retryParsed = retry.choices[0]?.message?.parsed;
    if (!retryParsed) {
      throw new Error(`OpenAI retry produced no parsed object. Original validation error: ${err.message}`);
    }
    try {
      const validated = opts.schema.parse(retryParsed);
      // eslint-disable-next-line no-console
      console.log('[openai.parse] ok — schema validated on retry');
      return validated;
    } catch (err2) {
      // eslint-disable-next-line no-console
      console.error('[openai.parse] schema validation failed twice:', (err2 as Error).message);
      throw err2;
    }
  }
}

function formatZodHint(err: ZodError): string {
  const issues = err.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return `Your previous response failed validation:\n${issues.join('\n')}\nFix these fields and emit the full JSON object.`;
}
