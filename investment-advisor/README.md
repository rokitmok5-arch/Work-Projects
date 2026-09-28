# Investment Advisor Agent

An AI research agent that reads recent reporting from **BBC, Al Jazeera, Business Insider, Forbes, The New York Times, The Wall Street Journal and the Associated Press**, covering both their business and their world and politics news. It connects global events to what is actually moving across markets, cross-references everything into a consensus, and produces a ranked brief of **10–20 stocks, ETFs, crypto assets and commodities** fitted to your investor profile.

The central idea: markets react to world events (conflicts, elections, sanctions, central bank moves, supply shocks) long before those events show up as stock tips. Most investors read world news and market data separately. This agent links them.

> **Not financial advice.** The output is automated research from headlines and public prices. News signals can be wrong or already priced in. Verify independently and consult a licensed advisor before investing.

## How it works

```
                          ┌─▶ Claude: per-article signals ──────────────┐
 7 outlets, business  ────┤   (ticker, bullish/bearish, strength)       ├─▶ Cross-outlet ──▶ Live market data ──▶ Claude: ranked
 + world + politics       └─▶ Claude: global events ────────────────────┘    consensus        for candidates,       10–20 picks,
 (last 72h, RSS)              (clustered across outlets, each traced                           event assets and      causal chains,
                              to the assets it moves, 1st/2nd/3rd order)                       ~55-instrument map    allocations
                                                                               │
                                              event → asset: reacting / not yet reflected / diverging
                                              market map: which sectors, regions, currencies, commodities are moving unusually
```

1. **Collect** (`src/news.js`): pulls each outlet's business, world and politics RSS feeds (`config/sources.json`) from the last 72 hours. It takes articles evenly from each feed so world coverage isn't crowded out by business stories. If an outlet's feeds fail, it falls back to Google News searches restricted to that site. AP has no official RSS, so it always uses those searches. For BBC and Al Jazeera, which have no hard paywall, it also fetches the article text. For the paywalled outlets it uses the headline and summary only.
2. **Extract signals** (`src/extract.js`): Claude reads the articles in batches and returns ticker-level signals: asset, direction, strength, and whether the article names the asset or it's an inferred effect.
3. **Map global events** (`src/events.js`): at the same time, Claude groups all headlines into real-world events, merging each event's coverage across outlets. It traces each event through its **transmission channels**: first-order effects (a Gulf conflict moves crude oil), then second- and third-order effects through supply chains, currencies, rates, trade flows, defense budgets and regional economies. Each channel becomes a signal from every outlet covering the event. That's how a story that only ran as world news can still produce a pick.
4. **Cross-reference** (`src/aggregate.js`): groups all signals by ticker. Assets need at least **2 independent outlets** agreeing to become candidates. Agreement across outlets outweighs raw mention count, and inferred effects count for 60% of a direct mention.
5. **Read the market** (`src/market.js`): fetches a year of daily prices from Yahoo Finance's public chart endpoint (no key needed) for:
   - **each candidate**: trend, momentum, RSI, volatility, volume, and whether the price confirms the news.
   - **each event's affected assets**: how far the asset has moved since the event entered the news, relative to its normal volatility. Each link is labeled *reacting* (moved as expected, likely being priced in), *not yet reflected* (the market may be lagging the news), or *diverging* (moving the other way, so something else dominates).
   - **a market map of ~55 instruments**: US sectors, country and region ETFs, rates and credit, currencies, commodities, crypto and the VIX. It flags **unusually large moves** (1.5+ standard deviations for that instrument) so the advisor can ask which events explain them, and which moves no reported event explains.
6. **Advise** (`src/advise.js`): Claude receives the events, market map, candidates and your profile. It explains how events connect to market moves and ranks the picks by corroboration, causal clarity and market confirmation. Each pick gets its **causal chain** (event → mechanism → asset), action, conviction, allocation, risks and entry guidance. Any ticker that wasn't among the analyzed candidates is discarded.

## Setup

```bash
cd investment-advisor
npm install
cp .env.example .env                   # add your ANTHROPIC_API_KEY
cp profile.example.json profile.json   # edit to describe yourself
```

Edit `profile.json`: risk tolerance, horizon, amount, preferred asset classes, crypto cap, excluded symbols/sectors, and current holdings. The advisor sizes and filters recommendations against it.

## Usage

**Command line**

```bash
npm run advise                       # full run, prints the brief and saves it to reports/
npm run advise -- --hours 48 --picks 12-15 --min-sources 3
npm run advise -- --profile ./my-aggressive-profile.json
```

**Web dashboard and API**

```bash
npm start                            # http://localhost:3002
```

| Endpoint | Description |
|---|---|
| `POST /api/run` | Start a run in the background (`{ "profile": {...}, "lookbackHours": 48 }`, both optional). Returns 202. |
| `GET /api/status` | Current run stage: `news` → `analyze` → `consensus` → `market` → `advise` → `done`. |
| `GET /api/report/latest` | Latest report as JSON. |
| `GET /api/report/latest.md` | Latest report as Markdown. |

Set `ADVISOR_REFRESH_HOURS=24` to have the server refresh the analysis automatically.

A run takes a few minutes. It makes roughly one Claude call per 30 articles, one event-mapping call and one final call. With ~400 articles on `claude-opus-5-5`, expect roughly $2–4 per run. Set `ADVISOR_MODEL` to use a different model.

## Configuration

- **`config/sources.json`**: feeds per outlet, the Google News fallback queries, whether to fetch full text, and the market map (add any sector, country, currency or commodity you want watched). Publishers change feed URLs from time to time. If an outlet shows 0 articles or a fallback note in the report's *Source coverage* table, update its feed URL here.
- **Consensus threshold**: `--min-sources` (default 2). Raise it for stricter cross-referencing. If too few assets qualify, the list is topped up with single-outlet names, and Claude sees each one's outlet count.

## Tests

```bash
npm test
```

The tests run fully offline. They cover feed parsing, balancing and fallback, the technical indicators, the market map, event signal and reaction measurement, the consensus scoring, and an end-to-end pipeline run. In that run, a world-news-only story reaches the picks through the event map. That run uses fake feeds, fake market data and a stubbed Claude client, and validates every stubbed response against the real output schemas.

## Limitations

- Headlines and summaries from paywalled outlets carry less detail than full articles. The agent reads only what the publishers make available in their feeds.
- Yahoo Finance's chart endpoint is unofficial and rate-limited. For production use, swap `fetchQuote` in `src/market.js` for a licensed data provider.
- An event's "move since" is measured from when it entered the 72-hour news window, not from when the underlying situation began. Long-running stories may already be priced in.
- News-driven signals can be wrong or already priced in. The market check reduces that risk but doesn't remove it. Nothing here accounts for your taxes, liquidity needs or full financial picture.
