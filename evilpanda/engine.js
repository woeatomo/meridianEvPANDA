// EvilPanda orchestrator.
//
//   sources (screener / Discord relay / smart-wallet convergence)
//      → watchlist → screening (Jupiter basics, Rugcheck, GMGN, pools)
//      → wait for a 15m close that breaks ABOVE Supertrend
//      → optional LLM narrative veto → shape → rent-free range → deploy
//
// Exits: fast rules every PnL poll (SL, TP, trailing, split OOR, low yield)
// plus the Supertrend + RSI(2)/BB/MACD confluence exit on each 15m close.
// Every wallet write goes through tools/executor.js (wallet lock, safety
// checks, shadow mode). Missing data never counts as "safe".

import fs from "node:fs";
import { config, computeDeployAmount } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTrackedPosition } from "../state.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked } from "../dev-blocklist.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { checkMintOnChain } from "../standalone/screening.js";
import * as src from "./sources.js";
import { snapshot, series, supertrend } from "./indicators.js";
import { entrySignal } from "./entry.js";
import { rejectTokenBasics, rejectRugcheck, rejectGmgnFetch, rejectGmgnFallback, rejectPool, rankPools, chooseShape } from "./filters.js";
import { fastExitDecision, candleExitDecision, updateOor, narrativeProxyHealthy } from "./exits.js";
import { entryVeto, lowYieldVeto } from "./llm.js";
import { binsForDownsidePct } from "./range.js";
import { chooseDepth, rankByExpectedFee } from "./adaptive.js";
import * as paper from "./paper.js";
import { CandleBook } from "./candlebook.js";

const STATE_FILE = repoPath("evilpanda-state.json");
const ep = () => config.evilpanda;
const paperOn = () => config.standalone.shadow && ep().paper.enabled;

// ─── Persistent state ───────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { watchlist: s.watchlist ?? {}, positions: s.positions ?? {}, lowYieldHolds: s.lowYieldHolds ?? {} };
  } catch {
    return { watchlist: {}, positions: {}, lowYieldHolds: {} };
  }
}
let state = loadState();
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log("ep_warn", `state save failed: ${e.message}`); }
}

let store = null;          // standalone MonitorStore (attempt records = duplicate/crash protection)
let notify = async () => {};
const timers = {};
let candleBusy = false;
let entryBusy = false;
let rescreenBusy = false;
const closing = new Set();

// ─── Watchlist ──────────────────────────────────────────────────────────────

export function addCandidate(mint, source, meta = {}) {
  if (!mint) return;
  const now = Date.now();
  const w = state.watchlist[mint];
  if (w) {
    if (!w.sources.includes(source)) w.sources.push(source);
    w.expiresAt = Math.max(w.expiresAt, now + ep().entry.watchlistTtlHours * 3_600_000);
    Object.assign(w.meta, meta);
  } else {
    if (Object.keys(state.watchlist).length >= ep().entry.maxWatchlist) {
      // Drop the oldest non-passing entry to make room.
      const victim = Object.values(state.watchlist).filter(x => !x.pass).sort((a, b) => a.addedAt - b.addedAt)[0];
      if (!victim) return;
      delete state.watchlist[victim.mint];
    }
    state.watchlist[mint] = { mint, sources: [source], meta, addedAt: now, expiresAt: now + ep().entry.watchlistTtlHours * 3_600_000, screenedAt: 0, pass: false, reason: "not screened" };
    log("ep_watch", `+ ${mint.slice(0, 8)} via ${source}`);
  }
  saveState();
}

function pruneWatchlist(now = Date.now()) {
  for (const [mint, w] of Object.entries(state.watchlist)) if (w.expiresAt < now) delete state.watchlist[mint];
}

// ─── Screening ──────────────────────────────────────────────────────────────

