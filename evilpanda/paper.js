// Paper trading for shadow mode. Each "would deploy" becomes a simulated
// position priced from live Meteora data and managed by the same exit rules as
// real positions. Nothing here touches the wallet.

import fs from "node:fs";
import { repoPath } from "../repo-root.js";
import { buildBins, valueAt, positionView, liquidityNearPrice } from "./sim.js";

const FILE = repoPath("evilpanda-paper.json");

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { open: d.open ?? {}, closed: d.closed ?? [] };
  } catch {
    return { open: {}, closed: [] };
  }
}
let book = load();
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(book, null, 2)); } catch { /* best-effort */ } };

export function openPaper({ mint, pool, symbol, entryPrice, binStep, binsBelow, shape, capitalSol, sources }) {
  const reentry = book.closed.some(t => t.pool === pool);
  const id = `paper-${mint.slice(0, 6)}-${Date.now()}`;
  book.open[id] = {
    id, mint, pool, symbol, entryPrice, binStep, binsBelow, shape, capitalSol, sources, reentry,
    openedAt: Date.now(), lastAt: Date.now(), fees: 0, feeLog: [], peak: null, oor: null, lastPrice: entryPrice,
  };
  save();
  return book.open[id];
}

export function openPaperPositions() {
  return Object.values(book.open);
}

function bins(p) {
  return buildBins({ capitalSol: p.capitalSol, entryPrice: p.entryPrice, binStep: p.binStep, binsBelow: p.binsBelow, shape: p.shape });
}

/**
 * Advance one paper position with a fresh pool reading and return a
 * getMyPositions()-shaped view for the exit rules.
 * @param {object} pool  Meteora discovery row (timeframe 5m): pool_price, fee, active_tvl (USD)
 */
export function markPaper(id, pool, { nearSpanBins = 3, now = Date.now() } = {}) {
  const p = book.open[id];
  if (!p) return null;
  const price = Number(pool?.pool_price);
  if (!(price > 0)) return null;
  const b = bins(p);
  const view0 = positionView(b, p.binStep, price);
  const inRange = view0.active_bin >= view0.lower_bin && view0.active_bin <= view0.upper_bin;
  // Our fee share ≈ pool fees per active-TVL dollar × our liquidity near the price.
  const fee5m = Number(pool.fee);
  const activeTvl = Number(pool.active_tvl);
  const dtMin = Math.min(15, Math.max(0, (now - p.lastAt) / 60_000));
  let fee = 0;
  if (inRange && fee5m > 0 && activeTvl > 0) fee = (fee5m / activeTvl) * liquidityNearPrice(b, p.binStep, price, nearSpanBins) * (dtMin / 5);
  p.fees += fee;
  p.feeLog.push({ t: now, fee });
  p.feeLog = p.feeLog.filter(x => now - x.t <= 86_400_000);
  p.lastAt = now;
  p.lastPrice = price;
  const value = valueAt(b, price).value;
  const pnl = ((value + p.fees) / p.capitalSol - 1) * 100;
  p.peak = Math.max(p.peak ?? pnl, pnl);
  save();
  const fee24 = p.feeLog.reduce((a, x) => a + x.fee, 0);
  return positionView(b, p.binStep, price, {
    position: id,
    pool: p.pool,
    base_mint: p.mint,
    pair: `📝${p.symbol ?? p.mint.slice(0, 6)}`,
    pnl_pct: pnl,
    fee_per_tvl_24h: value > 0 ? (fee24 / value) * 100 : null,
    age_minutes: (now - p.openedAt) / 60_000,
    paper: true,
  });
}

/** Virtual free SOL for paper sizing: start + realised paper PnL − capital in open paper positions. */
export function virtualFreeSol(startSol) {
  const realised = book.closed.reduce((a, t) => a + (t.pnlSol || 0), 0);
  const locked = Object.values(book.open).reduce((a, p) => a + (p.capitalSol || 0), 0);
  return startSol + realised - locked;
}

