// Pure range math for single-side SOL DLMM positions. No I/O.
//
// Meteora bin price: price(bin) = price(active) × (1 + binStep/10000)^(bin - active).
// A single-side SOL position spans [active - binsBelow, active].
// Bin arrays hold 70 bins each; index = floor(binId / 70).

export const BINS_PER_ARRAY = 70;

export function binArrayIndex(binId) {
  return Math.floor(binId / BINS_PER_ARRAY);
}

/** Bins needed so the range bottom sits `downsidePct`% below the active price. */
export function binsForDownsidePct(downsidePct, binStep) {
  const d = Number(downsidePct);
  const s = Number(binStep);
  if (!(d > 0 && d < 100) || !(s > 0)) throw new Error(`Invalid downside ${downsidePct}% or bin step ${binStep}`);
  return Math.ceil(Math.log(1 / (1 - d / 100)) / Math.log(1 + s / 10000));
}

/** Downside % covered by `bins` bins below the active bin. */
export function downsidePctForBins(bins, binStep) {
  return (1 - Math.pow(1 + Number(binStep) / 10000, -Number(bins))) * 100;
}

/**
 * Shrink a target range so it only touches bin arrays that already exist,
 * meaning the deploy never pays non-refundable bin-array rent.
 *
 * Walks down from the active bin's array; the first missing array ends the
 * usable range. Returns { minBinId, shrunk, binsBelow } or null when even the
 * active bin's own array is missing (nothing deployable without rent).
 *
 * @param {number} activeBinId
 * @param {number} targetMinBinId  desired bottom bin (≤ activeBinId)
 * @param {(index:number)=>boolean} isInitialized  bin-array existence lookup
 */
export function shrinkToInitialized(activeBinId, targetMinBinId, isInitialized) {
  if (targetMinBinId > activeBinId) throw new Error("targetMinBinId must be ≤ activeBinId");
  const top = binArrayIndex(activeBinId);
  const bottom = binArrayIndex(targetMinBinId);
  if (!isInitialized(top)) return null;
  let lowestOk = top;
  for (let idx = top - 1; idx >= bottom; idx--) {
    if (!isInitialized(idx)) break;
    lowestOk = idx;
  }
  const minBinId = Math.max(targetMinBinId, lowestOk * BINS_PER_ARRAY);
  return { minBinId, shrunk: minBinId !== targetMinBinId, binsBelow: activeBinId - minBinId };
}

/** All bin-array indexes touched by [minBinId, maxBinId]. */
export function binArrayIndexesFor(minBinId, maxBinId) {
  const out = [];
  for (let idx = binArrayIndex(minBinId); idx <= binArrayIndex(maxBinId); idx++) out.push(idx);
  return out;
}
