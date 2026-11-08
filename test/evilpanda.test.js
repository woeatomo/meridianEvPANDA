// Unit tests for the EvilPanda rule modules. Pure functions only: no network,
// no SDK, no wallet.
import test from "node:test";
import assert from "node:assert/strict";
import { rsi, macd, bollinger, supertrend, snapshot, candlesSinceBreakUp } from "../evilpanda/indicators.js";
import { binsForDownsidePct, downsidePctForBins, shrinkToInitialized, binArrayIndex } from "../evilpanda/range.js";
import { rejectTokenBasics, rejectRugcheck, gmgnMetrics, rejectGmgn, rejectGmgnFetch, rejectPool, rankPools, chooseShape } from "../evilpanda/filters.js";
import { oorDirection, updateOor, fastExitDecision, candleExitDecision, narrativeProxyHealthy } from "../evilpanda/exits.js";
import { _test as llmTest, entryVeto } from "../evilpanda/llm.js";
import { buildEvilPandaConfig } from "../config.js";

const SOL = "So11111111111111111111111111111111111111112";
const MINT = "Mint1111111111111111111111111111111111111111";
const ep = buildEvilPandaConfig({});
const mgmt = { stopLossPct: -15, takeProfitPct: 5, trailingTakeProfit: true, trailingTriggerPct: 3, trailingDropPct: 1.5 };
const cfg = { management: mgmt, exits: ep.exits };

const mk = closes => closes.map((c, i) => ({ t: i * 900_000, o: c, h: c * 1.01, l: c * 0.99, c, v: 100 }));

// ─── Indicators ──────────────────────────────────────────────────────────────

test("RSI(2): strictly rising closes → 100, falling → 0", () => {
  assert.equal(rsi([1, 2, 3, 4, 5], 2).at(-1), 100);
  assert.equal(rsi([5, 4, 3, 2, 1], 2).at(-1), 0);
});

test("RSI matches Wilder reference (14-period classic example)", () => {
  // Wilder's textbook series; RSI(14) on bar 15 ≈ 70.53 (with SMA seed, as in TradingView)
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const v = rsi(closes, 14).at(-1);
  assert.ok(Math.abs(v - 70.46) < 0.5, `got ${v}`);
});

test("MACD on a flat series is zero; BB collapses onto the mean", () => {
  const flat = new Array(60).fill(10);
  assert.equal(macd(flat).hist.at(-1), 0);
  const bb = bollinger(flat, 20, 2);
  assert.equal(bb.upper.at(-1), 10);
  assert.equal(bb.lower.at(-1), 10);
});

test("Supertrend: up in an uptrend, flips down on a crash, flips back up on recovery", () => {
  const up = mk(Array.from({ length: 40 }, (_, i) => 1 + i * 0.02));
  assert.equal(supertrend(up).at(-1).direction, "up");
  const crash = mk([...Array.from({ length: 40 }, (_, i) => 1 + i * 0.02), 1.2, 1.0, 0.8, 0.7]);
  assert.equal(supertrend(crash).at(-1).direction, "down");
  const recover = mk([...Array.from({ length: 40 }, (_, i) => 1 + i * 0.02), 1.2, 1.0, 0.8, 0.7, 0.72, 0.9, 1.2, 1.5]);
  const st = supertrend(recover);
  assert.equal(st.at(-1).direction, "up");
  assert.ok(candlesSinceBreakUp(recover) != null);
});

test("snapshot flags exit confluence on a spike while Supertrend is still down", () => {
  // decline, tight consolidation under a falling Supertrend, then a bounce candle
  const decline = Array.from({ length: 40 }, (_, i) => 2 - i * 0.025);
  const flat = Array.from({ length: 30 }, (_, i) => 1 + (i % 2 ? 0.002 : -0.002));
  const s = snapshot(mk([...decline, ...flat, 1.03]));
  assert.ok(s, "snapshot available");
  assert.equal(s.stDirection, "down");
  assert.ok(s.close < s.supertrend);
  assert.equal(s.rsiOver, true);
  assert.equal(s.aboveBbUpper, true);
  assert.equal(s.exitConfluence, true);
});

