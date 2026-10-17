# Sales agent content engine

An AI agent writes marketing content for a sales agent (GreenTree / Kevin Hood first), emails it for approval, and publishes each piece the moment it's approved. Every sales agent you add later uses the same engine with its own profile file.

## How it works

1. **Generate.** Every Monday at 7am Pacific (or on demand), Claude writes a package: by default 3 Instagram posts, 1 LinkedIn post and 1 newsletter. The content is educational and trust-building, and each piece points to either the home valuation page or Kevin's Calendly.
2. **Approve.** Kevin gets one email listing the pieces, with one button. It opens a phone-friendly page that shows each piece exactly as it will be published, with two buttons:
   - **✓ Approve** publishes the piece right away.
   - **✕ Send back** (with an optional note) returns it to the reviewer.
   - **Approve all** handles the whole package in one tap.
3. **Revise.** The reviewer gets an email for each piece that's sent back. They can edit the text, have the AI rewrite it using Kevin's note, or discard it. A revision goes back to Kevin as a new one-piece package.

The links in the emails are signed and expire after 14 days, so nobody needs to log in. Opening a link only views the page; approving takes a button press, so email security scanners that open links can't approve anything by accident.

Code adds the following to every piece, so the AI can't get them wrong:
- the call-to-action line, with UTM tracking on the link
- the hashtags
- the DRE license footer

## Setup

```bash
npm install
cp .env.example .env   # fill in the values
npm start
```

**Required:**
- `ANTHROPIC_API_KEY`
- `LINK_SIGNING_SECRET`
- `ADMIN_API_KEY`
- `PUBLIC_BASE_URL`
- `GREENTREE_APPROVER_EMAIL` and `GREENTREE_REVIEWER_EMAIL`
- `GREENTREE_LICENSE_LINE`
- `GREENTREE_VALUATION_URL` and `GREENTREE_CALENDLY_URL`

**Email:** if `SMTP_HOST` is empty, emails are saved to `data/outbox/` instead of being sent, which is handy for trying things out.

**Publishing:** each channel posts its approved content to a webhook URL (`GREENTREE_WEBHOOK_*`). Point these at Zapier, Make or Buffer to post to Instagram, LinkedIn or Facebook, or to send the newsletter. If a webhook is empty, approvals are logged as a dry run and nothing is posted.

The webhook receives this JSON:

```json
{ "agentId": "greentree", "packageId": "...", "itemId": "...", "channel": "instagram",
  "subject": null, "text": "final caption", "ctaUrl": "https://...?utm_source=instagram...",
  "visual": "suggested image", "title": "internal title" }
```

**Market figures:** put current figures in `data/market-notes/greentree.md`, such as recent sales and days on market. The agent quotes numbers only from that file. Without it, the content stays qualitative.

## Running a package by hand

```bash
npm run generate -- greentree "Focus on Rancho Santa Fe this week"
# or
curl -X POST "$PUBLIC_BASE_URL/admin/agents/greentree/packages" \
  -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{"brief":"Focus on Rancho Santa Fe this week"}'
```

To see packages and their statuses: `GET /admin/packages?agentId=greentree` (same header).

## Adding a sales agent

1. Copy `agents/_template.js` to `agents/<id>.js`. Fill in the company, the approver and reviewer, the market, voice, topics, call-to-action URLs, channel mix, schedule and publishers.
2. Add that agent's variables to `.env`.
3. Restart the server. The new agent gets its own schedule, emails, review links and UTM tags.

## Notes

- Data is stored in `data/store.json`. That's fine for one server; move to a database when you run several machines.
- Tests: `npm test`.
- `Realestateagent2026.1.js` (the earlier lead categorizer) is not used by this engine.
