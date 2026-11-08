#!/usr/bin/env node
// EvilPanda backtest runner. Needs internet (run it on the VPS, not in CI).
//
//   npm run backtest -- --lessons /path/to/old-bot/lessons.json
//   npm run backtest -- --mints MINT1,MINT2 --days 30
//
// Options:
//   --lessons FILE   use the mints/pools/time windows of positions in an old lessons.json
//   --mints a,b,c    explicit mints (window = last --days)
//   --days N         history window for --mints (default 30, max ~180 on GeckoTerminal free)
//   --max N          cap number of tokens (default 60)
//   --out DIR        report folder (default backtest/results)
//   --refresh        ignore the local data cache
//   --debug          print every GeckoTerminal request and how many candles it returned
//
// Data is cached in backtest/cache/ so re-runs (other settings) are offline.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getJson, poolsForMint, discoveryPool } from "../evilpanda/sources.js";
import { rankPools } from "../evilpanda/filters.js";
import { simulateMint, summarize, modelFeesForPosition } from "../evilpanda/backtest-core.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";
const SOL = config.tokens.SOL;
const DAY = 86_400_000;

// ─── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] ?? true) : dflt; };
const has = name => argv.includes(`--${name}`);
const outDir = path.resolve(flag("out", path.join(ROOT, "results")));
const cacheDir = path.join(ROOT, "cache");
const days = Math.min(180, Number(flag("days", 30)));
const maxTokens = Number(flag("max", 60));
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastGecko = 0;
async function gecko(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastGecko + config.evilpanda.chart.requestDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastGecko = Date.now();
    try { return await getJson(url, { timeoutMs: 20_000 }); }
    catch (e) {
      if (!/HTTP 429/.test(e.message) || attempt === 3) throw e;
      await sleep(15_000 * (attempt + 1));
    }
  }
}