test("snapshot returns null without enough history", () => {
  assert.equal(snapshot(mk([1, 2, 3])), null);
});

// ─── Range ───────────────────────────────────────────────────────────────────

test("range math: -85% at bin step 100 needs 191 bins; round trip covers ≥ 85%", () => {
  const bins = binsForDownsidePct(85, 100);
  assert.equal(bins, 191);
  assert.ok(downsidePctForBins(bins, 100) >= 85);
  // EvilPanda's 80–125 bins for -86..-94% implies high bin steps (~250)
  assert.ok(downsidePctForBins(80, 250) > 85 && downsidePctForBins(125, 250) > 94);
});

test("bin-array index floors negative bins like the SDK", () => {
  assert.equal(binArrayIndex(0), 0);
  assert.equal(binArrayIndex(69), 0);
  assert.equal(binArrayIndex(-1), -1);
  assert.equal(binArrayIndex(-70), -1);
  assert.equal(binArrayIndex(-71), -2);
});

test("shrinkToInitialized stops at the first missing bin array (never pays rent)", () => {
  const active = 1000;           // array 14
  const target = active - 300;   // array 10
  const all = shrinkToInitialized(active, target, () => true);
  assert.deepEqual(all, { minBinId: 700, shrunk: false, binsBelow: 300 });
  const missing12 = shrinkToInitialized(active, target, i => i !== 12);
  assert.equal(missing12.minBinId, 13 * 70);
  assert.equal(missing12.shrunk, true);
  assert.equal(shrinkToInitialized(active, target, i => i !== 14), null);
});

// ─── Filters ─────────────────────────────────────────────────────────────────

