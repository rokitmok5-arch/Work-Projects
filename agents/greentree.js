// GreenTree / Kevin Hood content agent.
// Copy agents/_template.js to create a new sales agent; see README.md.

const env = process.env;

export default {
  id: 'greentree',
  company: 'Green Tree Properties',
  agentName: 'Kevin Hood',
  agentTitle: 'Luxury Real Estate Broker',

  // Kevin approves; returned items go to the reviewer.
  approver: { name: 'Kevin', email: env.GREENTREE_APPROVER_EMAIL },
  reviewer: { name: 'GreenTree marketing', email: env.GREENTREE_REVIEWER_EMAIL },

  // Appended to every published piece (California DRE advertising requirement).
  complianceFooter: env.GREENTREE_LICENSE_LINE || 'Kevin Hood | Green Tree Properties | DRE #00000000',

  market: 'Orange County and North San Diego County, California. Typical listings $1.5M-$6M.',
  neighborhoods: [
    'Newport Coast', 'Corona del Mar', 'Laguna Beach', 'Dana Point', 'San Clemente',
    'Rancho Santa Fe', 'Del Mar', 'Carlsbad', 'Encinitas', 'Solana Beach',
  ],
  audience:
    'Affluent homeowners, buyers and relocating executives; second-home buyers; their CPAs, estate attorneys and wealth advisors.',
  voice:
    'Calm, discreet, knowledgeable and warm. A trusted advisor, never a salesperson. Plain language, no hype, no exclamation-mark marketing.',

  // Educational themes that build trust with high-net-worth clients.
  topics: [
    'Hyperlocal neighborhood market perspective',
    'What drives value for luxury homes on the coast',
    'Tax considerations when buying or selling a high-value home in California',
    'Estate and legacy planning with real estate (trusts, inheritance, timing)',
    'Second-home ownership and lifestyle relocation',
    'Privacy and security for high-profile homeowners',
    'Zoning, land use and renovation potential',
    'Real estate as part of a diversified portfolio',
    'Behind the scenes: how Kevin prepares and markets a luxury listing',
    'Client stories and referrals (no names without permission)',
  ],

  ctas: {
    valuation: {
      label: 'Request a private home valuation',
      url: env.GREENTREE_VALUATION_URL || 'https://greentreeproperties.com/home-valuation',
    },
    consultation: {
      label: 'Book a private consultation with Kevin',
      url: env.GREENTREE_CALENDLY_URL || 'https://calendly.com/kevinhood/consultation',
    },
  },

  // Pieces per package, by channel. Channels with 0 are skipped.
  mix: { instagram: 3, facebook: 0, linkedin: 1, newsletter: 1 },

  // Monday 7:00am Pacific.
  schedule: { cron: '0 7 * * 1', timezone: 'America/Los_Angeles' },

  // Where approved content is sent. An empty url means dry-run (logged, not posted).
  publishers: {
    instagram: { type: 'webhook', url: env.GREENTREE_WEBHOOK_INSTAGRAM },
    facebook: { type: 'webhook', url: env.GREENTREE_WEBHOOK_FACEBOOK },
    linkedin: { type: 'webhook', url: env.GREENTREE_WEBHOOK_LINKEDIN },
    newsletter: { type: 'webhook', url: env.GREENTREE_WEBHOOK_NEWSLETTER },
  },

  // Optional: current market figures the agent may quote. Without them it stays qualitative.
  marketNotesFile: 'data/market-notes/greentree.md',

  extraRules: [
    'Never promise or predict prices, appreciation or returns.',
    'Never give tax or legal advice; frame these topics as questions to raise with a CPA or attorney.',
  ],
};
