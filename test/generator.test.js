import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { createGenerator } from '../src/content/generator.js';
import { agent, draft } from './helpers.js';

// Runs the real SDK against a fake HTTP response to check the request shape and parsing.
function fakeClient(output, { stopReason = 'end_turn' } = {}) {
  const requests = [];
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(output) }],
          stop_reason: stopReason,
          stop_details: stopReason === 'refusal' ? { type: 'refusal', category: 'general_harms', explanation: '' } : null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { client, requests };
}

test('generate sends a structured-output request and keeps only requested channels', async () => {
  const { client, requests } = fakeClient({
    theme: 'Coastal estates',
    items: [draft({ channel: 'instagram' }), draft(), draft({ channel: 'newsletter', subject: 'Hi' })],
  });
  const generator = createGenerator({ client, model: 'claude-opus-5-5' });
  const result = await generator.generate({ agent, brief: 'Del Mar focus', recentTitles: ['Old post'] });

  assert.equal(result.theme, 'Coastal estates');
  assert.deepEqual(result.items.map((i) => i.channel), ['instagram', 'linkedin']);

  const { body } = requests[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(body.messages[0].content, /Del Mar focus/);
  assert.match(body.messages[0].content, /Old post/);
  assert.match(body.messages[0].content, /do not quote figures/);
});

test('a refusal raises instead of returning content', async () => {
  const { client } = fakeClient({ theme: 'x', items: [] }, { stopReason: 'refusal' });
  const generator = createGenerator({ client, model: 'claude-opus-5-5' });
  await assert.rejects(generator.generate({ agent }), /declined/);
});
