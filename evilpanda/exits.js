// Pure exit rules: Meridian rules (SL, TP, trailing, split OOR, low yield)
// combined with the EvilPanda Supertrend + confluence exit. No I/O.
//
// Position fields come from tools/dlmm.js getMyPositions():
//   pnl_pct, pnl_pct_suspicious, active_bin, lower_bin, upper_bin,
//   fee_per_tvl_24h, age_minutes
// Single-side SOL ranges sit BELOW the entry price:
//   OOR above ("kanan") = active_bin > upper_bin → position is all SOL
//   OOR below ("kiri")  = active_bin < lower_bin → position is all token

export function oorDirection(p) {
  if (p.active_bin == null || p.upper_bin == null || p.lower_bin == null) return null;
  if (p.active_bin > p.upper_bin) return "above";
  if (p.active_bin < p.lower_bin) return "below";
  return null;
}

/**
 * Track when the current OOR side started. Returns the new tracking record
 * { dir, since } (dir null when in range). Switching sides restarts the clock.
 */
export function updateOor(prev, p, now = Date.now()) {
  const dir = oorDirection(p);
  if (!dir) return { dir: null, since: null };
  if (prev?.dir === dir && prev.since) return prev;
  return { dir, since: now };
}

/**
 * Fast rules evaluated on every PnL poll.
 * @returns {{action:"CLOSE", rule:string, reason:string} | {action:"CHECK_LOW_YIELD", reason:string} | null}
 */
export function fastExitDecision(p, ctx, cfg, now = Date.now()) {
  const pnl = p.pnl_pct;
  const pnlOk = !p.pnl_pct_suspicious && pnl != null && Number.isFinite(pnl);
  const m = cfg.management;
  const e = cfg.exits;

  if (pnlOk && m.stopLossPct != null && pnl <= m.stopLossPct) {
    return { action: "CLOSE", rule: "STOP_LOSS", reason: `stop loss: PnL ${pnl.toFixed(2)}% <= ${m.stopLossPct}%` };
  }
  if (pnlOk && m.takeProfitPct != null && pnl >= m.takeProfitPct) {
    return { action: "CLOSE", rule: "TAKE_PROFIT", reason: `take profit: PnL ${pnl.toFixed(2)}% >= ${m.takeProfitPct}%` };
  }
  const peak = ctx.peakPnlPct;
  if (pnlOk && m.trailingTakeProfit && peak != null && peak >= m.trailingTriggerPct && peak - pnl >= m.trailingDropPct) {
    return { action: "CLOSE", rule: "TRAILING_TP", reason: `trailing TP: peak ${peak.toFixed(2)}% → ${pnl.toFixed(2)}%` };
  }

  const oor = ctx.oor;
  if (oor?.dir && oor.since != null) {
    const minutes = (now - oor.since) / 60_000;
    if (oor.dir === "above") {
      // Positive PnL: exit once it has stayed OOR-above for the wait period and is still positive.
      // Negative PnL: hold and let price come back; the stop loss above is the only exit.
      if (pnlOk && pnl > 0 && minutes >= e.oorAboveWaitMinutes) {
        return { action: "CLOSE", rule: "OOR_ABOVE", reason: `OOR above ${Math.floor(minutes)}m with PnL +${pnl.toFixed(2)}%` };
      }
    } else if (oor.dir === "below" && minutes >= e.oorBelowWaitMinutes) {
      return { action: "CLOSE", rule: "OOR_BELOW", reason: `OOR below for ${Math.floor(minutes)}m (limit ${e.oorBelowWaitMinutes}m)` };
    }
  }

  if (
    e.lowYieldMinFeePerTvl24h != null &&
    p.fee_per_tvl_24h != null &&
    p.fee_per_tvl_24h < e.lowYieldMinFeePerTvl24h &&
    (p.age_minutes ?? 0) >= e.lowYieldMinAgeMinutes
  ) {
    return { action: "CHECK_LOW_YIELD", reason: `low yield: fee/TVL ${p.fee_per_tvl_24h}% < ${e.lowYieldMinFeePerTvl24h}%` };
  }
  return null;
}

/**
 * EvilPanda candle exit, evaluated once per closed 15m candle.
 * Armed while the last closed candle is below Supertrend (support broken);
 * a close back above Supertrend disarms it. Fires on RSI(2) > 90 together with
 * a close above the BB upper band or the first green MACD histogram bar.
 */
export function candleExitDecision(snap, cfg) {
  if (!cfg.exits.stConfluence || !snap) return null;
  if (snap.stDirection !== "down") return null;
  if (!snap.exitConfluence) return null;
  const parts = [`RSI(2) ${snap.rsi.toFixed(1)}`];
  if (snap.aboveBbUpper) parts.push("close > BB upper");
  if (snap.macdFirstGreen) parts.push("first green MACD");
  return { action: "CLOSE", rule: "EP_CONFLUENCE", reason: `Supertrend broken + ${parts.join(" + ")}` };
}

/**
 * Narrative/momentum proxy for low-yield exits ("narasi dan potensi naik masih ada?").
 * Healthy when recent volume hasn't collapsed and the 1h trend is still up.
 * @param {{recentVolume:number, priorVolume:number, stDirection1h:string}|null} m
 */
export function narrativeProxyHealthy(m, e) {
  if (!m) return false;
  const ratio = m.priorVolume > 0 ? m.recentVolume / m.priorVolume : 0;
  return ratio >= e.minVolumeRatio && m.stDirection1h === "up";
}
