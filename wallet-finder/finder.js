// Smart-wallet finder + automatic list manager (I/O). Used by the CLI
// (wallet-finder/run.js) and by the daemon's daily schedule.
//
// 1. Pools: busiest token/SOL DLMM pools (Meteora discovery API).
// 2. Wallets: owners of OPEN positions in those pools, read on-chain.
// 3. History: closed positions per wallet in the scanned pools (+ the pools the
//    wallet is in right now) from Meteora's /positions/{pool}/pnl API.
// 4. Score and filter (evilpanda/wallet-score.js), then optionally add/remove
//    wallets on smart-wallets.json (evilpanda/wallet-manage.js).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getJson } from "../evilpanda/sources.js";
import { walletMetrics, qualifyWallet, rankWallets, walletScore } from "../evilpanda/wallet-score.js";
import { removalReason, walletsToAdd } from "../evilpanda/wallet-manage.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets } from "../smart-wallets.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, "state.json");
const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));

export function loadFinderState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); return { wallets: s.wallets ?? {}, cooldown: s.cooldown ?? {}, lastRunAt: s.lastRunAt ?? 0 }; }
  catch { return { wallets: {}, cooldown: {}, lastRunAt: 0 }; }
}
function saveFinderState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* best-effort */ } }

function makeClient(c) {
  let last = 0;
  return async function meteora(url) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = last + c.requestDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try { return await getJson(url, { timeoutMs: 20_000 }); }
      catch (e) { if (!/HTTP 429|HTTP 5/.test(e.message) || attempt === 3) throw e; await sleep(2000 * (attempt + 1)); }
    }
  };
}

async function busiestPools(meteora, c, poolList) {
  if (poolList?.length) return poolList.map(a => ({ address: a, name: a.slice(0, 8) }));
  const params = new URLSearchParams({
    page_size: String(Math.max(c.pools * 3, 50)),
    filter_by: [`pool_type=dlmm`, `base_token_market_cap>=${config.evilpanda.screener.minMcap}`, `volume>=${c.minPoolVolume}`].join("&&"),
    timeframe: "24h",
    category: "trending",
  });
  const data = await meteora(`https://pool-discovery-api.datapi.meteora.ag/pools?${params}`);
  return (data?.data ?? [])
    .filter(p => p.token_y?.address === config.tokens.SOL && p.token_x?.address)
    .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
    .slice(0, c.pools)
    .map(p => ({ address: p.pool_address, name: p.name ?? p.pool_address.slice(0, 8) }));
}

// PositionV2 layout: 8-byte discriminator | lb_pair (32) | owner (32) | …
async function openOwners(conn, pool) {
  const accounts = await conn.getProgramAccounts(DLMM_PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 8, bytes: pool } }],
    dataSlice: { offset: 40, length: 32 },
  });
  const owners = new Map();
  for (const a of accounts) {
    if (a.account.data?.length !== 32) continue;
    const owner = new PublicKey(a.account.data).toBase58();
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
  }
  return owners;
}

async function closedPositions(meteora, pool, wallet) {
  const out = [];
  for (let page = 1; page <= 2; page++) {
    const data = await meteora(`https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${wallet}&status=closed&pageSize=50&page=${page}`);
    const list = Array.isArray(data?.positions) ? data.positions : [];
    out.push(...list);
    if (list.length < 50) break;
  }
  return out;
}