function cached(key, fn) {
  const file = path.join(cacheDir, `${key.replace(/[^\w.-]/g, "_")}.json`);
  if (!has("refresh") && fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8")));
  // Empty results are never cached, so a temporary API problem doesn't stick.
  return fn().then(data => {
    const empty = data == null || (Array.isArray(data) && data.length === 0);
    if (!empty) fs.writeFileSync(file, JSON.stringify(data));
    return data;
  });
}

/** 15m USD candles for `token` in `pool` between [from, to], paging backwards. */
async function fetchCandles(pool, token, from, to) {
  const out = await fetchCandlesAs(pool, token, from, to);
  // Some pools only answer with token=base/quote; try those before giving up.
  if (out.length || token === "base") return out;
  for (const side of ["base", "quote"]) {
    const alt = await fetchCandlesAs(pool, side, from, to);
    if (alt.length) { debug(`   ${pool.slice(0, 8)}: token=${token.slice(0, 6)} empty, using token=${side}`); return alt; }
  }
  return out;
}

const debug = (...a) => { if (has("debug")) console.log(...a); };

async function fetchCandlesAs(pool, token, from, to) {
  const all = new Map();
  let before = Math.floor(to / 1000);
  for (let page = 0; page < 30; page++) {
    const q = new URLSearchParams({ aggregate: "15", limit: "1000", currency: "usd", token, before_timestamp: String(before) });
    const url = `${GECKO}/pools/${pool}/ohlcv/minute?${q}`;
    const data = await gecko(url);
    const list = data?.data?.attributes?.ohlcv_list ?? [];
    if (page === 0) debug(`   GET ${url} → ${list.length} candles${list.length ? ` (${new Date(list.at(-1)[0] * 1000).toISOString()} … ${new Date(list[0][0] * 1000).toISOString()})` : ""}`);
    if (!list.length) break;
    let earliest = Infinity;
    for (const [t, o, h, l, c, v] of list) {
      all.set(t * 1000, { t: t * 1000, o: +o, h: +h, l: +l, c: +c, vUsd: +v });
      earliest = Math.min(earliest, t);
    }
    if (earliest * 1000 <= from || list.length < 1000) break;
    before = earliest;
  }
  return [...all.values()].filter(k => k.t >= from && k.t + 900_000 <= to && k.c > 0).sort((a, b) => a.t - b.t);
}

// ─── Inputs ─────────────────────────────────────────────────────────────────
function loadTargets() {
  const now = Date.now();
  if (flag("lessons")) {
    const data = JSON.parse(fs.readFileSync(flag("lessons"), "utf8"));
    const perf = Array.isArray(data?.performance) ? data.performance : [];
    const byMint = new Map();
    for (const p of perf) {
      const mint = p.base_mint || p.signal_snapshot?.base_mint;
      if (!mint) continue;
      const t0 = Date.parse(p.deployed_at || p.recorded_at);
      const t1 = Date.parse(p.recorded_at || p.deployed_at);
      const e = byMint.get(mint) ?? { mint, pools: new Set(), name: p.pool_name, binStep: p.bin_step, tvls: [], from: Infinity, to: 0, old: [] };
      if (Number(p.entry_tvl) > 0) e.tvls.push(Number(p.entry_tvl));
      if (Number(p.initial_value_usd) > 0 && Number(p.minutes_held) > 0) e.feeYieldsPerHour = [...(e.feeYieldsPerHour ?? []), (Number(p.fees_earned_usd) || 0) / Number(p.initial_value_usd) * 100 / (Number(p.minutes_held) / 60)];
      if (p.pool) e.pools.add(p.pool);
      if (Number.isFinite(t0)) e.from = Math.min(e.from, t0);
      if (Number.isFinite(t1)) e.to = Math.max(e.to, t1);
      e.old.push({
        pnl: p.pnl_pct, reason: p.close_reason,
        // for fee calibration
        t1: Number.isFinite(t1) ? t1 : null,
        heldMin: Number(p.minutes_held) || 0,
        amountSol: Number(p.amount_sol) || 0,
        binsBelow: Number(p.bin_range?.bins_below) || null,
        shape: p.strategy === "spot" ? "spot" : "bid_ask",
        feesUsd: Number(p.fees_earned_usd) || 0,
        tvl: Number(p.entry_tvl) || null,
      });
      byMint.set(mint, e);
    }
    return [...byMint.values()].map(e => ({
      ...e,
      pools: [...e.pools],
      // TVL the pool really had back then (from the old bot), instead of today's — dead pools have ~0 TVL now.
      entryTvl: e.tvls.length ? e.tvls.sort((a, b) => a - b)[Math.floor(e.tvls.length / 2)] : null,
      // Warm-up before the first old entry, and room after the last exit.
      from: (Number.isFinite(e.from) ? e.from : now - days * DAY) - 2 * DAY,
      evalFrom: Number.isFinite(e.from) ? e.from - 12 * 3_600_000 : now - days * DAY,
      to: Math.min(now, (e.to || now) + 3 * DAY),
    })).slice(0, maxTokens);
  }
  const mints = String(flag("mints", "")).split(",").map(s => s.trim()).filter(Boolean);
  if (!mints.length) { console.error("Give --lessons FILE or --mints a,b,c"); process.exit(1); }
  return mints.slice(0, maxTokens).map(mint => ({ mint, pools: [], from: now - days * DAY - 2 * DAY, evalFrom: now - days * DAY, to: now, old: [] }));
}

async function poolInfo(t) {
  let address = t.pools[0] ?? null;
  let p = null;
  if (address) p = await discoveryPool(address, "24h").catch(() => null);
  if (!p) {
    const list = await poolsForMint(t.mint, SOL).catch(() => []);
    const rows = [];
    for (const a of list.slice(0, 5)) { const r = await discoveryPool(a, "24h").catch(() => null); if (r) rows.push(r); }
    p = rankPools(rows, config.evilpanda.pool.preferHighBinStep)[0] ?? null;
    if (p) address = p.pool_address;
  }
  const binStep = Number(p?.dlmm_params?.bin_step ?? t.binStep);
  if (!address || !(binStep > 0)) return null;
  return {
    address,
    name: p?.name ?? t.name ?? t.mint.slice(0, 8),
    binStep,
    feePct: Number(p?.fee_pct) > 0 ? Number(p.fee_pct) : 1,
    activeTvlUsd: Number(p?.active_tvl) > 0 ? Number(p.active_tvl) : Number(p?.tvl ?? t.entryTvl ?? 20_000),
    assumed: !p,
  };
}

// ─── Variants ───────────────────────────────────────────────────────────────
const ep = config.evilpanda;
const base = {
  management: { ...config.management },
  exits: { ...ep.exits },
  range: { ...ep.range, adaptive: { ...ep.range.adaptive } },
  shape: { ...ep.shape },
  chart: { ...ep.chart },
  costs: { txSol: 0.003, swapSlippagePct: 1 },
  feeModel: { maxShare: 0.5 },
};
const VARIANTS = {
  "config-kamu": base,
  "murni-evilpanda": { ...base, management: { ...base.management, takeProfitPct: null, trailingTakeProfit: false }, exits: { ...base.exits, oorAboveWaitMinutes: Infinity, oorBelowWaitMinutes: Infinity, lowYieldMinFeePerTvl24h: null } },
  "range-85-tetap": { ...base, range: { ...base.range, mode: "fixed", targetDownsidePct: 85 } },
  "range-70-tetap": { ...base, range: { ...base.range, mode: "fixed", targetDownsidePct: 70 } },
  "range-50-tetap": { ...base, range: { ...base.range, mode: "fixed", targetDownsidePct: 50 } },
  "spot": { ...base, shape: { ...base.shape, default: "spot" } },
  "oor-atas-min1%": { ...base, exits: { ...base.exits, oorAboveMinPnlPct: 1 } },
  "low-yield-6jam": { ...base, exits: { ...base.exits, lowYieldMinAgeMinutes: 360 } },
  "tanpa-low-yield": { ...base, exits: { ...base.exits, lowYieldMinFeePerTvl24h: null } },
};
const FEE_SCENARIOS = { rendah: 0.5, sedang: 1, tinggi: 2 };

// ─── Run ────────────────────────────────────────────────────────────────────
const targets = loadTargets();
console.log(`Backtest ${targets.length} token(s) — variants: ${Object.keys(VARIANTS).join(", ")}`);

let solPools;
try {
  solPools = await cached("sol-usd-pools", async () => {
    const list = (await gecko(`${GECKO}/tokens/${SOL}/pools?page=1`))?.data ?? [];
    const addrs = list.map(p => p?.attributes?.address).filter(Boolean).slice(0, 5);
    if (!addrs.length) throw new Error("no SOL/USD pool found");
    return addrs;
  });
} catch (e) {
  console.error(`Cannot reach GeckoTerminal (${e.cause?.code ?? e.message}). The backtest needs internet — run it on the VPS.`);
  process.exit(1);
}

/** SOL/USD 15m candles for a window, trying the most liquid SOL pools in turn. */
async function solCandles(from, to) {
  return cached(`sol-${Math.floor(from / DAY)}-${Math.floor(to / DAY)}`, async () => {
    for (const pool of solPools) {
      const ks = await fetchCandlesAs(pool, SOL, from, to).catch(() => []);
      if (ks.length) return ks;
      debug(`   SOL pool ${pool.slice(0, 8)} returned no candles, trying next`);
    }
    return [];
  });
}
const loaded = [];
const results = Object.fromEntries(Object.keys(VARIANTS).map(v => [v, Object.fromEntries(Object.keys(FEE_SCENARIOS).map(f => [f, []]))]));
const perToken = [];

for (const [n, t] of targets.entries()) {
  const label = `[${n + 1}/${targets.length}] ${t.mint.slice(0, 8)}`;
  try {
    const pool = await cached(`pool-${t.mint}`, () => poolInfo(t));
    if (!pool) { console.log(`${label} skipped: no DLMM pool / bin step`); perToken.push({ mint: t.mint, skipped: "no pool" }); continue; }
    const raw = await cached(`c15-${pool.address}-${Math.floor(t.from / DAY)}-${Math.floor(t.to / DAY)}`, () => fetchCandles(pool.address, t.mint, t.from, t.to));
    const sol = await solCandles(t.from, t.to);
    if (!sol.length) { console.log(`${label} skipped: SOL/USD price history unavailable for ${new Date(t.from).toISOString().slice(0, 10)}…${new Date(t.to).toISOString().slice(0, 10)}`); perToken.push({ mint: t.mint, name: pool.name, skipped: "no SOL price history" }); continue; }
    const solAt = new Map(sol.map(k => [k.t, k.c]));
    let lastSol = sol[0]?.c;
    const candles = raw.map(k => {
      lastSol = solAt.get(k.t) ?? lastSol;
      return { t: k.t, o: k.o / lastSol, h: k.h / lastSol, l: k.l / lastSol, c: k.c / lastSol, vUsd: k.vUsd, solUsd: lastSol };
    }).filter(k => k.solUsd > 0);
    if (candles.length < 80) { console.log(`${label} skipped: only ${candles.length} candles (pool ${pool.address.slice(0, 8)}: ${raw.length} raw, SOL: ${sol.length}) — run with --debug to see the API calls`); perToken.push({ mint: t.mint, name: pool.name, skipped: "not enough candles" }); continue; }
    const startIndex = Math.max(60, candles.findIndex(k => k.t >= t.evalFrom));
    // Historical TVL beats today's (a dead pool's TVL now is ~0 and would hand us all its old fees).
    const simPool = { ...pool, activeTvlUsd: t.entryTvl ?? pool.activeTvlUsd };
    const row = { mint: t.mint, name: pool.name, tvlUsed: simPool.activeTvlUsd, tvlSource: t.entryTvl ? "lessons" : "today", binStep: pool.binStep, feePct: pool.feePct, assumedPool: pool.assumed, candles: candles.length, old: t.old };
    loaded.push({ t, row, candles, simPool, startIndex, label });
    perToken.push(row);
  } catch (e) {
    console.log(`${label} error: ${e.message}`);
    perToken.push({ mint: t.mint, skipped: e.message });
  }
}

// ─── Fee calibration against the old bot's real fees ────────────────────────
// The raw model (pool volume × fee × our share of TVL) can be off by orders of
// magnitude: TVL is spread over many bins and GeckoTerminal volume coverage
// varies. Re-simulate every old position with the same formula and scale the
// model so its total matches what those positions really earned.
let calib = { k: 1, positions: 0, realUsd: 0, modelUsd: 0, ratios: [] };
for (const { t, candles, simPool } of loaded) {
  for (const o of t.old) {
    if (!o.t1 || !(o.heldMin > 0) || !(o.amountSol > 0) || !o.binsBelow) continue;
    const pool = { ...simPool, activeTvlUsd: o.tvl ?? simPool.activeTvlUsd };
    const m = modelFeesForPosition({ candles, pool, t0: o.t1 - o.heldMin * 60_000, t1: o.t1, capitalSol: o.amountSol, binsBelow: o.binsBelow, shape: o.shape });
    if (!m.candles) continue;
    calib.positions++;
    calib.realUsd += o.feesUsd;
    calib.modelUsd += m.feesUsd;
    if (m.feesUsd > 0 && o.feesUsd > 0) calib.ratios.push(o.feesUsd / m.feesUsd);
  }
}
if (calib.positions >= 10 && calib.modelUsd > 0 && !has("no-calibrate")) calib.k = calib.realUsd / calib.modelUsd;
calib.ratios.sort((a, b) => a - b);
console.log(`Fee calibration: ${calib.positions} old positions, real $${calib.realUsd.toFixed(2)} vs model $${calib.modelUsd.toFixed(4)} → factor ×${calib.k.toFixed(1)}`);

for (const { t, row, candles, simPool, startIndex, label } of loaded) {
  try {
    for (const [vName, cfg] of Object.entries(VARIANTS)) {
      for (const [fName, mult] of Object.entries(FEE_SCENARIOS)) {
        const trades = simulateMint({ candles, pool: simPool, cfg, feeMult: mult * calib.k, startIndex }).map(tr => ({ ...tr, mint: t.mint, name: simPool.name }));
        results[vName][fName].push(...trades);
        if (vName === "config-kamu" && fName === "sedang") row.trades = trades;
      }
    }
    const mid = summarize(row.trades ?? []);
    console.log(`${label} ${simPool.name}: ${mid.trades ?? 0} trade(s), avg ${mid.avgPnlPct?.toFixed(2) ?? "-"}%`);
  } catch (e) {
    console.log(`${label} simulation error: ${e.message}`);
    row.skipped = e.message;
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const lines = [];
lines.push(`# EvilPanda backtest — ${new Date().toISOString().slice(0, 16)}`, "");
lines.push(`Tokens: ${perToken.filter(r => r.trades).length} simulated, ${perToken.filter(r => r.skipped).length} skipped. Position size normalised to 1 SOL; costs ${base.costs.txSol} SOL/trade + ${base.costs.swapSlippagePct}% slippage on tokens sold.`, "");
lines.push("## Ringkasan per varian (PnL % per trade)", "");
lines.push("| Varian | Fee | Trades | Win % | Avg | Median | Terburuk | Terbaik | Avg fee | Avg hold (jam) |", "|---|---|---|---|---|---|---|---|---|---|");
for (const [v, byFee] of Object.entries(results)) for (const [fName, trades] of Object.entries(byFee)) {
  const s = summarize(trades);
  lines.push(`| ${v} | ${fName} | ${s.trades} | ${f(s.winRatePct, 0)} | ${f(s.avgPnlPct)} | ${f(s.medianPnlPct)} | ${f(s.worstPnlPct)} | ${f(s.bestPnlPct)} | ${f(s.avgFeesPct)} | ${f((s.avgHeldMin ?? NaN) / 60, 1)} |`);
}
// Fee model sanity check against what the old bot really earned.
{
  const model = results["config-kamu"].sedang.filter(t => t.heldMin > 0).map(t => t.feesPct / (t.heldMin / 60)).sort((a, b) => a - b);
  const real = targets.flatMap(t => t.feeYieldsPerHour ?? []).sort((a, b) => a - b);
  const q = (a, x) => (a.length ? a[Math.min(a.length - 1, Math.floor(x * a.length))] : NaN);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  lines.push("", "## Kalibrasi fee (% modal per jam)", "",
    `Faktor kalibrasi: **×${calib.k.toFixed(1)}** dari ${calib.positions} posisi lama (fee asli $${calib.realUsd.toFixed(2)} vs model mentah $${calib.modelUsd.toFixed(4)}; rasio per posisi median ×${f(calib.ratios[Math.floor(calib.ratios.length / 2)], 1)}). Semua skenario fee dikalikan faktor ini.`, "",
    "| | Median | Rata-rata | p90 |", "|---|---|---|---|",
    `| Model backtest (config-kamu, sedang) | ${f(q(model, 0.5), 3)} | ${f(mean(model), 3)} | ${f(q(model, 0.9), 3)} |`,
    `| Bot lama (asli, dari lessons.json) | ${real.length ? f(q(real, 0.5), 3) : "-"} | ${real.length ? f(mean(real), 3) : "-"} | ${real.length ? f(q(real, 0.9), 3) : "-"} |`, "",
    "Range bot lama (69 bin) lebih padat per bin daripada range EvilPanda, jadi fee per jam bot lama wajar lebih tinggi. Yang penting: model dikalibrasi ke total fee asli lo, bukan tebakan.");
}
lines.push("", "## Alasan exit (config-kamu, fee sedang)", "", "| Rule | Jumlah | Avg PnL % |", "|---|---|---|");
for (const [rule, r] of Object.entries(summarize(results["config-kamu"].sedang).byRule ?? {})) lines.push(`| ${rule} | ${r.n} | ${f(r.avgPnl)} |`);
// Calibration data for range.adaptive (ATR% thresholds) and the depth → outcome relation.
{
  const tr = results["config-kamu"].sedang;
  const pct = (xs, q) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN; };
  const atrs = tr.map(t => t.atrPct);
  lines.push("", "## Kalibrasi range adaptif (config-kamu, fee sedang)", "",
    `Mode range: **${base.range.mode}**${base.range.mode === "adaptive" ? ` — ATR% ${base.range.adaptive.atrLowPct} → -${base.range.adaptive.minDepthPct}%, ATR% ${base.range.adaptive.atrHighPct} → -${base.range.adaptive.maxDepthPct}%` : ""}`, "",
    `ATR% 15m saat entry: p10 ${f(pct(atrs, 0.1))} · p25 ${f(pct(atrs, 0.25))} · median ${f(pct(atrs, 0.5))} · p75 ${f(pct(atrs, 0.75))} · p90 ${f(pct(atrs, 0.9))}`, "",
    "Saran awal: set `atrLowPct` ≈ p25 dan `atrHighPct` ≈ p75 supaya range benar-benar menyebar antara min dan max.", "",
    "| Kedalaman range | Trades | Win % | Avg PnL % | Stop loss | OOR bawah |", "|---|---|---|---|---|---|");
  for (const [lo, hi] of [[0, 60], [60, 70], [70, 80], [80, 101]]) {
    const b = tr.filter(t => t.depthPct >= lo && t.depthPct < hi);
    if (!b.length) continue;
    const sb = summarize(b);
    lines.push(`| -${lo}…-${Math.min(hi, 100)}% | ${sb.trades} | ${f(sb.winRatePct, 0)} | ${f(sb.avgPnlPct)} | ${b.filter(t => t.rule === "STOP_LOSS").length} | ${b.filter(t => t.rule === "OOR_BELOW").length} |`);
  }
}
lines.push("", "## Per token (config-kamu, fee sedang) vs bot lama", "", "| Token | Bin step | Trades | Avg PnL % backtest | Bot lama: posisi / avg PnL % |", "|---|---|---|---|---|");
for (const r of perToken) {
  if (r.skipped) { lines.push(`| ${r.name ?? r.mint.slice(0, 8)} | - | skipped: ${r.skipped} | - | - |`); continue; }
  const s = summarize(r.trades ?? []);
  const old = r.old?.filter(o => Number.isFinite(o.pnl)) ?? [];
  lines.push(`| ${r.name}${r.assumedPool ? " *" : ""} | ${r.binStep} | ${s.trades ?? 0} | ${f(s.avgPnlPct)} | ${old.length ? `${old.length} / ${f(old.reduce((a, o) => a + o.pnl, 0) / old.length)}` : "-"} |`);
}
lines.push("", "\\* pool data not available any more; bin step from lessons.json, fee assumed 1%.", "");
lines.push("## Batasan", "",
  "- Filter Rugcheck/GMGN/holders tidak bisa di-backtest (tidak ada data historis). Semua token dianggap lolos screening.",
  "- Fee: volume pool × fee dasar × porsi likuiditas kita di sekitar harga (TVL historis dari lessons.json), lalu dikalibrasi ke fee asli 243 posisi bot lama. Porsi maks 50% fee pool. Skenario rendah/tinggi = ×0.5/×2 di atas kalibrasi.",
  "- Range penuh diasumsikan (biaya bin-array tidak diketahui historis); live bot bisa memendekkan range.",
  "- Pemilihan pool (skor fee/TVL ÷ jumlah bin) tidak bisa di-backtest: hanya satu pool per token yang disimulasikan. Uji lewat paper trading.",
  "- Batas 3 posisi bersamaan tidak disimulasikan; tiap token dihitung sendiri.",
  "- Harga dari candle 15m; di dalam candle diasumsikan jalur o→l→h→c (hijau) atau o→h→l→c (merah).");
const reportFile = path.join(outDir, `backtest-${stamp}.md`);
fs.writeFileSync(reportFile, lines.join("\n"));
const csv = ["variant,fee,name,mint,entry,exit,held_min,rule,pnl_pct,fees_pct,price_move_pct,depth_pct,atr_pct,pump_pct"];
for (const [v, byFee] of Object.entries(results)) for (const [fName, trades] of Object.entries(byFee)) for (const t of trades) {
  csv.push([v, fName, JSON.stringify(t.name ?? ""), t.mint, new Date(t.entryT).toISOString(), new Date(t.exitT).toISOString(), t.heldMin, t.rule, f(t.pnlPct, 3), f(t.feesPct, 3), f(t.priceMovePct, 2), f(t.depthPct, 1), f(t.atrPct, 3), f(t.pumpPct, 1)].join(","));
}
fs.writeFileSync(path.join(outDir, `trades-${stamp}.csv`), csv.join("\n"));
console.log(`\nReport: ${reportFile}\nTrades: ${path.join(outDir, `trades-${stamp}.csv`)}`);