const now = Date.parse("2026-11-07T00:00:00Z");
const goodToken = {
  id: MINT, icon: "x.png", mcap: 400_000, fees: 45, createdAt: "2026-11-05T00:00:00Z",
  stats24h: { buyVolume: 700_000, sellVolume: 600_000 },
  audit: { topHoldersPercentage: 22, mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
};
const basics = { ...ep.screener, ...ep.filters };

test("token basics follow the Advanced Bootcamp thresholds", () => {
  assert.equal(rejectTokenBasics(goodToken, MINT, basics, now), null);
  assert.match(rejectTokenBasics({ ...goodToken, mcap: 200_000 }, MINT, basics, now), /mcap/);
  assert.match(rejectTokenBasics({ ...goodToken, stats24h: { buyVolume: 300_000, sellVolume: 300_000 } }, MINT, basics, now), /volume/);
  assert.match(rejectTokenBasics({ ...goodToken, fees: 20 }, MINT, basics, now), /fees/);
  assert.match(rejectTokenBasics({ ...goodToken, audit: { ...goodToken.audit, topHoldersPercentage: 31 } }, MINT, basics, now), /top10/);
  assert.match(rejectTokenBasics({ ...goodToken, icon: null }, MINT, basics, now), /image/);
  assert.match(rejectTokenBasics({ ...goodToken, fees: undefined }, MINT, basics, now), /unknown/);
});

test("rugcheck: score, danger risks and blocked risk names reject; missing data rejects", () => {
  assert.equal(rejectRugcheck({ score_normalised: 1, risks: [] }, ep.rugcheck), null);
  assert.match(rejectRugcheck({ score_normalised: 14, risks: [] }, ep.rugcheck), /score/);
  assert.match(rejectRugcheck({ score_normalised: 1, risks: [{ name: "Mutable metadata", level: "danger" }] }, ep.rugcheck), /danger/);
  assert.match(rejectRugcheck({ score_normalised: 1, risks: [{ name: "Low amount of LP Providers", level: "warn" }] }, ep.rugcheck), /LP Providers/);
  assert.match(rejectRugcheck(null, ep.rugcheck), /unavailable/);
});

test("GMGN filter: phishing<30, bundling<60, insiders<10, top10<30; skipped without data by default", () => {
  const m = gmgnMetrics({ rat_trader_amount_rate: 0.12, bundler_trader_amount_rate: 0.4, suspected_insider_hold_rate: 0.05, top_10_holder_rate: 0.2 }, ep.gmgn);
  assert.equal(Math.round(m.phishingPct), 12);
  assert.equal(rejectGmgn(m, ep.gmgn), null);
  assert.match(rejectGmgn({ ...m, phishingPct: 31 }, ep.gmgn), /phishing/);
  assert.match(rejectGmgn({ ...m, bundlerPct: 60 }, ep.gmgn), /bundling/);
  assert.match(rejectGmgn({ ...m, insidersPct: 10 }, ep.gmgn), /insiders/);
  assert.equal(rejectGmgn(null, ep.gmgn), null);
  assert.match(rejectGmgn(null, { ...ep.gmgn, requireData: true }), /unavailable/);
});

test("GMGN fetch gate: no key skips, an outage or missing field with a key rejects", () => {
  assert.equal(rejectGmgnFetch(null, ep.gmgn).reason, null);
  assert.match(rejectGmgnFetch(null, { ...ep.gmgn, requireData: true }).reason, /no API key/);
  assert.match(rejectGmgnFetch({ ok: false, reason: "timeout" }, ep.gmgn).reason, /unavailable \(timeout\)/);
  const full = { rat_trader_amount_rate: 0.1, bundler_trader_amount_rate: 0.2, suspected_insider_hold_rate: 0.01, top_10_holder_rate: 0.2 };
  assert.equal(rejectGmgnFetch({ ok: true, data: full }, ep.gmgn).reason, null);
  const { rat_trader_amount_rate, ...missing } = full;
  assert.match(rejectGmgnFetch({ ok: true, data: missing }, ep.gmgn).reason, /phishing unknown/);
});

test("pools: exact token/SOL DLMM within bin-step range, highest bin step ranked first", () => {
  const s = { minBinStep: 80, maxBinStep: 250, minTvl: 10_000, maxTvl: null };
  const pool = (step, fee, addr) => ({ pool_address: addr, pool_type: "dlmm", token_x: { address: MINT }, token_y: { address: SOL }, dlmm_params: { bin_step: step }, tvl: 20_000, pool_price: 0.001, fee_active_tvl_ratio: fee, is_blacklisted: false });
  assert.equal(rejectPool(pool(100, 1, "a"), MINT, SOL, s), null);
  assert.match(rejectPool(pool(400, 1, "a"), MINT, SOL, s), /bin step/);
  const ranked = rankPools([pool(100, 5, "a"), pool(250, 1, "b"), pool(200, 3, "c")]);
  assert.deepEqual(ranked.map(p => p.pool_address), ["b", "c", "a"]);
});

test("shape: bid-ask by default, spot only when every stability criterion holds", () => {
  const stable = {
    token: { createdAt: "2026-10-01T00:00:00Z", mcap: 3_000_000 },
    pool: { volatility: 2 },
    rugcheck: { score_normalised: 1 },
    gmgn: { phishingPct: 5, bundlerPct: 10, insidersPct: 2 },
  };
  assert.equal(chooseShape(stable, ep.shape, now).strategy, "spot");
  assert.equal(chooseShape({ ...stable, pool: { volatility: 6 } }, ep.shape, now).strategy, "bid_ask");
  assert.equal(chooseShape({ ...stable, gmgn: null }, ep.shape, now).strategy, "bid_ask");
  assert.equal(chooseShape({ ...stable, token: { ...stable.token, createdAt: "2026-11-06T00:00:00Z" } }, ep.shape, now).strategy, "bid_ask");
  assert.equal(chooseShape(stable, { ...ep.shape, autoSpot: false }, now).strategy, "bid_ask");
});

// ─── Exits ───────────────────────────────────────────────────────────────────

const pos = (o = {}) => ({ pnl_pct: 1, active_bin: 50, lower_bin: 0, upper_bin: 100, fee_per_tvl_24h: 30, age_minutes: 10, ...o });

test("SL -15 / TP 5 / trailing 3→1.5", () => {
  assert.equal(fastExitDecision(pos({ pnl_pct: -15 }), {}, cfg).rule, "STOP_LOSS");
  assert.equal(fastExitDecision(pos({ pnl_pct: 5.1 }), {}, cfg).rule, "TAKE_PROFIT");
  assert.equal(fastExitDecision(pos({ pnl_pct: 2 }), { peakPnlPct: 4 }, cfg).rule, "TRAILING_TP");
  assert.equal(fastExitDecision(pos({ pnl_pct: 3 }), { peakPnlPct: 4 }, cfg), null);
  assert.equal(fastExitDecision(pos({ pnl_pct: -20, pnl_pct_suspicious: true }), {}, cfg), null);
});

test("OOR direction: above = all SOL (price up), below = all token (price down)", () => {
  assert.equal(oorDirection(pos({ active_bin: 101 })), "above");
  assert.equal(oorDirection(pos({ active_bin: -1 })), "below");
  assert.equal(oorDirection(pos()), null);
  const t0 = 1_000_000;
  const a = updateOor(null, pos({ active_bin: 101 }), t0);
  assert.deepEqual(a, { dir: "above", since: t0 });
  assert.equal(updateOor(a, pos({ active_bin: 120 }), t0 + 5).since, t0, "clock keeps running on the same side");
  assert.equal(updateOor(a, pos({ active_bin: -5 }), t0 + 5).since, t0 + 5, "switching sides restarts the clock");
  assert.deepEqual(updateOor(a, pos(), t0 + 5), { dir: null, since: null });
});

test("OOR above: PnL positive → close after 30m; PnL negative → hold (only SL closes)", () => {
  const t0 = 0;
  const above = { dir: "above", since: t0 };
  assert.equal(fastExitDecision(pos({ active_bin: 150, pnl_pct: 2 }), { oor: above }, cfg, t0 + 29 * 60_000), null);
  assert.equal(fastExitDecision(pos({ active_bin: 150, pnl_pct: 2 }), { oor: above }, cfg, t0 + 30 * 60_000).rule, "OOR_ABOVE");
  assert.equal(fastExitDecision(pos({ active_bin: 150, pnl_pct: -3 }), { oor: above }, cfg, t0 + 10 * 3_600_000), null);
  assert.equal(fastExitDecision(pos({ active_bin: 150, pnl_pct: -15 }), { oor: above }, cfg, t0 + 60_000).rule, "STOP_LOSS");
});

test("OOR below: close after 60m or at -15%, whichever comes first", () => {
  const below = { dir: "below", since: 0 };
  assert.equal(fastExitDecision(pos({ active_bin: -10, pnl_pct: -8 }), { oor: below }, cfg, 59 * 60_000), null);
  assert.equal(fastExitDecision(pos({ active_bin: -10, pnl_pct: -8 }), { oor: below }, cfg, 60 * 60_000).rule, "OOR_BELOW");
  assert.equal(fastExitDecision(pos({ active_bin: -10, pnl_pct: -16 }), { oor: below }, cfg, 60_000).rule, "STOP_LOSS");
});

test("low yield (<10 after 60m) asks for the narrative check instead of closing blindly", () => {
  assert.equal(fastExitDecision(pos({ fee_per_tvl_24h: 8, age_minutes: 30 }), {}, cfg), null);
  assert.equal(fastExitDecision(pos({ fee_per_tvl_24h: 8, age_minutes: 61 }), {}, cfg).action, "CHECK_LOW_YIELD");
  assert.equal(narrativeProxyHealthy({ recentVolume: 80, priorVolume: 100, stDirection1h: "up" }, ep.exits), true);
  assert.equal(narrativeProxyHealthy({ recentVolume: 30, priorVolume: 100, stDirection1h: "up" }, ep.exits), false);
  assert.equal(narrativeProxyHealthy({ recentVolume: 80, priorVolume: 100, stDirection1h: "down" }, ep.exits), false);
  assert.equal(narrativeProxyHealthy(null, ep.exits), false);
});

test("candle exit needs Supertrend broken AND RSI(2)>90 with BB upper or first green MACD", () => {
  const base = { stDirection: "down", rsi: 95, rsiOver: true, aboveBbUpper: true, macdFirstGreen: false, exitConfluence: true };
  assert.equal(candleExitDecision(base, cfg).rule, "EP_CONFLUENCE");
  assert.equal(candleExitDecision({ ...base, stDirection: "up" }, cfg), null, "back above Supertrend → keep holding");
  assert.equal(candleExitDecision({ ...base, exitConfluence: false }, cfg), null, "one signal is not enough");
  assert.equal(candleExitDecision(base, { exits: { ...ep.exits, stConfluence: false } }), null);
  assert.equal(candleExitDecision(null, cfg), null);
});

// ─── LLM veto ────────────────────────────────────────────────────────────────

test("LLM answers are parsed strictly; failures fall back to the rules", async () => {
  assert.deepEqual(llmTest.parseDecision('ok {"decision":"skip","reason":"generic hype"}', ["deploy", "skip"]), { decision: "skip", reason: "generic hype" });
  assert.equal(llmTest.parseDecision('{"decision":"yolo"}', ["deploy", "skip"]), null);
  const llm = { ...ep.llm, enabled: true, apiKey: "k" };
  const failing = async () => ({ ok: false, status: 500 });
  assert.equal((await entryVeto(llm, {}, failing)).allow, true);
  assert.equal((await entryVeto({ ...llm, onError: "block" }, {}, failing)).allow, false);
  const skip = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"skip","reason":"no narrative"}' } }] }) });
  assert.deepEqual(await entryVeto(llm, {}, skip), { allow: false, reason: "no narrative", source: "llm" });
  assert.equal((await entryVeto(ep.llm, {})).allow, true, "disabled LLM never blocks");
});

