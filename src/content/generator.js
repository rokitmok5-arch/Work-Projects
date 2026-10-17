import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const CHANNELS = ['instagram', 'facebook', 'linkedin', 'newsletter'];

export const DraftSchema = z.object({
  channel: z.enum(CHANNELS),
  title: z.string().describe('Short internal label shown to the approver, e.g. "Del Mar: what drives ocean-view premiums".'),
  subject: z.string().nullable().describe('Email subject line for newsletter pieces; null for social posts.'),
  body: z.string().describe('The post or newsletter text, ready to publish. No links, hashtags, CTA line or license footer; those are added automatically.'),
  hashtags: z.array(z.string()).describe('3-8 hashtags without the # sign for instagram/facebook/linkedin; empty for newsletter.'),
  cta: z.enum(['valuation', 'consultation']).describe('Which page this piece should send readers to.'),
  visual: z.string().describe('One-sentence suggestion for the photo or video to pair with this piece.'),
  why: z.string().describe('One sentence telling the approver why this piece is worth posting.'),
});

const PackageSchema = z.object({
  theme: z.string().describe('One line describing the package, e.g. "Coastal second homes and trust ownership".'),
  items: z.array(DraftSchema),
});

const CHANNEL_GUIDE = {
  instagram: 'Instagram caption: 60-150 words, a strong first line, short paragraphs.',
  facebook: 'Facebook post: 60-150 words, conversational.',
  linkedin: 'LinkedIn post: 120-250 words, written for professionals and the advisors (CPAs, attorneys, wealth managers) who refer clients.',
  newsletter: 'Email newsletter: 250-450 words with a subject line, a warm opening, one useful idea explained well, and a soft close.',
};

function systemPrompt(agent) {
  return `You are the content marketing writer for ${agent.agentName}, ${agent.agentTitle} at ${agent.company}.

Market: ${agent.market}
Neighborhoods: ${agent.neighborhoods?.join(', ') || 'n/a'}
Audience: ${agent.audience}
Voice: ${agent.voice}

Strategy: affluent clients respond to trust, expertise and discretion, not sales pressure. Every piece should teach the reader something useful or show ${agent.agentName}'s local knowledge, so that they come to see ${agent.agentName} as a trusted advisor. Each piece points to exactly one next step: a private home valuation or a consultation, offered softly.

Rules:
- Use specific numbers (prices, percentages, days on market) only if they appear in the market notes you are given. Otherwise stay qualitative.
- Never invent clients, sales, testimonials or listings.
- Follow fair housing law: describe properties and places, never the people who should or shouldn't live there.
- Do not include URLs, hashtags inside the body, the call-to-action line or a license footer; the system adds those.
${(agent.extraRules ?? []).map((r) => `- ${r}`).join('\n')}`;
}

function checkResponse(response) {
  if (response.stop_reason === 'refusal') {
    throw new Error(`Content generation was declined (${response.stop_details?.category ?? 'no category'}).`);
  }
  if (!response.parsed_output) throw new Error('Content generation returned no parseable output.');
  return response.parsed_output;
}

export function createGenerator({ client = new Anthropic(), model }) {
  async function call(agent, content, schema) {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(agent),
      messages: [{ role: 'user', content }],
      output_config: { effort: 'high', format: betaZodOutputFormat(schema) },
    });
    return checkResponse(response);
  }

  async function generate({ agent, brief, marketNotes, recentTitles = [], today = new Date() }) {
    const mix = Object.entries(agent.mix).filter(([, n]) => n > 0);
    const request = `Write this week's content package (today is ${today.toDateString()}).

Pieces needed:
${mix.map(([channel, n]) => `- ${n} x ${channel}. ${CHANNEL_GUIDE[channel]}`).join('\n')}

Draw on these themes, varying them across the package:
${(agent.topics ?? []).map((t) => `- ${t}`).join('\n')}

Balance the calls to action: roughly half valuation, half consultation.
${brief ? `\nFocus for this week, from the marketing team:\n${brief}\n` : ''}
${marketNotes ? `\nMarket notes (the only source for specific figures):\n${marketNotes}\n` : '\nNo market notes this week, so do not quote figures.\n'}
${recentTitles.length ? `\nRecently used, do not repeat:\n${recentTitles.map((t) => `- ${t}`).join('\n')}` : ''}`;

    const result = await call(agent, request, PackageSchema);
    const wanted = new Set(mix.map(([channel]) => channel));
    return { theme: result.theme, items: result.items.filter((item) => wanted.has(item.channel)) };
  }

  async function revise({ agent, draft, note, marketNotes }) {
    const request = `${agent.approver.name} sent this ${draft.channel} piece back for changes.

Their note: ${note || '(no note given)'}

Original piece (JSON):
${JSON.stringify(draft, null, 2)}

Rewrite it to address the note. Keep the same channel. ${CHANNEL_GUIDE[draft.channel]}
${marketNotes ? `\nMarket notes (the only source for specific figures):\n${marketNotes}` : ''}`;
    return call(agent, request, DraftSchema);
  }

  return { generate, revise };
}
