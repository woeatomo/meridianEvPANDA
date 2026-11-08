// Pure add/remove decisions for the automatic smart-wallet list. No I/O.

import { qualifyWallet, rankWallets } from "./wallet-score.js";

/**
 * Should a wallet already on the list be removed?
 * - performance: enough fresh history and it now fails the quality rules
 *   (turned unprofitable, win rate dropped, bot-like, blow-up)
 * - inactivity: no open DLMM position anywhere for `inactiveDays`
 * Wallets in category "pinned" are never removed.
 * @returns {string|null} reason
 */
export function removalReason(entry, { metrics, activeNow, state }, cfg, now = Date.now()) {
  if (entry.category === "pinned") return null;
  const addedAt = Date.parse(entry.addedAt ?? "") || state?.firstSeenAt || now;
  const ageDays = (now - addedAt) / 86_400_000;
  if (metrics && metrics.closed >= cfg.removeMinClosed) {
    const why = qualifyWallet(metrics, { ...cfg, minClosed: cfg.removeMinClosed, minPoolsTraded: 1 });
    if (why) return `performance: ${why}`;
  }
  const lastActive = activeNow ? now : (state?.lastActiveAt ?? addedAt);
  const idleDays = (now - lastActive) / 86_400_000;
  if (ageDays >= cfg.inactiveDays && idleDays >= cfg.inactiveDays) return `inactive: no open DLMM position for ${idleDays.toFixed(1)} days`;
  return null;
}

/**
 * Which qualified wallets to add: best-ranked first, skipping ones already on
 * the list or removed recently, up to `addPerRun` and the `maxWallets` cap.
 */
export function walletsToAdd(qualifiedRows, currentAddresses, cooldown, cfg, now = Date.now()) {
  const room = Math.max(0, cfg.maxWallets - currentAddresses.size);
  const limit = Math.min(room, cfg.addPerRun);
  const out = [];
  for (const r of rankWallets(qualifiedRows)) {
    if (out.length >= limit) break;
    if (currentAddresses.has(r.wallet)) continue;
    const until = cooldown?.[r.wallet];
    if (until && until > now) continue;
    out.push(r);
  }
  return out;
}