test("config: user overrides merge with defaults", () => {
  const c = buildEvilPandaConfig({ range: { targetDownsidePct: 80 }, gmgn: { maxBundlerPct: 50 }, shape: { spot: { minAgeHours: 24 } } });
  assert.equal(c.range.targetDownsidePct, 80);
  assert.equal(c.range.minDownsidePct, 50);
  assert.equal(c.gmgn.maxBundlerPct, 50);
  assert.equal(c.gmgn.maxPhishingPct, 30);
  assert.equal(c.shape.spot.minAgeHours, 24);
  assert.equal(c.shape.spot.limits.maxBundlerPct, 50);
  assert.equal(c.enabled, true);
  assert.equal(buildEvilPandaConfig({ enabled: false }).enabled, false);
});

// ─── Simulator / backtest / paper ────────────────────────────────────────────
import { buildBins, valueAt, positionView } from "../evilpanda/sim.js";
import { simulateMint, summarize } from "../evilpanda/backtest-core.js";

test("sim: value is full capital above entry, falls monotonically below, bid-ask weights the bottom", () => {
  const bins = buildBins({ capitalSol: 1, entryPrice: 1, binStep: 100, binsBelow: 100, shape: "bid_ask" });
  assert.ok(bins.at(-1).y > bins[0].y);
  assert.ok(Math.abs(bins.reduce((a, b) => a + b.y, 0) - 1) < 1e-9);
  assert.ok(Math.abs(valueAt(bins, 1.5).value - 1) < 1e-9);
  let prev = 1;
  for (const p of [0.9, 0.7, 0.5, 0.3, 0.1]) { const v = valueAt(bins, p).value; assert.ok(v < prev); prev = v; }
  const spot = buildBins({ capitalSol: 1, entryPrice: 1, binStep: 100, binsBelow: 100, shape: "spot" });
  assert.ok(valueAt(bins, 0.6).value > valueAt(spot, 0.6).value, "bid-ask converts less SOL early in a dump");
  assert.equal(positionView(bins, 100, 2).active_bin > 99, true, "above range");
  assert.equal(positionView(bins, 100, 0.0001).active_bin < 0, true, "below range");
});

