// Pure technical indicators for the EvilPanda strategy. No I/O.
//
// Candles are objects { t, o, h, l, c, v } ordered oldest → newest and must
// contain CLOSED candles only (drop the still-forming candle before calling).
// Conventions match TradingView defaults so values line up with the chart
// EvilPanda uses: Wilder (RMA) smoothing for ATR/RSI, SMA basis + population
// standard deviation for Bollinger Bands, EMA for MACD.

function rma(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v;
      count++;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v;
      count++;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI with Wilder smoothing (TradingView `ta.rsi`). */
export function rsi(closes, period = 2) {
  const gains = [null];
  const losses = [null];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  return closes.map((_, i) => {
    if (avgGain[i] == null || avgLoss[i] == null) return null;
    if (avgLoss[i] === 0) return avgGain[i] === 0 ? 50 : 100;
    const rs = avgGain[i] / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });
}

/** MACD line, signal and histogram (TradingView defaults 12/26/9). */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => (fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null));
  const signalLine = ema(line, signal);
  const hist = line.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
  return { line, signal: signalLine, hist };
}

/** Bollinger Bands: SMA basis ± mult × population stdev. */
export function bollinger(closes, period = 20, mult = 2) {
  const upper = new Array(closes.length).fill(null);
  const middle = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
}

/**
 * Supertrend (TradingView `ta.supertrend`, ATR via RMA).
 * Returns per-candle { value, direction } where direction is "up" (price above
 * the line = support) or "down" (price below the line = resistance).
 */
export function supertrend(candles, period = 10, multiplier = 3) {
  const tr = candles.map((k, i) => {
    if (i === 0) return k.h - k.l;
    const pc = candles[i - 1].c;
    return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
  });
  const atr = rma(tr, period);
  const out = new Array(candles.length).fill(null);
  let prevUpper = null;
  let prevLower = null;
  let prevDir = null;
  for (let i = 0; i < candles.length; i++) {
    if (atr[i] == null) continue;
    const k = candles[i];
    const hl2 = (k.h + k.l) / 2;
    let upper = hl2 + multiplier * atr[i];
    let lower = hl2 - multiplier * atr[i];
    const prevClose = i > 0 ? candles[i - 1].c : k.c;
    if (prevLower != null) lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    if (prevUpper != null) upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    let dir;
    if (prevDir == null) dir = k.c >= hl2 ? "up" : "down";
    else if (prevDir === "down") dir = k.c > prevUpper ? "up" : "down";
    else dir = k.c < prevLower ? "down" : "up";
    out[i] = { value: dir === "up" ? lower : upper, direction: dir };
    prevUpper = upper;
    prevLower = lower;
    prevDir = dir;
  }
  return out;
}

/**
 * One snapshot of every signal the strategy needs, evaluated on the newest
 * closed candle. Returns null when there is not enough history.
 */
export function snapshot(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  return snapshotAt(series(candles, opts), candles.length - 1);
}

const DEFAULTS = {
  stPeriod: 10, stMultiplier: 3, rsiPeriod: 2, rsiUpper: 90,
  bbPeriod: 20, bbStdDev: 2, macdFast: 12, macdSlow: 26, macdSignal: 9,
};

/**
 * Every indicator over the whole series at once. Each value at index i only
 * uses candles ≤ i, so snapshotAt(series, i) equals snapshot(candles[0..i]) —
 * this is what lets the backtest run without lookahead in O(n).
 */
export function series(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const closes = candles.map(k => k.c);
  return {
    o,
    candles,
    closes,
    minNeeded: Math.max(o.stPeriod + 2, o.bbPeriod + 1, o.macdSlow + o.macdSignal + 1),
    st: supertrend(candles, o.stPeriod, o.stMultiplier),
    r: rsi(closes, o.rsiPeriod),
    m: macd(closes, o.macdFast, o.macdSlow, o.macdSignal),
    bb: bollinger(closes, o.bbPeriod, o.bbStdDev),
  };
}

export function snapshotAt(s, i) {
  const { o, candles, closes, st, r, m, bb } = s;
  if (i < 1 || i + 1 < s.minNeeded) return null;
  if (st[i] == null || st[i - 1] == null || r[i] == null || m.hist[i] == null || m.hist[i - 1] == null || bb.upper[i] == null) return null;
  const close = closes[i];
  const rsiOver = r[i] > o.rsiUpper;
  const aboveBbUpper = close > bb.upper[i];
  const macdFirstGreen = m.hist[i] > 0 && m.hist[i - 1] <= 0;
  return {
    time: candles[i].t,
    close,
    supertrend: st[i].value,
    stDirection: st[i].direction,
    stPrevDirection: st[i - 1].direction,
    // Fresh break above: this candle flipped the trend up.
    stBreakUp: st[i].direction === "up" && st[i - 1].direction === "down",
    stBreakDown: st[i].direction === "down" && st[i - 1].direction === "up",
    rsi: r[i],
    rsiOver,
    bbUpper: bb.upper[i],
    aboveBbUpper,
    macdHist: m.hist[i],
    macdFirstGreen,
    // EvilPanda exit confluence: RSI(2) > upper AND (close > BB upper OR first green MACD bar).
    exitConfluence: rsiOver && (aboveBbUpper || macdFirstGreen),
  };
}

/** Index of the most recent candle where Supertrend flipped up, counted back from the newest (0 = newest). */
export function candlesSinceBreakUp(candles, opts = {}) {
  const st = supertrend(candles, opts.stPeriod ?? 10, opts.stMultiplier ?? 3);
  for (let i = st.length - 1, back = 0; i > 0; i--, back++) {
    if (!st[i] || !st[i - 1]) return null;
    if (st[i].direction === "up" && st[i - 1].direction === "down") return back;
    if (st[i].direction === "down") return null;
  }
  return null;
}
