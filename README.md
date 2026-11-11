# Meridian — EvilPanda fork

This fork runs the **Evil Panda strat** (LogicalTA, Advanced Bootcamp #7) on top of the standalone Meridian bot: wide one-sided SOL ranges that farm fees while price dumps, exits on the bounce. Rules are deterministic; an LLM is optional and only vetoes on narrative.

## EvilPanda flow

1. **Candidates** from three sources (each can be switched off in `evilPanda.sources`): the Meteora pool screener (newest tokens first), the Discord LP-call relay served by the Agent Meridian API (read-only, no Discord account), and smart-wallet convergence.
2. **Screen**: Jupiter basics (mcap ≥ $250k, 24h volume ≥ $1M, fees > 30 SOL, top10 < 30%, image present, mint/freeze revoked), Rugcheck (score, danger risks, blocked risk names), GMGN (phishing < 30%, bundling < 60%, insiders < 10%, top10 < 30%; skipped when `GMGN_API_KEY` is missing), then the best token/SOL DLMM pool (highest bin step first).
3. **Entry** only on a 15m candle that closes above Supertrend (fresh break). Optional LLM narrative veto. Shape is bid-ask, or spot when the token meets every stability criterion in `evilPanda.shape.spot`.
4. **Range** single-side SOL, adaptive by default: depth from the token's 15m ATR% (calm → −50%, wild → −85%, +10% after a 2× pump, cap −90%; `evilPanda.range.mode: "fixed"` uses `targetDownsidePct`). The pool is picked at entry by expected fee for our position: 1h fee/active-TVL ÷ bins needed for that depth (`evilPanda.pool.ranking`). Calibrate `atrLowPct`/`atrHighPct` from the backtest report. If that needs bin arrays that do not exist yet, the range is shortened to the existing ones so **no non-refundable rent is ever paid**; pools that end up shallower than −50% are skipped.
5. **Exits** (first to trigger wins): stop loss −15%, take profit +5%, trailing (3% trigger / 1.5% drop), OOR above (close after 30 min only if PnL is still positive; negative PnL holds until the stop loss), OOR below (close after 60 min), low yield (< 10 fee/TVL after 60 min unless 1h volume and 1h Supertrend show the token is still alive, or the LLM says hold), and the EvilPanda exit: Supertrend broken on 15m + RSI(2) > 90 with a close above the BB upper band or the first green MACD bar.

Indicators are computed locally (TradingView conventions) from self-built 15m candles: each pool is seeded once with history from GeckoTerminal (keyless ≈ 5 calls/min, so seeds are queued; set `COINGECKO_API_KEY` for a free Demo key to seed faster) and then extended by sampling the pool price from Meteora every minute (`evilpanda-candles.json`). All thresholds live in the `evilPanda` block of `user-config.json`; see `user-config.example.json`.

```sh
node cli.js ep-screen --mint ADDRESS   # read-only: why a token passes/fails + current 15m signals
node cli.js ep-watchlist               # candidates the engine is tracking
npm test                               # includes test/evilpanda.test.js
```

### Backtest (run on the VPS — needs internet)

```sh
npm run backtest -- --lessons /path/to/old-bot/lessons.json   # tokens + time windows from your old bot
npm run backtest -- --mints MINT1,MINT2 --days 30
```

Simulates the chart rules (entry on Supertrend break, range, every exit rule) with the same code as the live bot, for several variants (`config-kamu`, `murni-evilpanda`, fixed ranges −85/−70/−50%, `spot`, `oor-atas-min1%`) and three fee scenarios. Writes `backtest/results/backtest-*.md` and `trades-*.csv`; downloaded candles are cached in `backtest/cache/`. Rugcheck/GMGN filters cannot be backtested and fees are estimates — compare variants, don't read the numbers as a profit forecast.

### Smart wallet finder

```sh
npm run find-wallets                 # scan the 15 busiest token/SOL DLMM pools
npm run find-wallets -- --add 5      # also add the top 5 to smart-wallets.json
```

**LP Agent (optional):** with `LPAGENT_API_KEY` (Premium plan — `/top-lpers` is not on Basic) the finder also pulls each scanned pool's top LPers from LP Agent. They are re-scored on Meteora data with the same filters, so nothing is added on LP Agent's word alone.

**Automatic (default):** the daemon runs this once a day (`walletFinder.auto`): it adds up to 3 new qualified wallets per run (list cap 15), removes wallets that turned unprofitable, became bot-like or have had no open DLMM position for 3 days, and sends a 👛 Telegram summary. Wallets with `"category": "pinned"` in `smart-wallets.json` are never removed. `npm run find-wallets -- --auto` runs the same job by hand.

Finds wallets with open positions in the busiest memecoin DLMM pools (read on-chain via `getProgramAccounts` — needs an RPC plan that allows it), pulls their closed positions in those pools from Meteora's PnL API, and ranks them by win rate (shrunk for small samples) and profit. Filters live in `evilPanda.walletFinder`. Report: `wallet-finder/results/wallets-*.md`.

### Paper trading (shadow mode)

With `shadowMode: true` and `evilPanda.paper.enabled` (default), every "would deploy" opens a simulated position priced from live Meteora data every minute and closed by the same exit rules. `node cli.js paper` shows results — judge by `totalPnlSol` and `feeKeptPct` (net PnL ÷ fees earned; negative means price moves ate more than all fees), not win rate; `byShape` compares bid-ask vs spot and `reentry`/`firstEntry` split repeat entries into the same pool. Telegram gets 📝 alerts. Nothing touches the wallet.

Set `evilPanda.enabled: false` to get the original wallet-convergence behaviour back.

---

# Meridian

Standalone wallet-triggered Meteora DLMM bot for Solana. It waits for fresh LP entries by tracked wallets, screens the matching token, and manages positions with deterministic rules. No LLM or Meridian server is required.

## Flow

1. Watch tracked LP wallets through Solana WebSocket notifications, with signature backfill for missed events.
2. Count distinct wallets adding meaningful quote-side liquidity to the same **mint address**, across pools, within a rolling window (default: two wallets in 120 seconds).
3. Screen that mint and its eligible token/SOL pools using Meteora and Jupiter data and on-chain token checks.
4. Recheck exposure, price movement, balances, and transaction safety before entry. Failed screening waits within a bounded deadline.
5. Monitor positions independently and execute rule-based closes and fee claims.

Shadow mode is the default and forces `DRY_RUN=true` for all transaction paths. It records proposals without submitting them. Read [user-config.example.json](user-config.example.json) for supported settings. Monitoring and screening implementation details are in [standalone/](standalone/).

## Setup

Use Node.js 18 or newer and a Solana RPC provider supporting WebSocket subscriptions and transaction history.

```sh
npm install
npm run setup
node cli.js wallets add --wallet ADDRESS --name NAME
node cli.js wallets add --wallet OTHER_ADDRESS --name OTHER_NAME
npm start
```

Setup writes `user-config.json` and starts with shadow mode enabled. It preserves existing settings when prompts are left blank. Set credentials in your environment or local `.env`; see [.env.example](.env.example). For read-only operation, `WALLET_ADDRESS` / `walletAddress` can identify the portfolio without a private key. Live signing requires `WALLET_PRIVATE_KEY`.

Supported infrastructure overrides:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Default Solana endpoint and transaction submission |
| `MONITOR_RPC_URL`, `MONITOR_WS_URL` | Wallet monitoring endpoints |
| `BALANCE_RPC_URL` | Standard SOL and token balance reads |
| `FALLBACK_RPC_URL` | Fallback for monitor/balance reads |
| `PNL_SOURCE` | `meteora` (default) or `rpc` |
| `PNL_RPC_URL` | Optional on-chain PnL engine endpoint |
| `JUPITER_API_KEY` | Jupiter price and swap access |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional outbound notifications |

Balances use standard RPC, including SPL Token and Token-2022. PnL defaults to Meteora portfolio and position APIs, with an on-chain fallback. Jupiter supplies prices, token data, and swaps. Telegram is notification-only; the previous agent chat and command menus are archived.

To enable live trading, review your thresholds, wallet list, and shadow results, set `shadowMode` to `false`, remove any `DRY_RUN=true` override, and restart. Configuration edits take effect after restart.

## Commands

```sh
node cli.js help
node cli.js status
node cli.js balance
node cli.js positions
node cli.js screen --mint ADDRESS
node cli.js pool --pool ADDRESS
node cli.js manage --dry-run
node cli.js close --position ADDRESS --dry-run
node cli.js performance
```

`screen --mint` is read-only and never deploys. New entries are available only through wallet convergence. Manual close, claim, and swap operations remain available; run `help` for arguments. The CLI no longer writes skills into your home directory.

For a managed daemon:

```sh
npm run pm2:start
npm run pm2:logs
```

## Local state

Wallets, settings, position state, signal checkpoints, decisions, and logs stay local and are ignored by Git. `performance.js` retains closed-position accounting in the existing `lessons.json` file so historical records remain readable; it does not generate LLM lessons or contact HiveMind. Pool history and cooldowns remain in `pool-memory.json`.

A `submitting` attempt left by a restart needs on-chain reconciliation before that mint can be attempted again. Do not erase recovery state to bypass it.

## Validation

```sh
npm test
```

This checks JavaScript syntax, the standalone signal/rule tests, module imports, CLI behavior, and the Meteora PnL path with mocked data. Tests do not submit transactions.

## Legacy archive

The local **`legacy` branch** preserves the complete pre-cleanup snapshot at **`fd835b7`**, including the earlier LLM runtime in its history. The branch was advanced without rewriting any commits. No archive directory is loaded by the new application.

```sh
git show legacy:agent.js
git show legacy:tools/screening.js
git log legacy
```

The archive includes the old prompts/tool catalog, broad scanning, HiveMind and lesson evolution, LPAgent/Meridian relays, top-LPer studies, chart indicators, GMGN enrichment, Discord listener, Claude agent presets, and old setup/CLI. It has not been pushed automatically.
