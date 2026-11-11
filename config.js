import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";

export { REPO_ROOT, repoPath };

const USER_CONFIG_PATH = repoPath("user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // The standalone wallet-triggered bot IS the app — there is no mode toggle.
  // The LLM/server-driven flow lives on the `legacy` branch.
  // Shadow mode never submits transactions.
  standalone: {
    shadow: u.shadowMode !== false,
    monitorRpcUrl: nonEmptyString(process.env.MONITOR_RPC_URL, u.monitorRpcUrl, process.env.RPC_URL),
    monitorWsUrl: nonEmptyString(process.env.MONITOR_WS_URL, u.monitorWsUrl),
    balanceRpcUrl: nonEmptyString(process.env.BALANCE_RPC_URL, u.balanceRpcUrl, process.env.RPC_URL),
    fallbackRpcUrl: nonEmptyString(process.env.FALLBACK_RPC_URL, u.fallbackRpcUrl),
    walletAddress: nonEmptyString(process.env.WALLET_ADDRESS, u.walletAddress),
    walletThreshold: u.walletThreshold ?? 2,
    windowSec: u.walletWindowSec ?? 120,
    screeningDeadlineSec: u.screeningDeadlineSec ?? 120,
    retrySec: u.screeningRetrySec ?? 15,
    reconcileSec: u.walletReconcileSec ?? 30,
    minDepositSol: u.minSmartWalletDepositSol ?? 0.1,
    maxPriceMovePct: u.maxEntryPriceMovePct ?? 5,
    cooldownSec: u.walletSignalCooldownSec ?? 300,
    maxPendingTransactions: u.maxPendingWalletTransactions ?? 1000,
    walletGroups: u.walletGroups ?? {},
  },
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── PnL fetcher / poller (public infra: Meteora APIs) ──
  pnl: {
    // Position discovery, value, fees, and PnL come from the Meteora portfolio
    // + /pnl APIs — no per-tick on-chain reads, so the poller stays cheap.
    // "rpc" keeps the on-chain engine (DLMM SDK + Jupiter) available as an
    // explicit opt-in.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, process.env.RPC_URL, "https://api.mainnet-beta.solana.com"),
    source: nonEmptyString(u.pnlSource, process.env.PNL_SOURCE, "meteora"), // meteora | rpc
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    // Referral fee is OFF by default in this fork (upstream sent 0.5% of every
    // swap to the original author's referral account). Set both env vars to re-enable.
    referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT ?? "",
    referralFeeBps: Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 0),
  },

  evilpanda: buildEvilPandaConfig(u.evilPanda ?? {}),

};

/**
 * EvilPanda strategy settings (`evilPanda` block in user-config.json).
 * Every key is optional; omitted keys use the defaults below. Secrets come
 * from the environment: GMGN_API_KEY, LLM_API_KEY / OPENROUTER_API_KEY.
 */