/** Pools where the wallet has open DLMM positions right now (null if unknown). */
async function openPoolsOf(meteora, wallet) {
  try {
    const data = await meteora(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}`);
    return Array.isArray(data?.pools) ? data.pools.map(p => p.poolAddress).filter(Boolean) : null;
  } catch { return null; }
}

/**
 * Scan pools, score candidate wallets and every wallet already on the list.
 * @param {{poolList?:string[], maxWallets?:number, progress?:(msg:string)=>void}} opts
 */
export async function scanAndScore(opts = {}) {
  const c = { ...config.evilpanda.walletFinder, ...(opts.maxWallets ? { maxWallets: opts.maxWallets } : {}), ...(opts.pools ? { pools: opts.pools } : {}) };
  const progress = opts.progress ?? (() => {});
  const rpcUrl = config.standalone.monitorRpcUrl;
  if (!rpcUrl) throw new Error("RPC_URL is not set in .env");
  const conn = new Connection(rpcUrl, "confirmed");
  const meteora = makeClient(c);

  const pools = await busiestPools(meteora, c, opts.poolList);
  if (!pools.length) throw new Error("No pools matched the scan filters (walletFinder.minPoolVolume / screener.minMcap).");
  progress(`Scanning ${pools.length} pool(s): ${pools.map(p => p.name).join(", ")}`);

  const seen = new Map();
  const rpcErrors = [];
  for (const p of pools) {
    try {
      const owners = await openOwners(conn, p.address);
      for (const [w, n] of owners) {
        const e = seen.get(w) ?? { pools: new Set(), positions: 0 };
        e.pools.add(p.address); e.positions += n;
        seen.set(w, e);
      }
      progress(`  ${p.name}: ${owners.size} wallet(s) with open positions`);
    } catch (e) {
      rpcErrors.push(e.message);
      progress(`  ${p.name}: on-chain read failed (${e.message})${/getProgramAccounts|disabled|not supported|403|410/i.test(e.message) ? " — your RPC plan may not allow getProgramAccounts" : ""}`);
    }
  }

  const listed = listSmartWallets()?.wallets ?? [];
  const listedSet = new Set(listed.map(w => w.address));
  const fresh = [...seen.entries()]
    .filter(([w]) => !listedSet.has(w))
    .sort((a, b) => b[1].pools.size - a[1].pools.size || b[1].positions - a[1].positions)
    .slice(0, c.maxWallets)
    .map(([w, info]) => ({ wallet: w, openInScan: info.pools.size, listed: false }));
  const toScore = [...fresh, ...listed.map(w => ({ wallet: w.address, openInScan: seen.get(w.address)?.pools.size ?? 0, listed: true }))];
  progress(`${seen.size} wallet(s) found; scoring ${fresh.length} new + ${listed.length} on your list…`);

  const rows = [];
  for (const [i, t] of toScore.entries()) {
    // Listed wallets are also judged on the pools they're in right now, so a
    // rotating set of scanned pools doesn't make them look idle.
    const openPools = t.listed ? await openPoolsOf(meteora, t.wallet) : null;
    const scanPools = [...new Set([...pools.map(p => p.address), ...(openPools ?? [])])];
    const byPool = [];
    try {
      for (const pool of scanPools) byPool.push({ pool, positions: await closedPositions(meteora, pool, t.wallet) });
    } catch (e) {
      progress(`  ${t.wallet.slice(0, 8)} history failed: ${e.message}`);
      continue;
    }
    const metrics = walletMetrics(byPool, t.openInScan);
    const why = qualifyWallet(metrics, c);
    rows.push({ wallet: t.wallet, listed: t.listed, metrics, pass: !why, why, activeNow: openPools == null ? null : openPools.length > 0 });
    if ((i + 1) % 10 === 0) progress(`  scored ${i + 1}/${toScore.length}`);
  }
  return { at: Date.now(), pools, seen: seen.size, rows, rpcErrors, filters: c };
}

/** Apply automatic add/remove decisions to smart-wallets.json. */
export function autoManage(result, now = Date.now()) {
  const a = config.evilpanda.walletFinder.auto;
  const c = { ...config.evilpanda.walletFinder, ...a };
  const state = loadFinderState();
  const listed = listSmartWallets()?.wallets ?? [];
  const rowOf = new Map(result.rows.map(r => [r.wallet, r]));
  const removed = [];
  const added = [];

  for (const w of listed) {
    const r = rowOf.get(w.address);
    const st = (state.wallets[w.address] ??= { firstSeenAt: now });
    // No data this run (API error) is not evidence of anything: never remove on it.
    if (!r || r.activeNow == null) continue;
    if (r?.activeNow) st.lastActiveAt = now;
    st.lastMetrics = r?.metrics ?? st.lastMetrics ?? null;
    const why = removalReason(w, { metrics: r?.metrics, activeNow: r?.activeNow === true, state: st }, c, now);
    if (!why) continue;
    const res = removeSmartWallet({ address: w.address });
    if (res?.success) {
      removed.push({ wallet: w.address, name: w.name, why });
      state.cooldown[w.address] = now + c.readdCooldownDays * 86_400_000;
      delete state.wallets[w.address];
    }
  }

  const current = new Set((listSmartWallets()?.wallets ?? []).map(w => w.address));
  for (const r of walletsToAdd(result.rows.filter(x => x.pass && !x.listed), current, state.cooldown, c, now)) {
    const res = addSmartWallet({ name: `auto-${r.wallet.slice(0, 6)}`, address: r.wallet, category: "finder", type: "lp" });
    if (res?.success) {
      added.push({ wallet: r.wallet, metrics: r.metrics });
      state.wallets[r.wallet] = { firstSeenAt: now, lastActiveAt: now, lastMetrics: r.metrics };
    }
  }
  for (const [w, until] of Object.entries(state.cooldown)) if (until < now) delete state.cooldown[w];
  state.lastRunAt = now;
  saveFinderState(state);
  return { added, removed, total: (listSmartWallets()?.wallets ?? []).length };
}

export function writeReport(result, managed = null) {
  const c = result.filters;
  const passed = rankWallets(result.rows.filter(r => r.pass && !r.listed));
  const listed = result.rows.filter(r => r.listed);
  const reasons = new Map();
  for (const r of result.rows) if (!r.pass && !r.listed) { const k = r.why.replace(/[\d.$%-]+/g, "#"); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  const row = (r, i) => `| ${i + 1} | \`${r.wallet}\` | ${f(walletScore(r.metrics), 1)} | ${r.metrics.closed} | ${r.metrics.poolsTraded} | ${f(r.metrics.winRatePct, 0)} | ${f(r.metrics.totalPnlSol, 3)} | ${f(r.metrics.medianPnlPct)} | ${f(r.metrics.worstPnlPct)} | ${f(r.metrics.avgDepositUsd, 0)} |`;
  const head = ["| # | Wallet | Score | Closed | Pools | Win % | PnL SOL | Median % | Worst % | Avg size $ |", "|---|---|---|---|---|---|---|---|---|---|"];
  const lines = [
    `# Smart wallet finder — ${new Date(result.at).toISOString().slice(0, 16)}`, "",
    `Pools scanned: ${result.pools.length} · wallets with open positions: ${result.seen} · **new qualified: ${passed.length}**`, "",
    `Filters: ${c.minClosed}–${c.maxClosed} closed, ≥${c.minPoolsTraded} pools, win ≥${c.minWinRatePct}%, PnL > ${c.minTotalPnlSol} SOL, median ≥${c.minMedianPnlPct}% (bot filter), size $${c.minAvgDepositUsd}–$${c.maxAvgDepositUsd}, worst ≥${c.maxWorstPnlPct}%.`, "",
  ];
  if (managed) {
    lines.push("## Automatic changes", "",
      ...(managed.added.length ? managed.added.map(a => `- ➕ added \`${a.wallet}\` (win ${f(a.metrics.winRatePct, 0)}%, median ${f(a.metrics.medianPnlPct)}%, ${a.metrics.closed} closed)`) : ["- no wallets added"]),
      ...(managed.removed.length ? managed.removed.map(r => `- ➖ removed \`${r.wallet}\` (${r.name}): ${r.why}`) : ["- no wallets removed"]),
      `- list size now: ${managed.total}`, "");
  }
  lines.push("## Your current list", "", "| Wallet | Active now | Closed | Win % | PnL SOL | Median % | Verdict |", "|---|---|---|---|---|---|---|",
    ...listed.map(r => `| \`${r.wallet}\` | ${r.activeNow == null ? "?" : r.activeNow ? "yes" : "no"} | ${r.metrics.closed} | ${f(r.metrics.winRatePct, 0)} | ${f(r.metrics.totalPnlSol, 3)} | ${f(r.metrics.medianPnlPct)} | ${r.pass ? "ok" : r.why} |`), "",
    "## New qualified wallets", "", ...head, ...passed.map(row), "",
    "## Why the others failed", "", ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${n}× ${k}`));
  const outDir = path.join(ROOT, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `wallets-${new Date(result.at).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  fs.writeFileSync(file, lines.join("\n"));
  return { file, passed };
}

/** Daemon job: scan, manage, report, notify. Safe to call on a timer. */
let running = false;
export async function dailyWalletJob(notify = async () => {}) {
  const a = config.evilpanda.walletFinder.auto;
  if (!a.enabled || running) return;
  const st = loadFinderState();
  if (Date.now() - st.lastRunAt < a.intervalHours * 3_600_000) return;
  running = true;
  try {
    log("wallet_finder", "Daily smart-wallet scan started");
    const result = await scanAndScore({ progress: m => log("wallet_finder", m) });
    if (result.rpcErrors.length === result.pools.length) throw new Error(`on-chain reads failed for every pool (${result.rpcErrors[0]})`);
    const managed = autoManage(result);
    const { file } = writeReport(result, managed);
    const msg = [
      `👛 Smart wallets: +${managed.added.length} / −${managed.removed.length} (list: ${managed.total})`,
      ...managed.added.map(x => `➕ ${x.wallet.slice(0, 8)} win ${f(x.metrics.winRatePct, 0)}% median ${f(x.metrics.medianPnlPct)}%`),
      ...managed.removed.map(x => `➖ ${x.wallet.slice(0, 8)} — ${x.why}`),
    ].join("\n");
    log("wallet_finder", `${msg.replace(/\n/g, " | ")} — report ${file}`);
    await notify(msg).catch(() => {});
  } catch (e) {
    log("wallet_finder", `Daily scan failed: ${e.message}`);
    const s = loadFinderState(); s.lastRunAt = Date.now() - (a.intervalHours - 2) * 3_600_000; saveFinderState(s); // retry in ~2h
  } finally {
    running = false;
  }
}
