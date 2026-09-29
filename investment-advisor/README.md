# Investment Advisor Agent

An AI research agent that reads recent reporting from **BBC, Al Jazeera, Business Insider, Forbes, The New York Times, The Wall Street Journal and the Associated Press**, covering both their business and their world and politics news. It connects global events to what is actually moving across markets, cross-references everything into a consensus, and produces a ranked brief of **10–20 stocks, ETFs, crypto assets and commodities** fitted to your investor profile.

The central idea: markets react to world events (conflicts, elections, sanctions, central bank moves, supply shocks) long before those events show up as stock tips, and often with a delay. Sentiment moves in days, but policy and physical effects take weeks or months to reach prices. A strait closure hits crude futures at once, then refiners, shippers, airlines and inflation over the following weeks. A tariff hits the named sector at once, then importers' costs, consumer prices and the targeted currency over weeks to months. The agent links world news to market data and **forecasts the moves still to come**, tracking each forecast until its window closes.

> **Not financial advice.** The output is automated research from headlines and public prices. News signals can be wrong or already priced in. Verify independently and consult a licensed advisor before investing.

## How it works

```
                          ┌─▶ Claude: per-article signals ──────────────────┐
 7 outlets, business  ────┤   (ticker, bullish/bearish, strength)           ├─▶ Cross-outlet consensus ──▶ Live market data ──▶ Claude: ranked
 + world + politics       └─▶ Claude: global events + forecasts ────────────┘   (wire copy = one voice)    for candidates,       10–20 picks with
 (last 72h, RSS)              (clustered across outlets, traced to assets,                                  event assets and      causal chains, timing,
 wire copy detected            each with lag, expected move, confidence)                                    ~55-instrument map    expected moves
                                          ▲                                                                        │
                                          │  event memory: tracked events and open forecasts                       ▼
                                          └──────────── carried between runs ◀──── forecast vs. actual move: ahead / underway / priced in /
                                                        and graded when due                                 diverging / not reacting
```

1. **Collect** (`src/news.js`): pulls each outlet's business, world and politics RSS feeds (`config/sources.json`) from the last 72 hours. It takes articles evenly from each feed so world coverage isn't crowded out by business stories. If an outlet's feeds fail, it falls back to Google News searches restricted to that site. AP has no official RSS, so it always uses those searches. For BBC and Al Jazeera, which have no hard paywall, it also fetches the article text. For the paywalled outlets it uses the headline and summary only.
2. **Detect wire copy** (`clusterStories` in `src/news.js`): outlets often republish the same AP or Reuters story. Articles with near-identical headlines or opening paragraphs are grouped into one story, and outlets sharing a story count as **one independent report**. Five outlets running one wire piece is not five confirmations.
3. **Extract signals** (`src/extract.js`): Claude reads the articles in batches and returns ticker-level signals: asset, direction, strength, and whether the article names the asset or it's an inferred effect.
4. **Map and forecast global events** (`src/events.js`): at the same time, Claude groups all headlines into real-world events and records each one's status: *proposed or threatened*, *announced*, *in effect*, *escalating*, *de-escalating* or *resolved*, plus the effective date when one is reported. It traces each event to the assets it moves, first- through third-order. For each, it forecasts **when** the effect should land (days, weeks, months, 6+ months), **how big** the total move should be, how confident it is, and which **leading indicators** would show the effect arriving or fading.
5. **Cross-reference** (`src/aggregate.js`): groups all signals by ticker. Assets need at least **2 independent reports** agreeing to become candidates. Inferred effects count for 60% of a direct mention.
6. **Read the market** (`src/market.js`): fetches a year of daily prices from Yahoo Finance's public chart endpoint (no key needed) for each candidate, each event's affected assets, and a **market map of ~55 instruments** (US sectors, country and region ETFs, rates and credit, currencies, commodities, crypto, VIX). Unusually large moves are flagged relative to each instrument's own normal volatility.
7. **Forecast vs. actual**: each forecast is compared with how far the asset has moved since the event *first* broke:
   - **ahead of the move**: little has happened yet and the effect is still due. This is the predictive window.
   - **underway**: moving as forecast, with more to come.
   - **priced in**: 80%+ of the forecast move has already happened.
   - **diverging**: moving the other way; something else is dominating.
   - **not reacting**: an effect expected within days hasn't shown up; the market is skeptical.
