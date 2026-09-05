import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic();

const LeadCategorySchema = z.object({
  status: z.enum(['Hot', 'Warm', 'Cold', 'New']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const SYSTEM_PROMPT = `You categorize inbound real estate leads for Kevin Hood, a luxury real estate broker at Green Tree Properties working Orange County and North San Diego County, CA (typical listings $1.5M-$6M).

Assign exactly one status:
- Hot: strong buying/selling intent, ready timeline, price range fits the target market, clear urgency or specific property interest.
- Warm: genuine interest but a longer timeline, vague budget, or missing details that reduce urgency.
- Cold: low intent, budget far outside the target market, or vague/generic inquiry with no clear next step.
- New: too little information yet to judge intent either way.

Base your judgment only on the information provided.`;

app.post('/api/categorize-lead', async (req, res) => {
  const { name, interest, priceRange, location, source, notes } = req.body ?? {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Lead name is required.' });
  }

  const leadSummary = [
    `Name: ${name}`,
    `Interest: ${interest || 'unspecified'}`,
    `Price range: ${priceRange || 'unspecified'}`,
    `Location: ${location || 'unspecified'}`,
    `Source: ${source || 'unspecified'}`,
    `Notes: ${notes || 'none'}`,
  ].join('\n');

  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Categorize this lead:\n\n${leadSummary}` }],
      output_format: betaZodOutputFormat(LeadCategorySchema),
    });

    if (!response.parsed_output) {
      return res.status(502).json({ error: 'Model response could not be parsed.' });
    }

    res.json(response.parsed_output);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('Anthropic authentication error:', error.message);
      return res.status(500).json({ error: 'Server is missing a valid ANTHROPIC_API_KEY.' });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limited, please try again shortly.' });
    }
    if (error instanceof Anthropic.APIError) {
      console.error('Anthropic API error:', error.status, error.message);
      return res.status(502).json({ error: 'The categorization service failed.' });
    }
    console.error('Unexpected error categorizing lead:', error);
    res.status(500).json({ error: 'Unexpected server error.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GreenTree AI agent server listening on http://localhost:${PORT}`);
});
