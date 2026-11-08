#!/usr/bin/env node
// Smart-wallet finder CLI. Read-only unless --auto or --add is given.
//
//   npm run find-wallets                        # report only
//   npm run find-wallets -- --auto              # apply the automatic add/remove rules now
//   npm run find-wallets -- --add 5             # add the top 5 new qualified wallets
//   npm run find-wallets -- --pools 25 --max-wallets 120
//   npm run find-wallets -- --pool-list ADDR1,ADDR2
//
// The daemon runs the --auto job on its own every evilPanda.walletFinder.auto.intervalHours.

import "../envcrypt.js"; // load .env before config.js reads it
import { scanAndScore, autoManage, writeReport } from "./finder.js";
import { addSmartWallet } from "../smart-wallets.js";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? true) : d; };
const has = n => argv.includes(`--${n}`);
const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));

let result;
try {
  result = await scanAndScore({
    pools: flag("pools") ? Number(flag("pools")) : undefined,
    maxWallets: flag("max-wallets") ? Number(flag("max-wallets")) : undefined,
    poolList: flag("pool-list") ? String(flag("pool-list")).split(",").map(s => s.trim()).filter(Boolean) : undefined,
    progress: m => console.log(m),
  });
} catch (e) {
  const net = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/.test(`${e.message} ${e.cause?.code ?? ""}`);
  console.error(net ? `Cannot reach the Meteora API (${e.cause?.code ?? e.message}). Run this on the VPS.` : e.message);
  process.exit(1);
}

const managed = has("auto") ? autoManage(result) : null;
const { file, passed } = writeReport(result, managed);

console.log(`\nNew qualified: ${passed.length}`);
for (const [i, r] of passed.slice(0, 10).entries()) console.log(`  ${i + 1}. ${r.wallet}  win ${f(r.metrics.winRatePct, 0)}%  median ${f(r.metrics.medianPnlPct)}%  PnL ${f(r.metrics.totalPnlSol, 3)} SOL  (${r.metrics.closed} closed)`);
for (const r of result.rows.filter(x => x.listed && !x.pass)) console.log(`  ⚠ on your list: ${r.wallet.slice(0, 8)} — ${r.why}`);
if (managed) {
  for (const a of managed.added) console.log(`  ➕ added ${a.wallet}`);
  for (const r of managed.removed) console.log(`  ➖ removed ${r.wallet} — ${r.why}`);
  console.log(`  list size: ${managed.total}`);
}
const addTop = Number(flag("add", 0)) || 0;
for (const r of passed.slice(0, addTop)) {
  const res = addSmartWallet({ name: `finder-${r.wallet.slice(0, 6)}`, address: r.wallet, category: "finder", type: "lp" });
  console.log(`  + ${r.wallet.slice(0, 8)}: ${res?.success ? "added" : res?.error ?? "not added"}`);
}
console.log(`Report: ${file}`);
process.exit(0);