/** Full EvilPanda screen for one mint. Returns { pass, reason, terminal?, token, pool, rugcheck, gmgn }. */
export async function screenCandidate(mint) {
  const e = ep();
  if (isBlacklisted(mint) || isBaseMintOnCooldown(mint)) return { pass: false, terminal: true, reason: "blacklisted or on cooldown" };
  const token = await src.jupiterToken(mint);
  const basics = rejectTokenBasics(token, mint, { ...e.screener, ...e.filters });
  if (basics) return { pass: false, reason: basics };
  if (token.dev && isDevBlocked(token.dev)) return { pass: false, terminal: true, reason: "deployer blocked" };
  await checkMintOnChain(mint);

  let rugcheck = null;
  if (e.rugcheck.enabled) {
    rugcheck = await src.rugcheckSummary(mint, { delayMs: e.rugcheck.requestDelayMs });
    const why = rejectRugcheck(rugcheck, e.rugcheck);
    if (why) return { pass: false, reason: why };
  }

  let gmgn = null;
  if (e.gmgn.enabled) {
    const r = rejectGmgnFetch(await src.gmgnSecurity(mint, e.gmgn), e.gmgn);
    gmgn = r.metrics;
    if (r.reason) return { pass: false, reason: r.reason };
  }
  // No GMGN key → apply the Jupiter/Rugcheck stand-in instead of nothing.
  if (!e.gmgn.enabled || !e.gmgn.apiKey) {
    const why = rejectGmgnFallback(token, rugcheck, e.gmgn.fallback);
    if (why) return { pass: false, reason: why };
  }

  const addresses = (await src.poolsForMint(mint, config.tokens.SOL)).slice(0, 5);
  const eligible = [];
  const rejected = [];
  for (const address of addresses) {
    if (isPoolOnCooldown(address)) { rejected.push("pool cooldown"); continue; }
    try {
      const p = await src.discoveryPool(address, "24h");
      const vol30 = await src.discoveryPool(address, "30m").catch(() => null);
      if (vol30?.volatility != null) p.volatility = vol30.volatility;
      // 1h fee/active-TVL: steadier than 5m/30m and the input for the expected-fee ranking.
      const h1 = await src.discoveryPool(address, "1h").catch(() => null);
      p.fee_active_tvl_ratio_1h = h1?.fee_active_tvl_ratio ?? null;
      const why = rejectPool(p, mint, config.tokens.SOL, config.screening);
      if (why) rejected.push(why); else eligible.push(p);
    } catch (err) { rejected.push(err.message); }
  }
  if (!eligible.length) return { pass: false, reason: rejected.slice(0, 2).join("; ") || "no eligible token/SOL DLMM pool" };
  // Provisional ranking with the deepest adaptive range; re-ranked at entry with the real depth.
  const provisionalDepth = e.range.mode === "adaptive" ? e.range.adaptive.maxDepthPct : e.range.targetDownsidePct;
  const ranked = rankPoolsFor(eligible, provisionalDepth);
  return { pass: true, reason: "ok", token, pool: ranked[0], pools: ranked, rugcheck, gmgn };
}

function rankPoolsFor(pools, depthPct) {
  return ep().pool.ranking === "expected_fee" ? rankByExpectedFee(pools, depthPct) : rankPools(pools, ep().pool.preferHighBinStep);
}

/** Compact pool record kept in the watchlist. */
function poolRecord(p) {
  return {
    pool_address: p.pool_address, dlmm_params: { bin_step: p.dlmm_params?.bin_step }, tvl: p.tvl,
    fee_active_tvl_ratio: p.fee_active_tvl_ratio, fee_active_tvl_ratio_1h: p.fee_active_tvl_ratio_1h,
    volatility: p.volatility, pool_price: p.pool_price,
  };
}

async function rescreenDue() {
  const now = Date.now();
  const due = Object.values(state.watchlist).filter(w => now - w.screenedAt > ep().entry.rescreenMin * 60_000);
  for (const w of due) {
    try {
      const r = await screenCandidate(w.mint);
      Object.assign(w, {
        screenedAt: Date.now(), pass: r.pass, reason: r.reason,
        poolAddress: r.pool?.pool_address ?? null, binStep: r.pool?.dlmm_params?.bin_step ?? null,
        volatility: r.pool?.volatility ?? null, poolPrice: r.pool?.pool_price ?? null,
        tokenFacts: r.token ? { symbol: r.token.symbol, name: r.token.name, mcap: r.token.mcap, createdAt: r.token.createdAt, holders: r.token.holderCount } : null,
        rugcheckScore: r.rugcheck?.score_normalised ?? null, gmgn: r.gmgn ?? null,
        pools: r.pools ? r.pools.map(poolRecord) : [],
        shapeInput: r.pass ? { token: { createdAt: r.token.createdAt, mcap: r.token.mcap }, pool: { volatility: r.pool.volatility }, rugcheck: r.rugcheck ? { score_normalised: r.rugcheck.score_normalised } : null, gmgn: r.gmgn } : null,
      });
      if (r.terminal) delete state.watchlist[w.mint];
      log("ep_screen", `${w.mint.slice(0, 8)} ${r.pass ? "PASS" : "fail"}: ${r.reason}`);
    } catch (err) {
      w.screenedAt = Date.now();
      w.pass = false;
      w.reason = `screen error: ${err.message}`;
      log("ep_screen", `${w.mint.slice(0, 8)} error: ${err.message}`);
    }
    saveState();
  }
}