8. **Remember and grade** (event memory): open events and forecasts are saved to `reports/event-memory.json`. On the next run, Claude sees the tracked events, and new articles about them extend the same event. Moves are still measured from the original date, and events with no new coverage stay in play until their forecast window closes. When a window closes, the forecast is graded: **hit** if the asset moved at least half the forecast in the predicted direction, **partial** if it moved the right way but less, **miss** otherwise. The hit rate, overall and by time horizon, goes back to the advisor so it can calibrate its confidence.
9. **Advise** (`src/advise.js`): Claude ranks picks by independent corroboration, causal clarity, market confirmation and **how much of the expected move is still ahead**, favoring being early over chasing moves already priced in. The composite pre-ranking weights news consensus 55%, market confirmation 25% and remaining forecast move 20%. Each pick includes its causal chain, expected timing, expected move, what to watch for to confirm or exit, and allocation. Any ticker that wasn't among the analyzed candidates is discarded.

The report opens with the market overview and **Forecast: moves still ahead**, then the picks. It ends with the full event transmission map, market flux, and the forecast track record.

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

Set `ADVISOR_REFRESH_HOURS=24` to have the server refresh the analysis automatically. **Run the agent regularly (daily is ideal):** event memory is what lets it follow a tariff or blockade through the weeks it takes to reach prices, and grade its own forecasts.

A run takes a few minutes. It makes roughly one Claude call per 30 articles, one event-mapping and forecasting call, and one final call. With ~400 articles on `claude-opus-5-5`, expect roughly $2–4 per run. Set `ADVISOR_MODEL` to use a different model.

## Configuration

- **`config/sources.json`**: feeds per outlet, the Google News fallback queries, whether to fetch full text, and the market map (add any sector, country, currency or commodity you want watched). Publishers change feed URLs from time to time. If an outlet shows 0 articles or a fallback note in the report's *Source coverage* table, update its feed URL here.
- **Consensus threshold**: `--min-sources` (default 2). Raise it for stricter cross-referencing. If too few assets qualify, the list is topped up with single-outlet names, and Claude sees each one's outlet count.

## Tests

```bash
npm test
```

The tests run fully offline. They cover feed parsing, balancing, fallback and wire-copy detection, the technical indicators, the market map, forecast measurement, event memory and grading, the consensus scoring, and end-to-end pipeline runs. Those runs check that a world-news-only story reaches the picks through the event map, that a republished wire story isn't double counted, and that a second run weeks later continues the same event and grades its expired forecasts. That run uses fake feeds, fake market data and a stubbed Claude client, and validates every stubbed response against the real output schemas.

## Limitations

- Headlines and summaries from paywalled outlets carry less detail than full articles. The agent reads only what the publishers make available in their feeds.
- Yahoo Finance's chart endpoint is unofficial and rate-limited. For production use, swap `fetchQuote` in `src/market.js` for a licensed data provider.
- Forecast timing and size are Claude's estimates from the reporting, not a quantitative model. Treat them as hypotheses, and let the track record tell you how far to trust them.
- A forecast is measured from when the agent first saw the event. A situation that started before the agent began tracking it may already be partly priced in.
- Wire-copy detection compares wording. An outlet that rewrites a wire story heavily will still count as independent.
- News-driven signals can be wrong or already priced in. The market check reduces that risk but doesn't remove it. Nothing here accounts for your taxes, liquidity needs or full financial picture.
