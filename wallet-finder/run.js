#!/usr/bin/env node
// Smart-wallet finder for Meteora DLMM. Read-only; needs internet + RPC_URL.
//
//   npm run find-wallets                     # scan the busiest token/SOL DLMM pools
//   npm run find-wallets -- --pools 25 --max-wallets 120
//   npm run find-wallets -- --pool-list ADDR1,ADDR2
//   npm run find-wallets -- --add 5          # also add the top 5 to smart-wallets.json
//
// 1. Pools: busiest token/SOL DLMM pools from Meteora's discovery API (or --pool-list).
// 2. Wallets: owners of OPEN positions in those pools, read on-chain (getProgramAccounts).
// 3. History: each wallet's CLOSED positions in all scanned pools (Meteora /pnl API).
// 4. Score: win rate (shrunk for small samples) + profit; filters in evilPanda.walletFinder.
// Report → wallet-finder/results/wallets-<time>.md

import "../envcrypt.js"; // load .env before config.js reads it
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { getJson } from "../evilpanda/sources.js";
import { walletMetrics, qualifyWallet, rankWallets, walletScore } from "../evilpanda/wallet-score.js";
import { addSmartWallet, listSmartWallets } from "../smart-wallets.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const SOL = config.tokens.SOL;
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const has = n => argv.includes(`--${n}`);
const c = { ...config.evilpanda.walletFinder };
if (flag("pools")) c.pools = Number(flag("pools"));
if (flag("max-wallets")) c.maxWallets = Number(flag("max-wallets"));
const addTop = Number(flag("add", 0)) || 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rpcUrl = config.standalone.monitorRpcUrl;
if (!rpcUrl) { console.error("RPC_URL is not set in .env"); process.exit(1); }
const conn = new Connection(rpcUrl, "confirmed");

let last = 0;
async function meteora(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + c.requestDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try { return await getJson(url, { timeoutMs: 20_000 }); }
    catch (e) { if (!/HTTP 429|HTTP 5/.test(e.message) || attempt === 3) throw e; await sleep(2000 * (attempt + 1)); }
  }
}

// ─── 1. Pools ───────────────────────────────────────────────────────────────
async function busiestPools() {
  if (flag("pool-list")) return String(flag("pool-list")).split(",").map(s => s.trim()).filter(Boolean).map(a => ({ address: a, name: a.slice(0, 8) }));
  const params = new URLSearchParams({
    page_size: String(Math.max(c.pools * 3, 50)),
    filter_by: [`pool_type=dlmm`, `base_token_market_cap>=${config.evilpanda.screener.minMcap}`, `volume>=${c.minPoolVolume}`].join("&&"),
    timeframe: "24h",
    category: "trending",
  });
  const data = await meteora(`https://pool-discovery-api.datapi.meteora.ag/pools?${params}`);
  return (data?.data ?? [])
    .filter(p => p.token_y?.address === SOL && p.token_x?.address)
    .sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
    .slice(0, c.pools)
    .map(p => ({ address: p.pool_address, name: p.name ?? p.pool_address.slice(0, 8) }));
}

