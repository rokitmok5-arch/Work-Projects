// Template for a new sales agent.
// 1. Copy this file to agents/<id>.js (files starting with "_" are ignored).
// 2. Fill in every field and add the matching variables to .env.
// 3. Restart the server. The agent gets its own schedule, emails and review links.

const env = process.env;

export default {
  id: 'example', // lowercase, used in URLs and UTM tags
  company: 'Example Realty',
  agentName: 'Jane Doe',
  agentTitle: 'Real Estate Agent',

  approver: { name: 'Jane', email: env.EXAMPLE_APPROVER_EMAIL },
  reviewer: { name: 'Marketing team', email: env.EXAMPLE_REVIEWER_EMAIL },

  complianceFooter: env.EXAMPLE_LICENSE_LINE || 'Jane Doe | Example Realty | DRE #00000000',

  market: 'Where the agent works and the typical price range.',
  neighborhoods: [],
  audience: 'Who the content is for.',
  voice: 'How the content should sound.',
  topics: [],

  ctas: {
    valuation: { label: 'Request a home valuation', url: env.EXAMPLE_VALUATION_URL },
    consultation: { label: 'Book a consultation', url: env.EXAMPLE_CALENDLY_URL },
  },

  mix: { instagram: 3, facebook: 0, linkedin: 1, newsletter: 1 },
  schedule: { cron: '0 7 * * 1', timezone: 'America/Los_Angeles' },

  publishers: {
    instagram: { type: 'webhook', url: env.EXAMPLE_WEBHOOK_INSTAGRAM },
    facebook: { type: 'webhook', url: env.EXAMPLE_WEBHOOK_FACEBOOK },
    linkedin: { type: 'webhook', url: env.EXAMPLE_WEBHOOK_LINKEDIN },
    newsletter: { type: 'webhook', url: env.EXAMPLE_WEBHOOK_NEWSLETTER },
  },

  marketNotesFile: 'data/market-notes/example.md',
  extraRules: [],
};