function synthCandles() {
  const ks = [];
  let p = 1;
  const push = (c, v = 50_000) => { const o = p; ks.push({ t: ks.length * 900_000, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, vUsd: v, solUsd: 150 }); p = c; };
  for (let i = 0; i < 80; i++) push(p * 0.99);          // downtrend
  for (let i = 0; i < 6; i++) push(p * 1.06);           // breakout → Supertrend flips up
  for (let i = 0; i < 30; i++) push(p * (i % 2 ? 1.02 : 0.97)); // chop down, fees accrue
  push(p * 0.3, 500_000);                               // rug candle
  for (let i = 0; i < 20; i++) push(p * 0.99);
  return ks;
}

test("backtest: enters on the Supertrend break, exits by a rule, costs and fees are applied", () => {
  const cfgBt = { management: mgmt, exits: ep.exits, range: ep.range, shape: ep.shape, chart: ep.chart, costs: { txSol: 0.003, swapSlippagePct: 1 } };
  const trades = simulateMint({ candles: synthCandles(), pool: { binStep: 100, feePct: 2, activeTvlUsd: 30_000 }, cfg: cfgBt, startIndex: 60 });
  assert.ok(trades.length >= 1, "at least one trade");
  for (const t of trades) {
    assert.ok(Number.isFinite(t.pnlPct));
    assert.ok(t.exitT >= t.entryT);
    assert.ok(t.feesPct >= 0);
  }
  const first = trades[0];
  assert.ok(first.entryT > 80 * 900_000, "entry after the breakout, not during the downtrend");
  const s = summarize(trades);
  assert.equal(s.trades, trades.length);
  // Higher fee scenario never makes results worse.
  const hi = simulateMint({ candles: synthCandles(), pool: { binStep: 100, feePct: 2, activeTvlUsd: 30_000 }, cfg: cfgBt, feeMult: 2, startIndex: 60 });
  assert.ok(hi[0].feesPct >= first.feesPct);
});