// ─── 2. Wallets with open positions (on-chain) ──────────────────────────────
// PositionV2 layout: 8-byte discriminator | lb_pair (32) | owner (32) | …
async function openOwners(pool) {
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

// ─── 3. Closed-position history per wallet ──────────────────────────────────
async function closedPositions(pool, wallet) {
  const out = [];
  for (let page = 1; page <= 2; page++) {
    const data = await meteora(`https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${wallet}&status=closed&pageSize=50&page=${page}`);
    const list = Array.isArray(data?.positions) ? data.positions : [];
    out.push(...list);
    if (list.length < 50) break;
  }
  return out;
}

// ─── Run ────────────────────────────────────────────────────────────────────
let pools;
try { pools = await busiestPools(); }
catch (e) { console.error(`Cannot reach the Meteora API (${e.cause?.code ?? e.message}). Run this on the VPS.`); process.exit(1); }
if (!pools.length) { console.error("No pools matched the scan filters (walletFinder.minPoolVolume / screener.minMcap)."); process.exit(1); }
console.log(`Scanning ${pools.length} pool(s): ${pools.map(p => p.name).join(", ")}`);

const seen = new Map(); // wallet → { pools:Set, positions:number }
for (const p of pools) {
  try {
    const owners = await openOwners(p.address);
    for (const [w, n] of owners) {
      const e = seen.get(w) ?? { pools: new Set(), positions: 0 };
      e.pools.add(p.address); e.positions += n;
      seen.set(w, e);
    }
    console.log(`  ${p.name}: ${owners.size} wallet(s) with open positions`);
  } catch (e) {
    console.log(`  ${p.name}: on-chain read failed (${e.message})${/getProgramAccounts|disabled|not supported|403|410/i.test(e.message) ? " — your RPC plan may not allow getProgramAccounts" : ""}`);
  }
}

const already = new Set((listSmartWallets()?.wallets ?? []).map(w => w.address));
// Wallets active in several of the scanned pools first: they LP memecoins as a habit.
const candidates = [...seen.entries()]
  .filter(([w]) => !already.has(w))
  .sort((a, b) => b[1].pools.size - a[1].pools.size || b[1].positions - a[1].positions)
  .slice(0, c.maxWallets);
console.log(`\n${seen.size} wallet(s) found, scoring ${candidates.length} (${already.size} already in your list skipped)…`);

const rows = [];
const reasons = new Map();
for (const [i, [wallet, info]] of candidates.entries()) {
  const byPool = [];
  try {
    for (const p of pools) byPool.push({ pool: p.address, positions: await closedPositions(p.address, wallet) });
  } catch (e) {
    console.log(`  [${i + 1}/${candidates.length}] ${wallet.slice(0, 8)} history failed: ${e.message}`);
    continue;
  }
  const metrics = walletMetrics(byPool, info.pools.size);
  const why = qualifyWallet(metrics, c);
  rows.push({ wallet, metrics, pass: !why, why });
  if (why) reasons.set(why.replace(/[\d.$%-]+/g, "#"), (reasons.get(why.replace(/[\d.$%-]+/g, "#")) ?? 0) + 1);
  if ((i + 1) % 10 === 0) console.log(`  scored ${i + 1}/${candidates.length}`);
}

const passed = rankWallets(rows.filter(r => r.pass));
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));
const lines = [
  `# Smart wallet finder — ${new Date().toISOString().slice(0, 16)}`, "",
  `Pools scanned: ${pools.length} · wallets with open positions: ${seen.size} · scored: ${rows.length} · **qualified: ${passed.length}**`, "",
  `Filters: ≥${c.minClosed} closed positions (≤${c.maxClosed}), ≥${c.minPoolsTraded} pools, win rate ≥${c.minWinRatePct}%, total PnL > ${c.minTotalPnlSol} SOL, avg size $${c.minAvgDepositUsd}–$${c.maxAvgDepositUsd}${c.maxWorstPnlPct != null ? `, worst position ≥ ${c.maxWorstPnlPct}%` : ""}.`, "",
  "History = closed positions **in the scanned pools only** (recent memecoin pools), not the wallet's whole life.", "",
  "## Qualified wallets", "",
  "| # | Wallet | Score | Closed | Pools | Win % | PnL SOL | Median % | Worst % | Fees $ | Avg size $ |", "|---|---|---|---|---|---|---|---|---|---|---|",
  ...passed.map((r, i) => `| ${i + 1} | \`${r.wallet}\` | ${f(walletScore(r.metrics), 1)} | ${r.metrics.closed} | ${r.metrics.poolsTraded} | ${f(r.metrics.winRatePct, 0)} | ${f(r.metrics.totalPnlSol, 3)} | ${f(r.metrics.medianPnlPct)} | ${f(r.metrics.worstPnlPct)} | ${f(r.metrics.feesUsd)} | ${f(r.metrics.avgDepositUsd, 0)} |`),
  "", "## Why the others failed", "",
  ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${n}× ${k}`),
  "", "## Add to the bot", "",
  "Telegram: `/addwallet <address> <name>` · or rerun with `--add N` to add the top N.",
];
const outDir = path.join(ROOT, "results");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `wallets-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
fs.writeFileSync(file, lines.join("\n"));

console.log(`\nQualified: ${passed.length}`);
for (const [i, r] of passed.slice(0, 10).entries()) console.log(`  ${i + 1}. ${r.wallet}  win ${f(r.metrics.winRatePct, 0)}%  PnL ${f(r.metrics.totalPnlSol, 3)} SOL  (${r.metrics.closed} closed, ${r.metrics.poolsTraded} pools)`);
if (addTop > 0) {
  for (const r of passed.slice(0, addTop)) {
    const res = addSmartWallet({ name: `finder-${r.wallet.slice(0, 6)}`, address: r.wallet, category: "finder", type: "lp" });
    console.log(`  + ${r.wallet.slice(0, 8)}: ${res?.success ? "added" : res?.error ?? "not added"}`);
  }
  console.log("Restart the bot to start watching them: pm2 restart evpanda");
}
console.log(`Report: ${file}`);
process.exit(0);
