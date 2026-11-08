// Pure smart-wallet scoring for the wallet finder. No I/O.
//
// Input: closed DLMM positions per wallet as returned by Meteora's
// /positions/{pool}/pnl?user=…&status=closed (the same API the bot already
// uses for its own closes). Output: per-wallet metrics, a pass/fail verdict
// with reasons, and a ranking.

const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Normalised fields of one closed position. */
export function closedPositionFacts(p) {
  return {
    pnlSol: num(p?.pnlSol) ?? num(p?.pnl?.valueNative),
    pnlUsd: num(p?.pnlUsd) ?? num(p?.pnl?.value),
    pnlPct: num(p?.pnlSolPctChange) ?? num(p?.pnl?.percentNative) ?? num(p?.pnlPctChange) ?? num(p?.pnl?.percent),
    depositUsd: num(p?.allTimeDeposits?.total?.usd),
    feesUsd: num(p?.allTimeFees?.total?.usd),
  };
}

/**
 * @param {Array<{pool:string, positions:object[]}>} byPool  closed positions of ONE wallet, grouped by pool
 * @param {number} openPools  pools where the wallet has an open position right now
 */
export function walletMetrics(byPool, openPools = 0) {
  const facts = byPool.flatMap(g => (g.positions || []).map(closedPositionFacts));
  const withPnl = facts.filter(f => f.pnlUsd != null || f.pnlSol != null);
  const wins = withPnl.filter(f => (f.pnlSol ?? f.pnlUsd) > 0).length;
  const sum = k => facts.reduce((a, f) => a + (f[k] ?? 0), 0);
  const deposits = facts.map(f => f.depositUsd).filter(v => v != null && v > 0);
  const pcts = facts.map(f => f.pnlPct).filter(v => v != null).sort((a, b) => a - b);
  return {
    closed: withPnl.length,
    poolsTraded: byPool.filter(g => g.positions?.length).length,
    openPools,
    winRatePct: withPnl.length ? (wins / withPnl.length) * 100 : null,
    totalPnlSol: sum("pnlSol"),
    totalPnlUsd: sum("pnlUsd"),
    feesUsd: sum("feesUsd"),
    avgDepositUsd: deposits.length ? deposits.reduce((a, b) => a + b, 0) / deposits.length : null,
    medianPnlPct: pcts.length ? pcts[Math.floor(pcts.length / 2)] : null,
    worstPnlPct: pcts.length ? pcts[0] : null,
  };
}

/** Pass/fail with the first failing reason. */
export function qualifyWallet(m, c) {
  if (m.closed < c.minClosed) return `only ${m.closed} closed position(s) (< ${c.minClosed})`;
  if (m.closed > c.maxClosed) return `${m.closed} closed positions (> ${c.maxClosed}, likely a bot/vault)`;
  if (m.poolsTraded < c.minPoolsTraded) return `traded ${m.poolsTraded} pool(s) (< ${c.minPoolsTraded})`;
  if (!(m.winRatePct >= c.minWinRatePct)) return `win rate ${m.winRatePct?.toFixed(0) ?? "?"}% (< ${c.minWinRatePct}%)`;
  if (!(m.totalPnlSol > c.minTotalPnlSol)) return `total PnL ${m.totalPnlSol.toFixed(3)} SOL (≤ ${c.minTotalPnlSol})`;
  // Market-making bots win almost every trade by a hair; their deposits are rebalances, not picks.
  if (c.minMedianPnlPct != null && !(m.medianPnlPct >= c.minMedianPnlPct)) return `bot-like: median PnL ${m.medianPnlPct?.toFixed(2) ?? "?"}% per position (< ${c.minMedianPnlPct}%)`;
  if (m.avgDepositUsd == null) return "position size unknown";
  if (m.avgDepositUsd < c.minAvgDepositUsd) return `avg size $${m.avgDepositUsd.toFixed(0)} (< $${c.minAvgDepositUsd})`;
  if (m.avgDepositUsd > c.maxAvgDepositUsd) return `avg size $${m.avgDepositUsd.toFixed(0)} (> $${c.maxAvgDepositUsd}, whale)`;
  if (c.maxWorstPnlPct != null && m.worstPnlPct != null && m.worstPnlPct < c.maxWorstPnlPct) return `worst position ${m.worstPnlPct.toFixed(1)}% (< ${c.maxWorstPnlPct}%)`;
  return null;
}

/**
 * Ranking score: consistency first (win rate, shrunk toward 50% for few trades),
 * then profit. Shrinkage stops a 3/3 wallet from beating a 40/50 wallet.
 */
export function walletScore(m) {
  const n = m.closed;
  const k = 10; // pseudo-trades at 50% win rate
  const shrunkWin = ((m.winRatePct ?? 0) / 100 * n + 0.5 * k) / (n + k);
  const profit = Math.sign(m.totalPnlSol) * Math.log10(1 + Math.abs(m.totalPnlSol) * 10);
  return shrunkWin * 100 + profit * 5;
}

export function rankWallets(rows) {
  return [...rows].sort((a, b) => walletScore(b.metrics) - walletScore(a.metrics));
}
