# Meridian engineering guide

The app is the standalone bot with the EvilPanda strategy layer (`evilpanda/`). With `evilPanda.enabled` (default) entries come from the EvilPanda engine; with it off, the original wallet-convergence path runs. The only LLM use is the optional narrative veto in `evilpanda/llm.js`. The previous implementation is preserved on the local `legacy` branch at `fd835b7` (and earlier commits).

## Entry points and modules

- `index.js`: daemon startup; exports a deterministic management pass.
- `cli.js`: explicit read commands and manual close/claim/swap; `start` launches the daemon. `screen --mint` is read-only.
- `setup.js`: standalone configuration wizard; enables shadow mode.
- `standalone/runtime.js`: signal pursuit, screening deadlines, entry execution, deterministic management, fast exit polling, heartbeat, process lock.
- `standalone/monitor.js`: subscriptions, transaction queue, baseline, signature backfill.
- `standalone/events.js`: DLMM event-CPI decoding and position/exposure checks. SDK is loaded lazily.
- `standalone/store.js`: persisted deduplication, convergence windows, cooldowns, and recovery attempts.
- `standalone/screening.js`: focused mint/pool screening using Solana, Meteora, and Jupiter.
- `standalone/balances.js`, `standalone/rpc.js`: standard RPC balances, cached prices, read fallback.
- `standalone/transactions.js`: in-process priority queue for wallet writes; exits precede queued entries.
- `tools/executor.js`: deploy/close/claim/swap dispatch, transaction preflight checks, notifications, post-close swaps.
- `tools/dlmm.js`: local Meteora SDK transactions and Meteora position/PnL reads. Preserve lazy SDK loading, position cache invalidation, and pool-rent checks.
- `tools/pnl.js`: optional on-chain PnL engine and Meteora cost-basis reads.
- `tools/wallet.js`: balances and direct Jupiter swaps.
- `exit-rules.js`, `state.js`: deterministic rules and position tracking.
- `performance.js`: local performance accounting and pool cooldown updates. Uses the existing `lessons.json` schema, preserving historical data.
- `pool-memory.js`, `token-blacklist.js`, `dev-blocklist.js`: local history and safety filters.
- `smart-wallets.js`: local LP watchlist CRUD.
- `telegram.js`: outbound notifications only.

## Invariants

- Entries require an EvilPanda candidate that passed screening AND a fresh 15m Supertrend break (or wallet convergence when EvilPanda is disabled). The CLI never deploys.
- `shadowMode` forces `DRY_RUN=true` across transaction paths.
- Missing data must not be interpreted as empty positions or spendable funds.
- Keep entry screening independent of exit polling. Serialize wallet mutations through the existing queue.
- Preserve `before_submit` and `on_prepared` hooks and persisted attempt recovery.
- Read fresh positions and funds before deployment. Preserve position limits, duplicate guards, range floors, and bin-array initialization checks.
- The `minBinsBelow` floor is 35. Only token-X / SOL-token-Y pools are supported for execution.
- Never import the old agent, prompt or HiveMind into the active graph. The only Agent Meridian call allowed is the read-only Discord candidate relay in `evilpanda/sources.js`; nothing about the wallet or positions is sent.
- Range shrinking (`shrink_to_initialized`) must only ever shorten a range to existing bin arrays; never pay bin-array rent.
- Do not edit user secrets, runtime state, or the local archive branch as part of routine refactors.

## EvilPanda modules

- `evilpanda/indicators.js`, `range.js`, `filters.js`, `exits.js`, `entry.js`, `adaptive.js`, `sim.js`, `backtest-core.js`: pure rule code shared by the live bot and the backtest, covered by `test/evilpanda.test.js`.
- `evilpanda/sources.js`: read-only HTTP adapters (Jupiter, Rugcheck, GMGN, Meteora, GeckoTerminal, Discord relay).
- `evilpanda/engine.js`: watchlist, candle schedule, entries and exits; state in `evilpanda-state.json`.
- `evilpanda/llm.js`: optional narrative veto; failures fall back to the rules.

## Configuration and state

`config.js` loads `user-config.json` once. The example file documents supported settings. Restart after changes. Secrets belong in environment variables or `.env`; never commit them. Keep existing ignored JSON state and logs intact.

## Checks

Run `npm test` after changes. `test/test-standalone.js` covers convergence, event parsing, screening, balances, priority ordering, and exits. `test/cleanup.test.js` checks module resolution, no-network imports, CLI surface, and mocked Meteora position mapping. Do not start the live daemon or send transactions to validate a refactor.