test("backtest: a gap through the stop fills at the open, otherwise at the stop level", () => {
  const cfgBt = { management: mgmt, exits: { ...ep.exits, oorBelowWaitMinutes: Infinity, lowYieldMinFeePerTvl24h: null, stConfluence: false }, range: ep.range, shape: { ...ep.shape, default: "spot" }, chart: ep.chart, costs: { txSol: 0, swapSlippagePct: 0 } };
  const trades = simulateMint({ candles: synthCandles(), pool: { binStep: 100, feePct: 0.0001, activeTvlUsd: 1e12 }, cfg: { ...cfgBt, management: { ...mgmt, takeProfitPct: null, trailingTakeProfit: false } }, startIndex: 60 });
  const sl = trades.find(t => t.rule === "STOP_LOSS");
  assert.ok(sl, "stop loss hit");
  assert.ok(sl.pnlPct <= -14.9, `stop at or below -15% (got ${sl.pnlPct})`);
});

test("OOR above respects oorAboveMinPnlPct", () => {
  const above = { dir: "above", since: 0 };
  const strict = { ...cfg, exits: { ...cfg.exits, oorAboveMinPnlPct: 1 } };
  assert.equal(fastExitDecision(pos({ active_bin: 150, pnl_pct: 0.2 }), { oor: above }, strict, 31 * 60_000), null);
  assert.equal(fastExitDecision(pos({ active_bin: 150, pnl_pct: 1.2 }), { oor: above }, strict, 31 * 60_000).rule, "OOR_ABOVE");
});

// ─── Adaptive range + pool scoring ───────────────────────────────────────────
import { atrPct, pumpPct, chooseDepth, expectedFeeScore, rankByExpectedFee } from "../evilpanda/adaptive.js";

const wiggle = (n, amp, base = 1) => Array.from({ length: n }, (_, i) => { const c = base * (1 + (i % 2 ? amp : -amp)); return { t: i, o: base, h: c * (1 + amp), l: c * (1 - amp), c, v: 1 }; });

test("ATR%: calm series small, wild series large", () => {
  assert.ok(atrPct(wiggle(40, 0.005)) < 3);
  assert.ok(atrPct(wiggle(40, 0.05)) > 8);
  assert.equal(atrPct(wiggle(5, 0.01)), null);
});