export function buildEvilPandaConfig(e = {}) {
  const pick = (obj, defaults) => ({ ...defaults, ...(obj && typeof obj === "object" ? obj : {}) });
  const sources = pick(e.sources, { screener: true, discord: true, smartWallet: true });
  const screener = pick(e.screener, {
    intervalMin: 5,
    minMcap: 250_000,
    maxMcap: null,
    minTokenVolume24h: 1_000_000,
    minPoolVolume: 10_000,      // discovery prefilter, pool volume within `timeframe`
    timeframe: "24h",
    category: "trending",
    pageSize: 50,
    requireProfile: true,       // must have an image
    requireSocials: false,
    minTokenAgeHours: null,
    maxTokenAgeHours: null,
  });
  const filters = pick(e.filters, { minTokenFeesSol: 30, maxTop10Pct: 30 });
  const rugcheck = pick(e.rugcheck, {
    enabled: true,
    maxScore: 10,               // score_normalised (1 = best, 100 = worst)
    rejectDanger: true,
    blockRisks: ["Low amount of LP Providers", "Creator history of rugged tokens"],
    requireData: true,
    requestDelayMs: 1000,
  });
  const gmgn = pick(e.gmgn, {
    enabled: true,
    baseUrl: "https://openapi.gmgn.ai",
    requestDelayMs: 2500,
    maxRetries: 2,
    ratesAreFractions: true,    // API rates 0.12 = 12%; compare with the GMGN UI once and flip if needed
    maxPhishingPct: 30,         // GMGN UI "Phishing" = API rat_trader_amount_rate
    maxBundlerPct: 60,
    maxInsidersPct: 10,
    maxTop10Pct: 30,
    requireData: false,         // false: skip the GMGN filter when no key / data
  });
  gmgn.apiKey = nonEmptyString(process.env.GMGN_API_KEY, typeof e.gmgn?.apiKey === "string" ? e.gmgn.apiKey : "");
  const discord = pick(e.discord, {
    pollSec: 60,
    url: "https://api.agentmeridian.xyz/api",
    apiKey: "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz", // upstream public read key
  });
  const chart = pick(e.chart, {
    source: "top_pool",         // top_pool (most liquid pool, longest history) | dlmm_pool
    timeframeMin: 15,
    candles: 200,
    currency: "token",          // price in SOL, same as the DLMM pool
    requestDelayMs: 2200,       // GeckoTerminal free tier ≈ 30 calls/min
    stPeriod: 10, stMultiplier: 3,
    rsiPeriod: 2, rsiUpper: 90,
    bbPeriod: 20, bbStdDev: 2,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    closeDelaySec: 20,          // wait after the candle boundary for data to settle
    sampleSec: 60,              // self-built candles: sample each pool's price from Meteora this often
    seedDelayMs: 15_000,        // keyless GeckoTerminal ≈ 5 calls/min → one history seed per 15s
    seedDelayMsKeyed: 2_500,    // with a CoinGecko Demo key
  });
  chart.coingeckoApiKey = nonEmptyString(process.env.COINGECKO_API_KEY, "");
  const entry = pick(e.entry, {
    mode: "breakout",           // breakout | pullback | after_pump  (see evilpanda/entry.js; compare in the backtest)
    signalWindowCandles: 16,    // pullback/after_pump must happen within N candles (4h) of the Supertrend break
    pullbackRetracePct: 10,     // pullback: close this far below the high since the break, still above Supertrend
    afterPumpPct: 30,           // after_pump: close this far above the break close
    freshBreakCandles: 1,       // (legacy, unused) kept so old configs still load
    maxPriceMovePct: 5,         // abort if price moved more than this between signal and submit
    maxEntryDelayMin: 5,        // skip entries if the cycle runs later than this after the candle close
    watchlistTtlHours: 6,
    rescreenMin: 30,
    maxWatchlist: 40,
  });
  const range = pick(e.range, {
    mode: "adaptive",           // adaptive (depth from 15m ATR%) | fixed (targetDownsidePct)
    targetDownsidePct: 85,      // fixed mode: 0% to -85%
    minDownsidePct: 50,         // shallower than this after shrinking → skip the pool
    shrinkToInitialized: true,  // never pay non-refundable bin-array rent
  });
  range.adaptive = pick(e.range?.adaptive, {
    minDepthPct: 50,            // calm tokens
    maxDepthPct: 85,            // wild tokens
    capDepthPct: 90,            // hard cap including the pump boost
    atrPeriod: 14,
    atrLowPct: 3,               // ATR% (15m) at/below this → minDepthPct   (p25 of entries in the 2026-11 backtest)
    atrHighPct: 7,              // ATR% (15m) at/above this → maxDepthPct   (p75 of entries in the 2026-11 backtest)
    pumpLookbackCandles: 96,    // 24h of 15m candles
    pumpThresholdPct: 100,      // price ≥ 2× its 24h low …
    pumpBoostPct: 10,           // … → range 10% deeper ("after a big pump, use a bigger pool")
  });
  const pool = pick(e.pool, {
    ranking: "expected_fee",    // expected_fee (fee/active-TVL 1h ÷ bins needed) | bin_step (highest bin step first)
    preferHighBinStep: true,    // used by ranking "bin_step"
  });
  const shape = pick(e.shape, { default: "bid_ask", autoSpot: true });
  shape.spot = pick(e.shape?.spot, {
    minAgeHours: 72,
    minMcap: 1_000_000,
    maxVolatility: 3,
    maxRugcheckScore: 1,
    requireGmgn: true,
    gmgnMarginPct: 50,          // each GMGN metric must be under half of its limit
  });
  shape.spot.limits = { maxPhishingPct: gmgn.maxPhishingPct, maxBundlerPct: gmgn.maxBundlerPct, maxInsidersPct: gmgn.maxInsidersPct };
  const exits = pick(e.exits, {
    stConfluence: true,
    oorAboveWaitMinutes: 30,
    oorAboveMinPnlPct: 0,       // OOR-above exit needs PnL above this (0 = any profit)
    oorBelowWaitMinutes: 60,
    lowYieldMinFeePerTvl24h: 10,
    lowYieldMinAgeMinutes: 60,
    narrativeProxy: true,
    minVolumeRatio: 0.5,        // last 6h volume vs previous 6h (1h candles)
  });
  const walletFinder = pick(e.walletFinder, {
    pools: 15,                  // busiest token/SOL DLMM pools to scan
    minPoolVolume: 50_000,      // 24h pool volume floor for scanned pools
    maxWallets: 80,             // wallets to score per run (each costs pools × 1–2 API calls)
    minClosed: 30,              // closed positions in the scanned pools
    maxClosed: 400,             // more than this looks like a bot / vault
    minPoolsTraded: 2,
    minWinRatePct: 70,
    minTotalPnlSol: 0,
    minMedianPnlPct: 0.35,      // below this the wallet looks like a market-making bot
    minAvgDepositUsd: 30,
    maxAvgDepositUsd: 20_000,
    maxWorstPnlPct: -30,        // skip wallets that rode a position deep into a loss
    requestDelayMs: 120,        // Meteora API limit is 30 req/s
  });
  walletFinder.lpAgent = pick(e.walletFinder?.lpAgent, {
    enabled: true,              // used only when LPAGENT_API_KEY is set (top-lpers needs an LP Agent Premium key)
    baseUrl: "https://api.lpagent.io/open-api/v1",
    limitPerPool: 20,
    requestDelayMs: 6500,       // Premium allows 10 requests/min
  });
  walletFinder.lpAgent.apiKey = nonEmptyString(process.env.LPAGENT_API_KEY, "");
  walletFinder.auto = pick(e.walletFinder?.auto, {
    enabled: true,              // daemon re-scans and manages the list on its own
    intervalHours: 24,
    maxWallets: 15,             // list size cap (all categories)
    addPerRun: 3,               // grow the list gradually
    removeMinClosed: 10,        // fresh closed positions needed before judging performance
    inactiveDays: 3,            // no open DLMM position anywhere for this long → remove
    readdCooldownDays: 14,      // a removed wallet can't come back for this long
    // Category "pinned" is never removed: /removewallet + /addwallet with name, then edit
    // smart-wallets.json and set "category": "pinned" for wallets you always want.
  });
  const paper = pick(e.paper, {
    enabled: true,              // only active in shadow mode: every "would deploy" becomes a simulated position
    pollSec: 60,
    nearSpanBins: 3,            // our liquidity within ±N bins of the price counts for the fee estimate
    virtualBalanceSol: 1.5,     // paper trading starts with this much virtual SOL (≈ the capital you plan to use)
  });
  const llm = pick(e.llm, {
    enabled: false,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    timeoutMs: 20_000,
    onError: "allow",           // allow | block — what to do when the LLM is unreachable
    useForEntry: true,
    useForLowYield: true,
  });
  llm.apiKey = nonEmptyString(process.env.LLM_API_KEY, process.env.OPENROUTER_API_KEY, "");
  return {
    enabled: e.enabled !== false,
    sources, screener, filters, rugcheck, gmgn, discord, chart, entry, range, pool, shape, exits, paper, walletFinder, llm,
  };
}

// Shadow applies to every existing transaction path, including CLI commands.
if (config.standalone.shadow) process.env.DRY_RUN = "true";

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}
