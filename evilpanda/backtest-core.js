// Pure backtest of the EvilPanda chart rules on one token. No I/O.
//
// Uses the SAME rule code as the live bot (indicators.js, exits.js, range.js)
// plus the position model in sim.js. What it cannot know historically —
// Rugcheck/GMGN/holders, the real fee share, bin-array availability — is
// either skipped or turned into an explicit assumption (see README section).

import { series, snapshotAt, supertrend } from "./indicators.js";
import { fastExitDecision, candleExitDecision, updateOor, narrativeProxyHealthy } from "./exits.js";
import { binsForDownsidePct } from "./range.js";
import { buildBins, valueAt, positionView, liquidityNearPrice, feeEstimate, activeIndex } from "./sim.js";

const H = 3_600_000;

/** Aggregate 15m candles into 1h candles; returns { hourly, hourIndexOf(i) }. */
function hourly(candles) {
  const out = [];
  const map = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const t = Math.floor(k.t / H) * H;
    const last = out[out.length - 1];
    if (!last || last.t !== t) out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.vUsd });
    else { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.vUsd; }
    map[i] = out.length - 1;
  }
  return { out, map };
}

/**
 * @param {object} a
 * @param {Array<{t,o,h,l,c,vUsd,solUsd}>} a.candles  15m candles, prices in SOL, oldest first
 * @param {{binStep:number, feePct:number, activeTvlUsd:number}} a.pool
 * @param {object} a.cfg  { management, exits, range, shape, chart, costs }
 * @param {number} [a.feeMult=1]  fee scenario multiplier
 * @param {number} [a.startIndex=0]  first candle allowed to trigger an entry
 * @returns {Array<object>} trades
 */
export function simulateMint({ candles, pool, cfg, feeMult = 1, startIndex = 0 }) {
  const trades = [];
  if (!candles?.length) return trades;
  const s = series(candles, cfg.chart);
  const hr = hourly(candles);
  const hrSt = supertrend(hr.out, cfg.chart.stPeriod, cfg.chart.stMultiplier);
  const costs = { txSol: 0.003, swapSlippagePct: 1, ...(cfg.costs || {}) };
  const binsBelow = Math.max(35, binsForDownsidePct(cfg.range.targetDownsidePct, pool.binStep));
  let pos = null;

  const close = (i, price, rule, reason) => {
    const v = valueAt(pos.bins, price);
    const slippage = v.tokenValue * costs.swapSlippagePct / 100;
    const final = v.value + pos.fees - slippage - costs.txSol;
    trades.push({
      entryT: pos.t0, exitT: candles[i].t, heldMin: Math.round((candles[i].t - pos.t0) / 60_000),
      rule, reason, shape: pos.shape, binsBelow,
      pnlPct: (final / pos.capital - 1) * 100,
      feesPct: pos.fees / pos.capital * 100,
      priceMovePct: (price / pos.p0 - 1) * 100,
      peakPnlPct: pos.peak,
    });
    pos = null;
  };

  for (let i = Math.max(1, startIndex); i < candles.length; i++) {
    const k = candles[i];

    if (pos) {
      // Intrabar path: bullish o→l→h→c, bearish o→h→l→c.
      const path = k.c >= k.o ? [k.l, k.h, k.c] : [k.h, k.l, k.c];
      let done = false;
      for (let step = 0; step < path.length && !done; step++) {
        const price = path[step];
        const now = k.t + (step + 1) * 300_000; // ~5 min apart inside the 15m candle
        const pnl = (valueAt(pos.bins, price).value + pos.fees) / pos.capital * 100 - 100;
        pos.peak = Math.max(pos.peak ?? pnl, pnl);
        const view = positionView(pos.bins, pool.binStep, price, {
          pnl_pct: pnl,
          fee_per_tvl_24h: pos.fee24h(i),
          age_minutes: (now - pos.t0) / 60_000,
        });
        pos.oor = updateOor(pos.oor, view, now);
        const d = fastExitDecision(view, { peakPnlPct: pos.peak, oor: pos.oor }, cfg, now);
        if (!d) continue;
        if (d.action === "CLOSE") {
          // The live poller (3s) fills stops/targets near the threshold, unless the candle gapped through it.
          let fill = price;
          if (d.rule === "STOP_LOSS" || d.rule === "TAKE_PROFIT") fill = priceForPnl(pos, d.rule === "STOP_LOSS" ? cfg.management.stopLossPct : cfg.management.takeProfitPct, price, k.o);
          close(i, fill, d.rule, d.reason);
          done = true;
        } else if (step === path.length - 1 && cfg.exits.lowYieldMinFeePerTvl24h != null) {
          // Low yield resolved once per candle at the close using the 1h proxy.
          const h = hr.map[i];
          const vols = hr.out.slice(0, h + 1).map(x => x.v);
          const m = { recentVolume: vols.slice(-6).reduce((a, b) => a + b, 0), priorVolume: vols.slice(-12, -6).reduce((a, b) => a + b, 0), stDirection1h: hrSt[h]?.direction ?? null };
          if (!(cfg.exits.narrativeProxy && narrativeProxyHealthy(m, cfg.exits))) { close(i, price, "LOW_YIELD", d.reason); done = true; }
        }
      }
      if (!pos) continue;

      // Fees for this candle, only while price is inside the range.
      const idx = activeIndex(pos.bins, pool.binStep, k.c);
      let fee = 0;
      if (idx >= 0 && idx < pos.bins.length) {
        const poolFeesSol = k.vUsd * pool.feePct / 100 / k.solUsd;
        const near = liquidityNearPrice(pos.bins, pool.binStep, k.c, 3);
        fee = feeEstimate(poolFeesSol, near, pool.activeTvlUsd / k.solUsd) * feeMult;
      }
      pos.fees += fee;
      pos.feeLog.push(fee);

      // EvilPanda candle-close exit.
      const d = candleExitDecision(snapshotAt(s, i), cfg);
      if (d) close(i, k.c, d.rule, d.reason);
      continue;
    }

    // Entry: fresh break above Supertrend on the close of candle i → fill at the next open.
    const snap = snapshotAt(s, i);
    if (!snap?.stBreakUp || i + 1 >= candles.length) continue;
    const next = candles[i + 1];
    const p0 = next.o;
    const shape = cfg.shape.default;
    const capital = 1;
    const feeLog = [];
    pos = {
      t0: next.t, p0, capital, shape, fees: 0, feeLog, oor: null, peak: null,
      bins: buildBins({ capitalSol: capital, entryPrice: p0, binStep: pool.binStep, binsBelow, shape }),
      fee24h: () => {
        const last = feeLog.slice(-96).reduce((a, b) => a + b, 0);
        return feeLog.length ? last / capital * 100 : null;
      },
    };
    // The next iteration (candle i+1, the fill candle) evaluates exits on its own path.
  }
  if (pos) close(candles.length - 1, candles.at(-1).c, "END_OF_DATA", "still open at end of data");
  return trades;
}