test("adaptive depth: calm → min, wild → max, in-between interpolates, pump adds the boost, unknown → max", () => {
  assert.equal(ep.range.mode, "adaptive");
  // Fixed thresholds so the test doesn't depend on the calibrated defaults.
  const r = { ...ep.range, adaptive: { ...ep.range.adaptive, atrLowPct: 2, atrHighPct: 8 } };
  assert.equal(chooseDepth(wiggle(40, 0.002), r).depthPct, r.adaptive.minDepthPct);
  assert.equal(chooseDepth(wiggle(40, 0.06), r).depthPct, r.adaptive.maxDepthPct);
  const mid = chooseDepth(wiggle(40, 0.025), r).depthPct;
  assert.ok(mid > r.adaptive.minDepthPct && mid < r.adaptive.maxDepthPct, `mid ${mid}`);
  const pumped = [...wiggle(40, 0.002, 1), ...wiggle(10, 0.002, 2.5)];
  assert.ok(pumpPct(pumped) >= 100);
  // The pump itself raises ATR too; the boost comes on top of that.
  const noBoost = chooseDepth(pumped, { ...r, adaptive: { ...r.adaptive, pumpBoostPct: 0 } }).depthPct;
  assert.equal(chooseDepth(pumped, r).depthPct, Math.min(r.adaptive.capDepthPct, noBoost + r.adaptive.pumpBoostPct));
  assert.equal(chooseDepth([], r).depthPct, r.adaptive.maxDepthPct);
  assert.equal(chooseDepth(wiggle(40, 0.06), { ...r, mode: "fixed", targetDownsidePct: 70 }).depthPct, 70);
  const huge = [...wiggle(40, 0.06, 1), ...wiggle(10, 0.06, 3)];
  assert.ok(chooseDepth(huge, r).depthPct <= r.adaptive.capDepthPct);
});

test("expected-fee score: high bin step beats a higher fee/TVL on a low bin step for a deep range", () => {
  const p = (addr, step, ratio) => ({ pool_address: addr, dlmm_params: { bin_step: step }, fee_active_tvl_ratio_1h: ratio, tvl: 10_000 });
  const lowStep = p("a", 80, 1.0);    // 85% needs ~238 bins
  const highStep = p("b", 250, 0.6);  // 85% needs ~77 bins
  assert.ok(expectedFeeScore(highStep, 85) > expectedFeeScore(lowStep, 85));
  assert.equal(rankByExpectedFee([lowStep, highStep], 85)[0].pool_address, "b");
  // Much higher fee/TVL still wins
  assert.equal(rankByExpectedFee([p("c", 80, 5), p("d", 250, 0.6)], 85)[0].pool_address, "c");
  assert.equal(expectedFeeScore(p("e", 100, null), 85), 0);
});

// ─── Entry modes ─────────────────────────────────────────────────────────────
import { entrySignal } from "../evilpanda/entry.js";
import { series as indSeries } from "../evilpanda/indicators.js";

function entryCandles(after) {
  const ks = [];
  let p = 1;
  const push = c => { const o = p; ks.push({ t: ks.length * 900_000, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 1 }); p = c; };
  for (let i = 0; i < 60; i++) push(p * 0.99);   // downtrend
  for (let i = 0; i < 4; i++) push(p * 1.06);    // breakout
  for (const m of after) push(p * m);
  return ks;
}
const fired = (ks, e) => { const s = indSeries(ks); const out = []; for (let i = 1; i < ks.length; i++) if (entrySignal(s, i, e).enter) out.push(i); return out; };

test("entry breakout = the Supertrend flip candle (same as before)", () => {
  const ks = entryCandles([1.01, 1.01, 1.01]);
  const s = indSeries(ks);
  const flips = []; for (let i = 1; i < ks.length; i++) if (s.st[i] && s.st[i - 1] && s.st[i].direction === "up" && s.st[i - 1].direction === "down") flips.push(i);
  assert.deepEqual(fired(ks, { mode: "breakout" }), flips);
  assert.ok(flips.length >= 1);
});