export function paperPeak(id) {
  return book.open[id]?.peak ?? null;
}

export function closePaper(id, { rule, reason, slippagePct = 1, txSol = 0.003 }) {
  const p = book.open[id];
  if (!p) return null;
  const v = valueAt(bins(p), p.lastPrice);
  const final = v.value + p.fees - v.tokenValue * slippagePct / 100 - txSol;
  const trade = {
    id, mint: p.mint, symbol: p.symbol, pool: p.pool, shape: p.shape, sources: p.sources, reentry: p.reentry === true,
    openedAt: p.openedAt, closedAt: Date.now(), heldMin: Math.round((Date.now() - p.openedAt) / 60_000),
    rule, reason, capitalSol: p.capitalSol,
    pnlSol: final - p.capitalSol, pnlPct: (final / p.capitalSol - 1) * 100, feesSol: p.fees,
    priceMovePct: (p.lastPrice / p.entryPrice - 1) * 100,
  };
  book.closed.push(trade);
  delete book.open[id];
  save();
  return trade;
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Net-result stats for a group of closed paper trades. Win rate alone barely
 * separates profitable LPs from the rest (HALO study, 1.7M DLMM positions);
 * what does is how much of the earned fees survives price moves / IL:
 * feeKeptPct = net PnL ÷ fees × 100 (winners ~40%, the rest −1%).
 */
export function tradeStats(trades) {
  const pnlSol = trades.reduce((a, t) => a + (Number(t.pnlSol) || 0), 0);
  const feesSol = trades.reduce((a, t) => a + (Number(t.feesSol) || 0), 0);
  return {
    n: trades.length,
    winRatePct: trades.length ? Math.round(trades.filter(t => t.pnlSol > 0).length / trades.length * 100) : null,
    pnlSol: +pnlSol.toFixed(4),
    avgPnlPct: trades.length ? +(trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length).toFixed(2) : null,
    feesSol: +feesSol.toFixed(4),
    feeKeptPct: feesSol > 0 ? Math.round(pnlSol / feesSol * 100) : null,
    medianHeldMin: median(trades.map(t => t.heldMin).filter(Number.isFinite)),
  };
}

const groupBy = (trades, key) => {
  const m = {};
  for (const t of trades) (m[key(t)] ??= []).push(t);
  return Object.fromEntries(Object.entries(m).map(([k, ts]) => [k, tradeStats(ts)]));
};

export function summarizeTrades(c) {
  const all = tradeStats(c);
  return {
    closed: all.n,
    winRatePct: all.winRatePct,
    totalPnlSol: all.pnlSol,
    avgPnlPct: all.avgPnlPct,
    feesSol: all.feesSol,
    feeKeptPct: all.feeKeptPct,
    medianHeldMin: all.medianHeldMin,
    byShape: groupBy(c, t => t.shape ?? "unknown"),
    reentry: tradeStats(c.filter(t => t.reentry === true)),
    firstEntry: tradeStats(c.filter(t => t.reentry !== true)),
    byRule: c.reduce((m, t) => { (m[t.rule] ??= { n: 0, pnlSol: 0 }); m[t.rule].n++; m[t.rule].pnlSol = +(m[t.rule].pnlSol + t.pnlSol).toFixed(4); return m; }, {}),
  };
}

export function paperSummary() {
  const c = book.closed;
  return {
    open: Object.values(book.open).map(p => ({ id: p.id, symbol: p.symbol, shape: p.shape, reentry: p.reentry === true, ageMin: Math.round((Date.now() - p.openedAt) / 60_000), feesSol: +p.fees.toFixed(5), lastMovePct: +((p.lastPrice / p.entryPrice - 1) * 100).toFixed(2) })),
    ...summarizeTrades(c),
    last: c.slice(-10).map(t => ({ symbol: t.symbol, rule: t.rule, pnlPct: +t.pnlPct.toFixed(2), heldMin: t.heldMin, reentry: t.reentry === true })),
  };
}