/** Price at which position PnL equals `targetPct` (bisection), bounded by the gap price. */
function priceForPnl(pos, targetPct, pointPrice, openPrice) {
  const pnlAt = p => (valueAt(pos.bins, p).value + pos.fees) / pos.capital * 100 - 100;
  const openPnl = pnlAt(openPrice);
  // Gap: the candle opened beyond the threshold → fill at the open.
  if (targetPct < 0 ? openPnl <= targetPct : openPnl >= targetPct) return openPrice;
  let lo = Math.min(openPrice, pointPrice);
  let hi = Math.max(openPrice, pointPrice);
  for (let n = 0; n < 50; n++) {
    const mid = (lo + hi) / 2;
    // PnL is non-decreasing in price for a single-side SOL position.
    if (pnlAt(mid) < targetPct) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function summarize(trades) {
  if (!trades.length) return { trades: 0 };
  const pnl = trades.map(t => t.pnlPct).sort((a, b) => a - b);
  const sum = pnl.reduce((a, b) => a + b, 0);
  const byRule = {};
  for (const t of trades) {
    const r = (byRule[t.rule] ??= { n: 0, avgPnl: 0 });
    r.avgPnl = (r.avgPnl * r.n + t.pnlPct) / (r.n + 1);
    r.n++;
  }
  // Compounded growth if every trade used the same fraction of capital.
  return {
    trades: trades.length,
    winRatePct: trades.filter(t => t.pnlPct > 0).length / trades.length * 100,
    avgPnlPct: sum / trades.length,
    medianPnlPct: pnl[Math.floor(pnl.length / 2)],
    worstPnlPct: pnl[0],
    bestPnlPct: pnl.at(-1),
    totalPnlPct: sum,
    avgFeesPct: trades.reduce((a, t) => a + t.feesPct, 0) / trades.length,
    avgHeldMin: trades.reduce((a, t) => a + t.heldMin, 0) / trades.length,
    byRule,
  };
}