test("entry pullback fires once, on the first close 10% under the post-break high, above Supertrend", () => {
  const ks = entryCandles([1.05, 1.05, 0.95, 0.96, 0.99, 1.02, 0.97]);
  const e = { mode: "pullback", pullbackRetracePct: 10, signalWindowCandles: 16 };
  const hits = fired(ks, e);
  assert.equal(hits.length, 1, `fired at ${hits}`);
  const s = indSeries(ks);
  assert.ok(ks[hits[0]].c > s.st[hits[0]].value, "still above Supertrend");
});

test("entry after_pump fires once when the close is +30% above the break close", () => {
  const ks = entryCandles([1.1, 1.1, 1.1, 1.05, 1.02]);
  const hits = fired(ks, { mode: "after_pump", afterPumpPct: 30, signalWindowCandles: 16 });
  assert.equal(hits.length, 1);
});

test("no pullback entry once the break has failed (Supertrend flipped down)", () => {
  const ks = entryCandles([0.8, 0.8, 0.85]);
  assert.deepEqual(fired(ks, { mode: "pullback", pullbackRetracePct: 10, signalWindowCandles: 16 }), []);
});

// ─── Wallet finder scoring ───────────────────────────────────────────────────
import { walletMetrics, qualifyWallet, walletScore, rankWallets } from "../evilpanda/wallet-score.js";

const closedPos = (pnlSol, pnlPct, dep = 100, fees = 2) => ({ pnlSol, pnlUsd: pnlSol * 150, pnlSolPctChange: pnlPct, allTimeDeposits: { total: { usd: dep } }, allTimeFees: { total: { usd: fees } } });

test("wallet metrics aggregate closed positions across pools", () => {
  const m = walletMetrics([{ pool: "a", positions: [closedPos(0.1, 5), closedPos(-0.05, -3)] }, { pool: "b", positions: [closedPos(0.2, 8)] }, { pool: "c", positions: [] }], 2);
  assert.equal(m.closed, 3);
  assert.equal(m.poolsTraded, 2);
  assert.equal(Math.round(m.winRatePct), 67);
  assert.ok(Math.abs(m.totalPnlSol - 0.25) < 1e-9);
  assert.equal(m.avgDepositUsd, 100);
  assert.equal(m.worstPnlPct, -3);
  assert.equal(m.openPools, 2);
});

test("wallet qualification rejects small samples, bots, whales, losers and blow-ups", () => {
  const c = buildEvilPandaConfig({}).walletFinder;
  const good = walletMetrics([{ pool: "a", positions: [closedPos(0.1, 5), closedPos(0.1, 4), closedPos(-0.02, -2)] }, { pool: "b", positions: [closedPos(0.1, 6), closedPos(0.05, 3), closedPos(0.02, 1)] }]);
  assert.equal(qualifyWallet(good, c), null);
  assert.match(qualifyWallet({ ...good, closed: 3 }, c), /closed/);
  assert.match(qualifyWallet({ ...good, closed: 900 }, c), /bot/);
  assert.match(qualifyWallet({ ...good, poolsTraded: 1 }, c), /pool/);
  assert.match(qualifyWallet({ ...good, winRatePct: 40 }, c), /win rate/);
  assert.match(qualifyWallet({ ...good, totalPnlSol: -0.1 }, c), /PnL/);
  assert.match(qualifyWallet({ ...good, avgDepositUsd: 50_000 }, c), /whale/);
  assert.match(qualifyWallet({ ...good, worstPnlPct: -80 }, c), /worst/);
});

test("wallet ranking: a consistent 40-trade wallet beats a lucky 5/5 wallet", () => {
  const lucky = { closed: 5, winRatePct: 100, totalPnlSol: 0.5 };
  const steady = { closed: 40, winRatePct: 75, totalPnlSol: 0.5 };
  assert.ok(walletScore(steady) > walletScore(lucky));
  assert.equal(rankWallets([{ wallet: "lucky", metrics: lucky }, { wallet: "steady", metrics: steady }])[0].wallet, "steady");
});
