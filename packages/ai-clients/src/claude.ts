import Anthropic from '@anthropic-ai/sdk';
import { z, type ZodTypeAny } from 'zod';
import { withRetry } from './retry.js';

export const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODELS = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
} as const;
export type ModelKey = keyof typeof MODELS;

interface StructuredOpts<TSchema extends ZodTypeAny> {
  model: ModelKey;
  system: string;
  user: string;
  schema: TSchema;
  maxTokens?: number;
  /** Pass system blocks as cache-controlled prefix. */
  cacheSystem?: boolean;
}

/**
 * Wrap Claude in a "structured output" pattern: tell the model to emit a JSON
 * object inside a <json>...</json> block, parse, and validate with zod.
 * Re-asks once on parse failure.
 */
export async function structured<TSchema extends ZodTypeAny>(
  opts: StructuredOpts<TSchema>,
): Promise<z.infer<TSchema>> {
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: opts.system + '\n\nRespond ONLY with a single <json>...</json> block containing valid JSON matching the requested schema. No prose outside the block.',
      ...(opts.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
    },
  ];

  const call = async (extraHint?: string) =>
    withRetry(() =>
      claude.messages.create({
        model: MODELS[opts.model],
        max_tokens: opts.maxTokens ?? 16_000,
        system: systemBlocks,
        messages: [{ role: 'user', content: opts.user + (extraHint ? `\n\n${extraHint}` : '') }],
      }),
    );

  let resp = await call();
  let parsed = tryParse(resp);
  if (!parsed) {
    resp = await call('Your previous response was not valid JSON inside a <json> block. Try again.');
    parsed = tryParse(resp);
  }
  if (!parsed) throw new Error('Claude failed to produce parsable JSON twice');
  return opts.schema.parse(parsed);
}

function tryParse(resp: Anthropic.Message): unknown | null {
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const match = text.match(/<json>([\s\S]*?)<\/json>/);
  const raw = match ? match[1] : text;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