// ─── Sources ────────────────────────────────────────────────────────────────

async function runScreener() {
  try {
    const found = await src.scanDiscovery(ep().screener, config.tokens.SOL);
    for (const c of found.slice(0, 15)) addCandidate(c.mint, "screener", { name: c.name });
  } catch (e) { log("ep_warn", `screener scan failed: ${e.message}`); }
}

async function runDiscord() {
  try {
    const list = await src.discordCandidates(ep().discord);
    for (const c of list) addCandidate(c.mint, "discord", { discordSources: c.sourceCount });
  } catch (e) { log("ep_warn", `discord relay failed: ${e.message}`); }
}

/** Smart-wallet convergence signals land here instead of deploying directly. */
export function onWalletSignal(signal) {
  addCandidate(signal.mint, "smart_wallet", { wallets: signal.events?.length ?? 0 });
}

// ─── Candles ────────────────────────────────────────────────────────────────

// Candles come from the CandleBook: each DLMM pool is seeded once with real
// history from GeckoTerminal (rate-limited, queued) and extended by sampling the
// pool price from Meteora every minute. See evilpanda/candlebook.js.

const CANDLE_FILE = repoPath("evilpanda-candles.json");
let book = null;
function candleBook() {
  if (book) return book;
  const periodMs = ep().chart.timeframeMin * 60_000;
  try { book = CandleBook.fromJSON(JSON.parse(fs.readFileSync(CANDLE_FILE, "utf8")), { periodMs, maxCandles: ep().chart.candles }); }
  catch { book = new CandleBook({ periodMs, maxCandles: ep().chart.candles }); }
  return book;
}
function saveCandles() {
  try { fs.writeFileSync(CANDLE_FILE, JSON.stringify(candleBook())); } catch (e) { log("ep_warn", `candle save failed: ${e.message}`); }
}

/** Start time of the candle that most recently closed. */
function lastClosedCandleStart(now = Date.now()) {
  const period = ep().chart.timeframeMin * 60_000;
  return Math.floor(now / period) * period - period;
}

// ── Seeding queue (one GeckoTerminal call at a time, paced in sources.ohlcvHistory)
const seedQueue = new Map(); // pool → mint
let seeding = false;
function requestSeed(pool, mint) {
  if (!pool || !mint || seedQueue.has(pool)) return;
  seedQueue.set(pool, mint);
  void runSeeds();
}
async function runSeeds() {
  if (seeding) return;
  seeding = true;
  try {
    while (seedQueue.size) {
      const [pool, mint] = seedQueue.entries().next().value;
      try {
        const ks = await src.ohlcvHistory(pool, mint, ep().chart);
        candleBook().seed(pool, ks);
        saveCandles();
        log("ep_candles", `${mint.slice(0, 8)} seeded ${ks.length} candles from ${ep().chart.coingeckoApiKey ? "CoinGecko" : "GeckoTerminal"}`);
      } catch (err) {
        log("ep_candles", `${mint.slice(0, 8)} seed failed: ${err.message} — will retry`);
        await new Promise(r => setTimeout(r, 60_000));
        seedQueue.delete(pool);
        seedQueue.set(pool, mint); // back of the queue
        continue;
      }
      seedQueue.delete(pool);
    }
  } finally {
    seeding = false;
  }
}

/** Pools whose candles we need: passing candidates, paper and live positions. */
function trackedPools() {
  const out = new Map(); // pool → mint
  for (const w of Object.values(state.watchlist)) if (w.pass && w.poolAddress) out.set(w.poolAddress, w.mint);
  for (const pp of paper.openPaperPositions()) out.set(pp.pool, pp.mint);
  for (const rec of Object.values(state.positions)) if (rec.pool && rec.mint) out.set(rec.pool, rec.mint);
  return out;
}

let sampling = false;
async function sampleTick() {
  if (sampling) return;
  sampling = true;
  try {
    const pools = trackedPools();
    const b = candleBook();
    for (const [pool, mint] of pools) {
      try {
        const row = await src.discoveryPool(pool, "5m");
        b.sample(pool, Number(row.pool_price), Date.now(), Number(row.volume));
        if (b.needsSeed(pool)) requestSeed(pool, mint);
      } catch { /* one missed sample is harmless */ }
    }
    b.prune(new Set(pools.keys()));
    saveCandles();
  } finally {
    sampling = false;
  }
}

/**
 * Candles + indicator snapshot for a pool. `stale` when history isn't seeded yet
 * or the candle that just closed is missing (never evaluate an older candle).
 */
