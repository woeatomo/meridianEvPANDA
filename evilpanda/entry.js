// Pure entry trigger shared by the live engine and the backtest. No I/O.
//
// Every mode needs a Supertrend flip up on 15m (EvilPanda: "wait for price to
// break above Supertrend"). What differs is WHEN we open after that break:
//
//   breakout   on the break candle itself (original rule)
//   pullback   first close ≥ retracePct below the high made since the break,
//              while still above Supertrend (buy the dip inside the uptrend)
//   after_pump first close ≥ pumpPct above the break close (provide liquidity
//              after the pump so the range catches the retracement)
//   break_or_near  the break candle, OR later the first close that comes back
//              within nearStPct above the Supertrend line while the uptrend
//              holds (support retest; window nearWindowCandles)
//
// Signals fire only on the FIRST qualifying candle after a break, so a stateless
// check on the newest candle never re-triggers on the same setup.

function lastBreakUp(s, i, windowCandles) {
  for (let b = i; b > 0 && i - b <= windowCandles; b--) {
    const cur = s.st[b];
    const prev = s.st[b - 1];
    if (!cur || !prev) return null;
    if (cur.direction !== "up") return null; // trend broke after the flip → setup over
    if (prev.direction === "down") return b;
  }
  return null;
}

function qualifies(s, b, j, e) {
  const k = s.candles[j];
  if (!s.st[j] || s.st[j].direction !== "up" || !(k.c > s.st[j].value)) return false;
  if (e.mode === "pullback") {
    let hi = -Infinity;
    for (let x = b; x <= j; x++) hi = Math.max(hi, s.candles[x].h);
    return k.c <= hi * (1 - e.pullbackRetracePct / 100);
  }
  if (e.mode === "after_pump") return k.c >= s.candles[b].c * (1 + e.afterPumpPct / 100);
  if (e.mode === "break_or_near") {
    // A retest only counts after price first moved clearly away from the line
    // (> 2× nearStPct above it); otherwise the candles right after the break
    // would use up the signal.
    if ((k.c - s.st[j].value) / s.st[j].value > e.nearStPct / 100) return false;
    for (let x = b + 1; x < j; x++) {
      if ((s.candles[x].c - s.st[x].value) / s.st[x].value > (2 * e.nearStPct) / 100) return true;
    }
    return false;
  }
  return false;
}

/**
 * @param {object} s  indicators.series(candles)
 * @param {number} i  index of the newest CLOSED candle to evaluate
 * @param {{mode:string, signalWindowCandles:number, pullbackRetracePct:number, afterPumpPct:number}} e
 * @returns {{enter:boolean, reason?:string, breakIndex?:number}}
 */
export function entrySignal(s, i, e) {
  const mode = e?.mode ?? "breakout";
  if (i < 1 || !s.st[i] || !s.st[i - 1]) return { enter: false };
  if (mode === "breakout") {
    const on = s.st[i].direction === "up" && s.st[i - 1].direction === "down";
    return on ? { enter: true, reason: "close broke above Supertrend", breakIndex: i } : { enter: false };
  }
  if (mode === "break_or_near" && s.st[i].direction === "up" && s.st[i - 1].direction === "down") {
    return { enter: true, reason: "close broke above Supertrend", breakIndex: i };
  }
  const window = mode === "break_or_near" ? (e.nearWindowCandles ?? 48) : (e.signalWindowCandles ?? 16);
  const b = lastBreakUp(s, i, window);
  if (b == null || b === i) return { enter: false };
  if (!qualifies(s, b, i, { ...e, mode })) return { enter: false };
  for (let j = b + 1; j < i; j++) if (qualifies(s, b, j, { ...e, mode })) return { enter: false }; // already fired
  const reason = mode === "break_or_near"
    ? `close within ${e.nearStPct}% above Supertrend support, ${i - b} candle(s) after the break`
    : mode === "pullback"
    ? `pullback ${e.pullbackRetracePct}% from the high, ${i - b} candle(s) after the Supertrend break`
    : `+${e.afterPumpPct}% pump, ${i - b} candle(s) after the Supertrend break`;
  return { enter: true, reason, breakIndex: b };
}
