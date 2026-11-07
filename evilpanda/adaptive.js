// Pure adaptive range + pool scoring. No I/O.
//
// Range depth follows the token's own volatility: calm tokens get a shallow
// range (liquidity packed into fewer bins → more fees), wild tokens a deep one
// (room to absorb a dump before the stop loss). Volatility is ATR% on the same
// 15m candles the strategy already uses, so it can be backtested.

import { binsForDownsidePct } from "./range.js";

/** ATR (Wilder) of the last `period` candles as % of the last close. */
export function atrPct(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let atr = null;
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i];
    const pc = candles[i - 1].c;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    if (i <= period) { atr = (atr ?? 0) + tr / period; continue; }
    atr = (atr * (period - 1) + tr) / period;
  }
  const last = candles.at(-1).c;
  return last > 0 ? (atr / last) * 100 : null;
}

/** How far the last close is above the lowest low of the last `lookback` candles, in %. */
export function pumpPct(candles, lookback = 96) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const win = candles.slice(-lookback);
  const low = Math.min(...win.map(k => k.l));
  const last = candles.at(-1).c;
  return low > 0 ? (last / low - 1) * 100 : null;
}

/**
 * Range depth (% below entry) for this entry.
 * fixed:    targetDownsidePct
 * adaptive: linear from minDepthPct at atrLowPct to maxDepthPct at atrHighPct,
 *           + pumpBoostPct after a pump ≥ pumpThresholdPct, capped at capDepthPct.
 * Unknown volatility uses maxDepthPct (the safer, deeper range).
 * @returns {{ depthPct:number, reason:string, atrPct:number|null, pumpPct:number|null }}
 */
export function chooseDepth(candles, range) {
  if (range.mode !== "adaptive") {
    return { depthPct: range.targetDownsidePct, reason: "fixed", atrPct: null, pumpPct: null };
  }
  const a = range.adaptive;
  const atr = atrPct(candles, a.atrPeriod);
  const pump = pumpPct(candles, a.pumpLookbackCandles);
  let depth;
  let reason;
  if (atr == null) {
    depth = a.maxDepthPct;
    reason = "ATR unknown → max depth";
  } else {
    const t = Math.min(1, Math.max(0, (atr - a.atrLowPct) / (a.atrHighPct - a.atrLowPct)));
    depth = a.minDepthPct + t * (a.maxDepthPct - a.minDepthPct);
    reason = `ATR ${atr.toFixed(2)}%`;
  }
  if (pump != null && pump >= a.pumpThresholdPct) {
    depth += a.pumpBoostPct;
    reason += `, +${a.pumpBoostPct}% after ${pump.toFixed(0)}% pump`;
  }
  depth = Math.min(a.capDepthPct, Math.max(a.minDepthPct, depth));
  return { depthPct: Math.round(depth * 10) / 10, reason, atrPct: atr, pumpPct: pump };
}

/**
 * Expected-fee score for OUR position in a pool: pool fee per active-TVL
 * dollar ÷ bins our range needs. Fees only accrue in the active bin, so a
 * high-bin-step pool concentrates our SOL and earns a bigger share for the
 * same depth.
 */
export function expectedFeeScore(pool, depthPct, ratioField = "fee_active_tvl_ratio_1h") {
  const ratio = Number(pool?.[ratioField] ?? pool?.fee_active_tvl_ratio);
  const binStep = Number(pool?.dlmm_params?.bin_step);
  if (!(ratio > 0) || !(binStep > 0)) return 0;
  return ratio / binsForDownsidePct(depthPct, binStep);
}

/** Pools ranked by expected fee score, then TVL. */
export function rankByExpectedFee(pools, depthPct) {
  return [...pools]
    .map(p => ({ p, score: expectedFeeScore(p, depthPct) }))
    .sort((a, b) => b.score - a.score || (Number(b.p.tvl) || 0) - (Number(a.p.tvl) || 0) || String(a.p.pool_address).localeCompare(String(b.p.pool_address)))
    .map(x => Object.assign(x.p, { _score: x.score }));
}
