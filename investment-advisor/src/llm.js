import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

export const DEFAULT_MODEL = process.env.ADVISOR_MODEL || 'claude-opus-5-5';

let defaultClient;
function getClient() {
  defaultClient ??= new Anthropic();
  return defaultClient;
}

/**
 * Run one Claude request whose answer must match `schema` (a Zod object).
 * Streams so long analyses never hit the SDK's non-streaming timeout, and opts
 * into server-side refusal fallbacks so a policy decline is retried on
 * Anthropic's recommended fallback model instead of failing the run.
 */
export async function callStructured({ system, prompt, schema, effort = 'medium', maxTokens = 64000, client }) {
  const anthropic = client ?? getClient();
  const stream = anthropic.beta.messages.stream({
    model: DEFAULT_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'unspecified';
    throw new Error(`Claude declined this request (category: ${category}).`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Claude hit the max_tokens limit before finishing; reduce the batch size.');
  }
  if (!message.parsed_output) {
    throw new Error('Claude response could not be parsed against the expected schema.');
  }
  return message.parsed_output;
}

export function describeApiError(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'Missing or invalid ANTHROPIC_API_KEY.';
  if (error instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API; try again shortly.';
  if (error instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API.';
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status}: ${error.message}`;
  return error?.message ?? String(error);
}
