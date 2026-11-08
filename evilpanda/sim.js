// Pure DLMM position simulator for single-side SOL ranges, shared by the
// backtest and paper trading. No I/O.
//
// Model: the position spans `binsBelow` bins under the entry price. Bin i
// (0 = top, at the entry price) has price entry × (1+s)^-i and holds y_i SOL.
// When the market price falls below a bin, that bin's SOL has been sold for
// token at the bin price (x = y/price); when price rises back above it, the
// token is bought back at the same price. Ignoring fees, the position value
// therefore depends only on the current price — no path needed.
// Fees are modelled separately (see feeEstimate) and are the weakest part.

export function buildBins({ capitalSol, entryPrice, binStep, binsBelow, shape = "bid_ask" }) {
  const s = binStep / 10_000;
  const n = Math.max(1, Math.round(binsBelow));
  // Spot: equal SOL per bin. Bid-ask: weight grows linearly away from the entry
  // price (Meteora BidAsk on the SOL side puts the most SOL lowest).
  const weights = Array.from({ length: n }, (_, i) => (shape === "spot" ? 1 : i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => ({ price: entryPrice * Math.pow(1 + s, -i), y: capitalSol * w / total }));
}

/** Value in SOL at `price`, excluding fees. */
export function valueAt(bins, price) {
  let sol = 0;
  let tokenValue = 0;
  let tokens = 0;
  for (const b of bins) {
    if (price >= b.price) sol += b.y;
    else { const x = b.y / b.price; tokens += x; tokenValue += x * price; }
  }
  return { value: sol + tokenValue, sol, tokens, tokenValue };
}

/** Bin index the price sits in (may be <0 = above range, ≥ n = below range). */
export function activeIndex(bins, binStep, price) {
  const top = bins[0].price;
  return Math.floor(Math.log(top / price) / Math.log(1 + binStep / 10_000));
}

/** Position-shaped object compatible with evilpanda/exits.js. Bins are numbered top = n-1 … bottom = 0. */
export function positionView(bins, binStep, price, extra = {}) {
  const n = bins.length;
  const idx = activeIndex(bins, binStep, price);
  return { lower_bin: 0, upper_bin: n - 1, active_bin: n - 1 - idx, ...extra };
}

/**
 * SOL value of our liquidity near the current price — the part that earns fees.
 * `spanBins` either side of the active bin.
 */
export function liquidityNearPrice(bins, binStep, price, spanBins = 3) {
  const idx = activeIndex(bins, binStep, price);
  let v = 0;
  for (let i = Math.max(0, idx - spanBins); i <= Math.min(bins.length - 1, idx + spanBins); i++) {
    const b = bins[i];
    v += price >= b.price ? b.y : (b.y / b.price) * price;
  }
  return v;
}

/**
 * Fee estimate for one interval: pool fees in that interval × our share of the
 * liquidity around the active price.
 * @param {number} poolFeesSol   fees paid to LPs in the interval (SOL)
 * @param {number} ourNearSol    liquidityNearPrice(...)
 * @param {number} activeTvlSol  pool liquidity around the active price (SOL)
 */
export function feeEstimate(poolFeesSol, ourNearSol, activeTvlSol, maxShare = 1) {
  if (!(poolFeesSol > 0) || !(ourNearSol > 0) || !(activeTvlSol > 0)) return 0;
  return poolFeesSol * Math.min(maxShare, ourNearSol / (activeTvlSol + ourNearSol));
}
