# Investment Advisor Agent

An AI research agent that reads recent reporting from **BBC, Al Jazeera, Business Insider, Forbes, The New York Times, The Wall Street Journal and the Associated Press**, cross-references it into a consensus, checks each idea against **live market data**, and produces a ranked brief of **10–20 stocks, ETFs, crypto assets and commodities** fitted to your investor profile.

> **Not financial advice.** The output is automated research from headlines and public prices. News signals can be wrong or already priced in. Verify independently and consult a licensed advisor before investing.

## How it works

```
 7 outlets (RSS)        Claude (effort: low)        Consensus engine          Yahoo Finance            Claude (effort: high)
┌──────────────┐   ┌─────────────────────────┐   ┌────────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
│ BBC, AJ, BI, │──▶│ Extract per article:    │──▶│ Group by ticker    │──▶│ Price, 1d/5d/1mo │──▶│ Rank 10–20 picks for     │
│ Forbes, NYT, │   │ ticker, asset class,    │   │ Score = agreement  │   │ /3mo/1y, SMA20/50│   │ your profile: action,    │
│ WSJ, AP      │   │ bullish/bearish, 1–5    │   │ × outlet breadth   │   │ RSI, volatility, │   │ conviction, allocation,  │
│ (last 72h)   │   │ strength, macro themes  │   │ × strength         │   │ volume, trend    │   │ thesis, risks, avoid list│
└──────────────┘   └─────────────────────────┘   └────────────────────┘   └──────────────────┘   └──────────────────────────┘
                                                                                                         │
                                                                              reports/latest.md + .json ◀┘  + web dashboard
```

1. **Collect** (`src/news.js`): pulls each outlet's RSS feeds (`config/sources.json`), keeps articles from the last 72 hours, and de-duplicates them. If an outlet's feeds fail, it falls back to a Google News search restricted to that site. AP has no official RSS, so it always uses that search. For BBC and Al Jazeera, which have no hard paywall, it also fetches the article text. For the paywalled outlets it uses the headline and summary only.
2. **Extract** (`src/extract.js`): Claude reads the articles in batches and returns structured signals. Each signal has a Yahoo Finance ticker, asset class, sentiment, strength, and whether the asset is named in the article or inferred as a second-order effect (for example, a shipping disruption leading to higher crude oil prices).
3. **Cross-reference** (`src/aggregate.js`): groups the signals by ticker. Assets need at least **2 independent outlets** agreeing to become candidates. Agreement across outlets outweighs raw mention count, so one outlet repeating a story can't outvote several independent ones. Inferred signals count for 60% of a direct mention.
4. **Check the market** (`src/market.js`): fetches a year of daily prices per candidate from Yahoo Finance's public chart endpoint (no key needed). It computes trend and momentum, then marks each news thesis as *confirmed*, *neutral* or *contradicted* by the price action. Tickers the market data source doesn't recognize are dropped as mis-mapped. It also prices a market backdrop: SPY, QQQ, VIX, the 10-year yield, the dollar index, gold, oil and bitcoin.
5. **Advise** (`src/advise.js`): Claude receives the consensus evidence, market metrics, backdrop and your profile. It returns the ranked picks, suggested allocations (which sum to 100% with cash), an avoid list and portfolio notes. Any ticker that wasn't among the analyzed candidates is discarded.

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
| `GET /api/status` | Current run stage: `news` → `extract` → `consensus` → `market` → `advise` → `done`. |
| `GET /api/report/latest` | Latest report as JSON. |
| `GET /api/report/latest.md` | Latest report as Markdown. |

Set `ADVISOR_REFRESH_HOURS=24` to have the server refresh the analysis automatically.

A run takes a few minutes. It makes roughly one Claude call per 30 articles plus one final call. With ~250 articles on `claude-opus-5-5`, expect roughly $1–3 per run. Set `ADVISOR_MODEL` to use a different model.

## Configuration

- **`config/sources.json`**: feeds per outlet, the Google News fallback query, whether to fetch full text, and the market backdrop tickers. Publishers change feed URLs from time to time. If an outlet shows 0 articles or a fallback note in the report's *Source coverage* table, update its feed URL here.
- **Consensus threshold**: `--min-sources` (default 2). Raise it for stricter cross-referencing. If too few assets qualify, the list is topped up with single-outlet names, and Claude sees each one's outlet count.

## Tests

```bash
npm test
```

The tests run fully offline. They cover feed parsing and fallback, the technical indicators, the consensus scoring, and an end-to-end pipeline run. That run uses fake feeds, fake market data and a stubbed Claude client, and validates every stubbed response against the real output schemas.

## Limitations

- Headlines and summaries from paywalled outlets carry less detail than full articles. The agent reads only what the publishers make available in their feeds.
- Yahoo Finance's chart endpoint is unofficial and rate-limited. For production use, swap `fetchQuote` in `src/market.js` for a licensed data provider.
- News-driven signals can be wrong or already priced in. The market check reduces that risk but doesn't remove it. Nothing here accounts for your taxes, liquidity needs or full financial picture.