async function candleSnapshot(mint, dlmmPool, { requireLatest = false } = {}) {
  const c = ep().chart;
  const b = candleBook();
  if (!dlmmPool) return { candles: [], snap: null, chartPool: null, stale: true, why: "no pool" };
  if (b.needsSeed(dlmmPool)) {
    requestSeed(dlmmPool, mint);
    return { candles: [], snap: null, chartPool: dlmmPool, stale: true, why: "history not seeded yet" };
  }
  const ks = b.closed(dlmmPool);
  const stale = requireLatest && !(ks.at(-1)?.t >= lastClosedCandleStart());
  return { candles: ks, snap: stale ? null : snapshot(ks, c), chartPool: dlmmPool, stale, why: stale ? "latest candle missing" : null };
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function tryEntries() {
  if (entryBusy) return;
  entryBusy = true;
  try {
    const live = await getMyPositions({ force: true }).catch(() => null);
    if (!live || live.error || !Array.isArray(live.positions)) { log("ep_entry", "position read unavailable — no entries this candle"); return; }
    const paperOpen = paperOn() ? paper.openPaperPositions() : [];
    let open = live.positions.length + paperOpen.length;
    const heldMints = new Set([...live.positions.map(p => p.base_mint), ...paperOpen.map(p => p.mint)].filter(Boolean));
    const candidates = Object.values(state.watchlist).filter(w => w.pass && !heldMints.has(w.mint));
    for (const w of candidates) {
      if (open >= config.risk.maxPositions) break;
      const attempt = store?.data.attempts[w.mint];
      if (attempt && ["entered", "proposed", "submitting"].includes(attempt.status)) continue;
      if (attempt?.status === "failed" && (attempt.failures ?? 0) >= 2) continue;
      // Entries must happen close to the candle close; a slow cycle skips rather than chases.
      const lateMin = (Date.now() - (lastClosedCandleStart() + ep().chart.timeframeMin * 60_000)) / 60_000;
      if (lateMin > ep().entry.maxEntryDelayMin) { log("ep_entry", `entry window passed (${lateMin.toFixed(1)}m after close) — remaining candidates wait for the next candle`); break; }
      const { snap, candles: ks, stale, why } = await candleSnapshot(w.mint, w.poolAddress, { requireLatest: true });
      if (stale) { log("ep_entry", `${w.mint.slice(0, 8)} candles not ready (${why}) — skipped this candle`); continue; }
      const sig = entrySignal(series(ks, ep().chart), ks.length - 1, ep().entry);
      if (!snap || !sig.enter) continue;
      log("ep_entry", `${w.mint.slice(0, 8)} entry signal (${ep().entry.mode}): ${sig.reason}`);
      // Range depth from this token's volatility, then the pool that pays OUR position best at that depth.
      const depth = chooseDepth(ks, ep().range);
      const best = rankPoolsFor(w.pools?.length ? w.pools : [], depth.depthPct)[0];
      if (best) {
        Object.assign(w, { poolAddress: best.pool_address, binStep: best.dlmm_params?.bin_step, volatility: best.volatility, poolPrice: best.pool_price });
      }
      log("ep_entry", `${w.mint.slice(0, 8)} range -${depth.depthPct}% (${depth.reason}) → pool ${String(w.poolAddress).slice(0, 8)} bin step ${w.binStep}${best?._score != null ? `, fee score ${best._score.toExponential(2)}` : ""}`);
      try {
        if (await attemptEntry(w, snap, depth)) open++;
      } catch (err) {
        log("ep_entry", `${w.mint.slice(0, 8)} entry error: ${err.message}`);
      }
    }
  } finally {
    entryBusy = false;
  }
}

async function attemptEntry(w, snap, depth) {
  const depthPct = depth?.depthPct ?? ep().range.targetDownsidePct;
  const e = ep();
  const veto = await entryVeto(e.llm, {
    ...w.tokenFacts, narrative: await src.jupiterNarrative(w.mint), sources: w.sources,
    rugcheck_score: w.rugcheckScore, gmgn: w.gmgn, discord_mentions: w.meta?.discordSources ?? 0,
  });
  if (!veto.allow) {
    log("ep_entry", `${w.mint.slice(0, 8)} skipped by LLM: ${veto.reason}`);
    w.pass = false; w.reason = `llm skip: ${veto.reason}`; w.screenedAt = Date.now();
    saveState();
    return false;
  }

  // Paper trading sizes from a virtual balance (start + realised paper PnL − SOL in
  // open paper positions), so shadow mode works with an empty wallet.
  let freeSol;
  if (paperOn()) {
    freeSol = paper.virtualFreeSol(e.paper.virtualBalanceSol);
  } else {
    const balances = await getWalletBalances({ force: true, nativeOnly: true });
    if (balances.error || !Number.isFinite(balances.sol)) { log("ep_entry", "balance read unavailable"); return false; }
    freeSol = balances.sol;
  }
  if (freeSol < config.management.minSolToOpen + config.management.gasReserve) { log("ep_entry", `insufficient ${paperOn() ? "virtual paper " : ""}SOL (${freeSol.toFixed(4)})`); return false; }
  const amountY = computeDeployAmount(freeSol);
  const shape = chooseShape(w.shapeInput ?? {}, e.shape);
  // Fresh DLMM price at decision time; the submit guard compares against this.
  let basePrice;
  try { basePrice = Number((await src.discoveryPool(w.poolAddress, "5m")).pool_price); }
  catch (err) { log("ep_entry", `${w.mint.slice(0, 8)} fresh pool read failed: ${err.message}`); return false; }

  store.data.attempts[w.mint] = { at: Date.now(), mint: w.mint, pool: w.poolAddress, source: w.sources.join(","), status: "submitting", failures: store.data.attempts[w.mint]?.failures ?? 0, position: null, txs: [] };
  store.save();

  let submitted = 0;
  const result = await executeTool("deploy_position", {
    pool_address: w.poolAddress,
    base_mint: w.mint,
    amount_y: amountY,
    strategy: shape.strategy,
    downside_pct: depthPct,
    upside_pct: 0,
    shrink_to_initialized: e.range.shrinkToInitialized,
    min_downside_pct: Math.min(e.range.minDownsidePct, depthPct),
    volatility: w.volatility,
    bin_step: w.binStep,
    pool_name: w.tokenFacts?.symbol ? `${w.tokenFacts.symbol}-SOL` : undefined,
    before_submit: async () => {
      if (submitted++ > 0) return;
      const fresh = await src.discoveryPool(w.poolAddress, "5m");
      const now = Number(fresh.pool_price);
      if (!(basePrice > 0) || !(now > 0)) throw new Error("price unavailable for move check");
      const move = Math.abs(now - basePrice) / basePrice * 100;
      if (move > e.entry.maxPriceMovePct) throw new Error(`price moved ${move.toFixed(1)}% since the entry decision`);
    },
    on_prepared: position => { store.data.attempts[w.mint].position = position; store.save(); },
  }).catch(err => ({ error: err.message }));

  const rec = store.data.attempts[w.mint];
  const ok = result && result.success !== false && !result.error && !result.blocked;
  if (!ok) {
    rec.status = "failed";
    rec.failures = (rec.failures ?? 0) + 1;
    rec.error = result?.error || result?.reason || "unknown";
    store.save();
    log("ep_entry", `${w.mint.slice(0, 8)} deploy failed: ${rec.error}`);
    return false;
  }
  rec.status = result.dry_run ? "proposed" : "entered";
  rec.position = result.position ?? rec.position;
  rec.amountSol = amountY;
  store.save();
  if (result.dry_run && paperOn()) {
    const pp = paper.openPaper({
      mint: w.mint, pool: w.poolAddress, symbol: w.tokenFacts?.symbol, entryPrice: basePrice,
      binStep: Number(result.would_deploy?.bin_step ?? w.binStep),
      binsBelow: Number(result.would_deploy?.bins_below ?? binsForDownsidePct(depthPct, w.binStep)),
      shape: shape.strategy, capitalSol: amountY, sources: w.sources,
    });
    rec.position = pp.id;
    store.save();
    log("ep_paper", `📝 opened ${pp.id}: ${amountY} SOL ${shape.strategy}, ${pp.binsBelow} bins @ ${basePrice}`);
  }
  if (rec.position && !String(rec.position).startsWith("paper-")) {
    state.positions[rec.position] = { mint: w.mint, pool: w.poolAddress, strategy: shape.strategy, enteredAt: Date.now(), oor: null };
    saveState();
  }
  const range = result.would_deploy ? ` bins_below=${result.would_deploy.bins_below}${result.would_deploy.range_shrunk ? " (shrunk, rent-free)" : ""}` : "";
  const label = result.dry_run ? "[SHADOW] would deploy" : "Deployed";
  log("ep_entry", `${label} ${amountY} SOL ${shape.strategy} → ${w.poolAddress.slice(0, 8)} (${w.mint.slice(0, 8)}, via ${w.sources.join("+")})${range} — shape: ${shape.reason}; llm: ${veto.reason}`);
  void notify(`${result.dry_run ? "🕯️ Shadow" : "✅ Entry"} ${w.tokenFacts?.symbol ?? w.mint.slice(0, 8)}: ${amountY} SOL ${shape.strategy}, range -${depthPct}%${depth?.reason ? ` (${depth.reason})` : ""} (${w.sources.join("+")})`);
  return true;
}

// ─── Exits ──────────────────────────────────────────────────────────────────

function epPosition(p) {
  if (!state.positions[p.position]) state.positions[p.position] = { mint: p.base_mint ?? null, pool: p.pool, strategy: null, enteredAt: null, oor: null };
  return state.positions[p.position];
}

/**
 * Fast-rule evaluation for one live position (called by the PnL poller and the
 * management cycle). Resolves low-yield checks. Returns {rule, reason} to close, or null.
 */
export async function evaluateFastExit(p, { resolveSlow = true } = {}) {
  const rec = epPosition(p);
  const nextOor = updateOor(rec.oor, p);
  if (nextOor.dir !== rec.oor?.dir || nextOor.since !== rec.oor?.since) {
    if (nextOor.dir) log("ep_exit", `${p.pair ?? p.position.slice(0, 8)} out of range ${nextOor.dir}`);
    rec.oor = nextOor;
    saveState();
  }
  const peakPnlPct = p.paper ? paper.paperPeak(p.position) : getTrackedPosition(p.position)?.peak_pnl_pct ?? null;
  const decision = fastExitDecision(p, { peakPnlPct, oor: rec.oor }, { management: config.management, exits: ep().exits });
  if (!decision) return null;
  if (decision.action === "CLOSE") return decision;
  // Low yield needs network (candles, maybe LLM). The 3s poller never waits on it,
  // so stop-losses on other positions are not delayed; the management cycle resolves it.
  if (!resolveSlow) return null;
  return resolveLowYield(p, rec, decision.reason);
}

async function resolveLowYield(p, rec, reason) {
  const e = ep();
  const hold = state.lowYieldHolds[p.position];
  if (hold && Date.now() - hold.at < 30 * 60_000) return null; // re-check at most every 30 min
  let healthy = false;
  let why = "narrative proxy disabled";
  const mint = rec.mint ?? p.base_mint;
  if (e.exits.narrativeProxy && mint) {
    try {
      // 1h trend from our own candles (4 × 15m); volume from Meteora: last hour vs the 24h hourly average.
      const hourly = candleBook().aggregate(p.pool, 60 / e.chart.timeframeMin);
      const st = supertrend(hourly, e.chart.stPeriod, e.chart.stMultiplier);
      const [h1, d1] = await Promise.all([src.discoveryPool(p.pool, "1h"), src.discoveryPool(p.pool, "24h")]);
      const recentVolume = Number(h1.volume) || 0;
      const priorVolume = (Number(d1.volume) || 0) / 24;
      const m = { recentVolume, priorVolume, stDirection1h: st[st.length - 1]?.direction ?? null };
      healthy = narrativeProxyHealthy(m, e.exits);
      why = `1h volume ${(priorVolume > 0 ? recentVolume / priorVolume : 0).toFixed(2)}× the 24h average, 1h trend ${m.stDirection1h ?? "unknown"}`;
    } catch (err) { why = `proxy data unavailable (${err.message})`; }
  }
  if (!healthy) {
    const llm = await lowYieldVeto(e.llm, { pair: p.pair, fee_per_tvl_24h: p.fee_per_tvl_24h, pnl_pct: p.pnl_pct, narrative: mint ? await src.jupiterNarrative(mint) : null, proxy: why });
    if (llm?.hold) { healthy = true; why = `LLM: ${llm.reason}`; }
  }
  if (healthy) {
    state.lowYieldHolds[p.position] = { at: Date.now(), why };
    saveState();
    log("ep_exit", `${p.pair ?? p.position.slice(0, 8)} ${reason} — holding, potential still alive (${why})`);
    return null;
  }
  return { action: "CLOSE", rule: "LOW_YIELD", reason: `${reason}; ${why}` };
}

const recentlyClosed = new Map(); // position → { at, dryRun }

function closePaperPosition(p, decision) {
  const t = paper.closePaper(p.position, { rule: decision.rule, reason: decision.reason });
  if (!t) return;
  delete state.positions[p.position];
  delete state.lowYieldHolds[p.position];
  saveState();
  const attempt = store?.data.attempts[t.mint];
  if (attempt?.position === p.position) { attempt.status = "closed"; store.save(); }
  log("ep_paper", `📝 closed ${t.symbol ?? t.mint.slice(0, 8)}: ${decision.rule} → ${t.pnlPct.toFixed(2)}% (${t.pnlSol.toFixed(4)} SOL, fees ${t.feesSol.toFixed(4)}) after ${t.heldMin}m — ${decision.reason}`);
  void notify(`📝 Paper close ${t.symbol ?? t.mint.slice(0, 8)}: ${decision.rule} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% (${t.pnlSol.toFixed(4)} SOL) — ${decision.reason}`);
}

async function closePosition(p, decision) {
  if (p.paper) return closePaperPosition(p, decision);
  if (closing.has(p.position)) return;
  // Poller, management cycle and candle job read positions independently; a list
  // read before a close finished must not trigger a second close (or, in shadow
  // mode, an alert every 3s).
  const last = recentlyClosed.get(p.position);
  if (last && Date.now() - last.at < (last.dryRun ? 30 : 10) * 60_000) return;
  closing.add(p.position);
  try {
    const res = await executeTool("close_position", { position_address: p.position, reason: decision.reason }).catch(err => ({ error: err.message }));
    const ok = res?.success !== false && !res?.error && !res?.blocked;
    log("ep_exit", `${p.pair ?? p.position.slice(0, 8)}: ${decision.rule} → ${ok ? (res?.dry_run ? "[SHADOW] would close" : "closed") : `close FAILED — ${res?.error || res?.reason}`} (${decision.reason})`);
    if (ok) {
      recentlyClosed.set(p.position, { at: Date.now(), dryRun: !!res?.dry_run });
      void notify(`${res?.dry_run ? "🕯️ Shadow close" : "🔚 Closed"} ${p.pair ?? p.position.slice(0, 8)}: ${decision.rule} — ${decision.reason}`);
      if (!res?.dry_run) { delete state.positions[p.position]; delete state.lowYieldHolds[p.position]; saveState(); }
    }
  } finally {
    closing.delete(p.position);
  }
}

async function candleExits() {
  const live = await getMyPositions({ force: true }).catch(() => null);
  if (!live || live.error || !Array.isArray(live.positions)) return;
  // Forget positions that closed elsewhere (manual close, other tools).
  const open = new Set(live.positions.map(p => p.position));
  for (const [addr, rec] of Object.entries(state.positions)) {
    if (!open.has(addr) && Date.now() - (rec.enteredAt ?? 0) > 3_600_000) { delete state.positions[addr]; delete state.lowYieldHolds[addr]; }
  }
  saveState();
  for (const p of live.positions) {
    const rec = epPosition(p);
    const mint = rec.mint ?? p.base_mint;
    if (!mint) continue;
    try {
      const { snap, stale } = await candleSnapshot(mint, p.pool, { requireLatest: true });
      if (stale) { log("ep_exit", `${p.pair ?? p.position.slice(0, 8)} latest 15m candle not published — confluence check skipped this candle`); continue; }
      const d = candleExitDecision(snap, { exits: ep().exits });
      if (snap) log("ep_exit", `${p.pair ?? p.position.slice(0, 8)} 15m: ST ${snap.stDirection}, RSI2 ${snap.rsi.toFixed(0)}, >BB ${snap.aboveBbUpper}, MACD1st ${snap.macdFirstGreen}`);
      if (d) await closePosition(p, d);
    } catch (err) { log("ep_exit", `${p.pair ?? p.position.slice(0, 8)} candle exit check failed: ${err.message}`); }
  }
}

// ─── Paper trading ──────────────────────────────────────────────────────────

let paperBusy = false;
const paperViews = new Map();

async function paperTick() {
  if (paperBusy || !paperOn()) return;
  paperBusy = true;
  try {
    for (const pp of paper.openPaperPositions()) {
      try {
        const pool = await src.discoveryPool(pp.pool, "5m");
        candleBook().sample(pp.pool, Number(pool.pool_price), Date.now(), Number(pool.volume));
        const view = paper.markPaper(pp.id, pool, { nearSpanBins: ep().paper.nearSpanBins });
        if (!view) continue;
        paperViews.set(pp.id, view);
        const d = await evaluateFastExit(view);
        if (d) closePaperPosition(view, d);
      } catch (err) { log("ep_paper", `${pp.symbol ?? pp.mint.slice(0, 8)} mark failed: ${err.message}`); }
    }
  } finally {
    paperBusy = false;
  }
}

async function paperCandleExits() {
  for (const pp of paper.openPaperPositions()) {
    const view = paperViews.get(pp.id);
    if (!view) continue;
    try {
      const { snap, stale } = await candleSnapshot(pp.mint, pp.pool, { requireLatest: true });
      if (stale) continue;
      const d = candleExitDecision(snap, { exits: ep().exits });
      if (snap) log("ep_paper", `${view.pair} 15m: ST ${snap.stDirection}, RSI2 ${snap.rsi.toFixed(0)}, >BB ${snap.aboveBbUpper}, MACD1st ${snap.macdFirstGreen}`);
      if (d) closePaperPosition(view, d);
    } catch (err) { log("ep_paper", `${view.pair} candle exit check failed: ${err.message}`); }
  }
}

export const paperSummary = paper.paperSummary;

// ─── Scheduling ─────────────────────────────────────────────────────────────

async function onCandleClose() {
  if (candleBusy) return;
  candleBusy = true;
  try {
    pruneWatchlist();
    await candleExits();       // exits first, then entries; rescreening runs on its own timer
    if (paperOn()) await paperCandleExits();
    await tryEntries();
  } catch (e) {
    log("ep_warn", `candle cycle failed: ${e.message}`);
  } finally {
    candleBusy = false;
  }
}

function scheduleCandles() {
  const c = ep().chart;
  const period = c.timeframeMin * 60_000;
  const next = Math.ceil(Date.now() / period) * period + c.closeDelaySec * 1000;
  timers.candle = setTimeout(async () => {
    await onCandleClose();
    scheduleCandles();
  }, Math.max(1000, next - Date.now()));
}

export function startEngine({ monitorStore, notifyFn }) {
  store = monitorStore;
  if (notifyFn) notify = notifyFn;
  const e = ep();
  if (e.sources.screener) {
    void runScreener();
    timers.screener = setInterval(() => void runScreener(), Math.max(1, e.screener.intervalMin) * 60_000);
  }
  if (e.sources.discord) {
    void runDiscord();
    timers.discord = setInterval(() => void runDiscord(), Math.max(15, e.discord.pollSec) * 1000);
  }
  scheduleCandles();
  void sampleTick();
  timers.sampler = setInterval(() => void sampleTick(), Math.max(20, e.chart.sampleSec) * 1000);
  if (e.sources.smartWallet && e.walletFinder.auto.enabled) {
    // Daily smart-wallet scan: adds good LPers, removes ones that turned bad or went idle.
    // The monitor re-reads smart-wallets.json on its own, so no restart is needed.
    const walletJob = async () => {
      try { const { dailyWalletJob } = await import("../wallet-finder/finder.js"); await dailyWalletJob(notify); }
      catch (err) { log("wallet_finder", `job error: ${err.message}`); }
    };
    timers.walletFinderFirst = setTimeout(() => void walletJob(), 3 * 60_000);
    timers.walletFinder = setInterval(() => void walletJob(), 60 * 60_000);
  }
  if (paperOn()) {
    void paperTick();
    timers.paper = setInterval(() => void paperTick(), Math.max(15, ep().paper.pollSec) * 1000);
  }
  const rescreen = async () => {
    if (rescreenBusy) return;
    rescreenBusy = true;
    try { await rescreenDue(); } catch (err) { log("ep_warn", `rescreen failed: ${err.message}`); } finally { rescreenBusy = false; }
  };
  void rescreen();
  timers.rescreen = setInterval(() => void rescreen(), 2 * 60_000);
  log("ep", `EvilPanda engine started — sources: ${Object.entries(e.sources).filter(([, v]) => v).map(([k]) => k).join(", ")} | range ${e.range.mode === "adaptive" ? `adaptive -${e.range.adaptive.minDepthPct}…-${e.range.adaptive.maxDepthPct}% (ATR ${e.range.adaptive.atrLowPct}–${e.range.adaptive.atrHighPct}%)` : `-${e.range.targetDownsidePct}%`} (min -${e.range.minDownsidePct}%, rent-free=${e.range.shrinkToInitialized}) | pools ${e.pool.ranking} | shape ${e.shape.default}${e.shape.autoSpot ? "/auto-spot" : ""} | paper ${paperOn() ? "on" : "off"} | LLM ${e.llm.enabled ? e.llm.model : "off"} | GMGN ${e.gmgn.apiKey ? "on" : e.gmgn.fallback.enabled ? `no key → fallback (bot holders < ${e.gmgn.fallback.maxBotHoldersPct}%, rugcheck insiders)` : "no key → skipped"}`);
}

export function stopEngine() {
  for (const t of Object.values(timers)) { clearInterval(t); clearTimeout(t); }
}

export function watchlistSummary() {
  return Object.values(state.watchlist).map(w => ({ mint: w.mint, sources: w.sources, pass: w.pass, reason: w.reason }));
}

export { closePosition as closeEvilPandaPosition };
