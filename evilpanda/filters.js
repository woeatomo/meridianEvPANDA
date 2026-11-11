// Pure EvilPanda screening rules. Each reject* returns a reason string or null.
// Unknown data is a rejection unless the caller explicitly allows it: missing
// numbers must never read as "safe".

const num = v => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Jupiter `assets/search` token entry → Dexscreener-style screen (Part 1 of the strat). */
export function rejectTokenBasics(token, mint, s, now = Date.now()) {
  if (!token || token.id !== mint) return "token data unavailable";
  if (s.requireProfile && !token.icon) return "no token image/profile";
  if (s.requireSocials && !(token.twitter || token.website || token.telegram)) return "no socials";
  const mcap = num(token.mcap);
  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} < ${s.minMcap}`;
  if (s.maxMcap != null && mcap > s.maxMcap) return `mcap ${mcap} > ${s.maxMcap}`;
  const st = token.stats24h || {};
  const vol = num(st.buyVolume) != null && num(st.sellVolume) != null ? num(st.buyVolume) + num(st.sellVolume) : null;
  if (vol == null || vol < s.minTokenVolume24h) return `24h volume ${vol == null ? "unknown" : Math.round(vol)} < ${s.minTokenVolume24h}`;
  const fees = num(token.fees);
  if (fees == null || fees < s.minTokenFeesSol) return `fees ${fees ?? "unknown"} SOL < ${s.minTokenFeesSol}`;
  const top10 = num(token.audit?.topHoldersPercentage);
  if (top10 == null || top10 >= s.maxTop10Pct) return `top10 ${top10 ?? "unknown"}% >= ${s.maxTop10Pct}%`;
  if (token.audit?.mintAuthorityDisabled !== true || token.audit?.freezeAuthorityDisabled !== true) return "mint/freeze authority enabled or unknown";
  const ageH = (now - Date.parse(token.createdAt)) / 3_600_000;
  if (s.minTokenAgeHours != null && !(ageH >= s.minTokenAgeHours)) return "token too young or age unknown";
  if (s.maxTokenAgeHours != null && !(ageH <= s.maxTokenAgeHours)) return "token too old or age unknown";
  return null;
}

/** Rugcheck `/report/summary`. */
export function rejectRugcheck(report, r) {
  if (!report) return r.requireData ? "rugcheck data unavailable" : null;
  const score = num(report.score_normalised ?? report.scoreNormalised);
  if (score == null) { if (r.requireData) return "rugcheck score unavailable"; }
  else if (score > r.maxScore) return `rugcheck score ${score}/100 > ${r.maxScore}`;
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const blocked = new Set((r.blockRisks || []).map(x => String(x).toLowerCase()));
  for (const risk of risks) {
    const name = String(risk?.name || "");
    if (r.rejectDanger && String(risk?.level).toLowerCase() === "danger") return `rugcheck danger: ${name}`;
    if (blocked.has(name.toLowerCase())) return `rugcheck risk: ${name}`;
  }
  return null;
}

/** Converts a GMGN rate to percent. GMGN returns fractions (0.12 = 12%) unless configured otherwise. */
export function gmgnPct(value, ratesAreFractions = true) {
  const n = num(value);
  if (n == null) return null;
  return ratesAreFractions ? n * 100 : n;
}

/** Normalised GMGN metrics (percent) from `/v1/token/security` (+ optional token info). */
export function gmgnMetrics(security, g) {
  if (!security || typeof security !== "object") return null;
  const f = g.ratesAreFractions !== false;
  return {
    phishingPct: gmgnPct(security.rat_trader_amount_rate, f),
    bundlerPct: gmgnPct(security.bundler_trader_amount_rate, f),
    insidersPct: gmgnPct(security.suspected_insider_hold_rate, f),
    top10Pct: gmgnPct(security.top_10_holder_rate, f),
  };
}

/**
 * GMGN gate on a gmgnSecurity() result. null = no API key (skipped unless
 * requireData); {ok:false} = the call failed → reject, an outage is never "safe".
 * With data, every configured metric must be present.
 */
export function rejectGmgnFetch(fetchResult, g) {
  if (fetchResult == null) return { reason: g.requireData ? "gmgn: no API key" : null, metrics: null };
  if (!fetchResult.ok) return { reason: `gmgn unavailable (${fetchResult.reason})`, metrics: null };
  const metrics = gmgnMetrics(fetchResult.data, g);
  return { reason: rejectGmgn(metrics, { ...g, requireData: true }), metrics };
}

/** GMGN filter from the Advanced Bootcamp summary (phishing/bundling/insiders/top10). */
export function rejectGmgn(metrics, g) {
  if (!metrics) return g.requireData ? "gmgn data unavailable" : null;
  for (const [label, value, max] of [
    ["phishing", metrics.phishingPct, g.maxPhishingPct],
    ["bundling", metrics.bundlerPct, g.maxBundlerPct],
    ["insiders", metrics.insidersPct, g.maxInsidersPct],
    ["top10", metrics.top10Pct, g.maxTop10Pct],
  ]) {
    if (max == null) continue;
    if (value == null) { if (g.requireData) return `gmgn ${label} unknown`; continue; }
    if (value >= max) return `gmgn ${label} ${value.toFixed(1)}% >= ${max}%`;
  }
  return null;
}

/** Pool eligibility for a candidate mint. Prefers high bin steps so a deep range fits in few bins. */
export function rejectPool(p, mint, solMint, s) {
  if (p?.token_x?.address !== mint || p?.token_y?.address !== solMint || p?.pool_type !== "dlmm") return "needs exact token/SOL DLMM pool";
  if (p.is_blacklisted === true) return "pool blacklisted";
  const binStep = num(p.dlmm_params?.bin_step);
  if (binStep == null || binStep < s.minBinStep || binStep > s.maxBinStep) return `bin step ${binStep ?? "unknown"} outside ${s.minBinStep}-${s.maxBinStep}`;
  const tvl = num(p.tvl);
  if (tvl == null || tvl < s.minTvl) return `tvl ${tvl ?? "unknown"} < ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `tvl ${tvl} > ${s.maxTvl}`;
  if (!(num(p.pool_price) > 0)) return "pool price unavailable";
  return null;
}

/** Highest bin step first (fewer bins for the same depth), then fee/active-TVL, then TVL. */
export function rankPools(pools, preferHighBinStep = true) {
  return [...pools].sort((a, b) => {
    const step = (num(b.dlmm_params?.bin_step) ?? 0) - (num(a.dlmm_params?.bin_step) ?? 0);
    if (preferHighBinStep && step) return step;
    return (num(b.fee_active_tvl_ratio) ?? 0) - (num(a.fee_active_tvl_ratio) ?? 0)
      || (num(b.tvl) ?? 0) - (num(a.tvl) ?? 0)
      || String(a.pool_address).localeCompare(String(b.pool_address));
  });
}

/**
 * Shape choice. Default bid-ask; spot only when every stability criterion holds
 * with known data ("terbukti bagus dan stabil").
 */
export function chooseShape({ token, pool, rugcheck, gmgn }, shape, now = Date.now()) {
  if (!shape.autoSpot) return { strategy: shape.default, reason: "auto spot disabled" };
  const c = shape.spot;
  const fail = reason => ({ strategy: shape.default, reason });
  const ageH = (now - Date.parse(token?.createdAt)) / 3_600_000;
  if (!(ageH >= c.minAgeHours)) return fail(`age ${Number.isFinite(ageH) ? ageH.toFixed(0) : "?"}h < ${c.minAgeHours}h`);
  const mcap = num(token?.mcap);
  if (!(mcap >= c.minMcap)) return fail(`mcap < ${c.minMcap}`);
  const vol = num(pool?.volatility);
  if (!(vol > 0 && vol <= c.maxVolatility)) return fail(`volatility ${vol ?? "?"} > ${c.maxVolatility}`);
  const rc = num(rugcheck?.score_normalised ?? rugcheck?.scoreNormalised);
  if (!(rc != null && rc <= c.maxRugcheckScore)) return fail(`rugcheck ${rc ?? "?"} > ${c.maxRugcheckScore}`);
  if (c.requireGmgn) {
    if (!gmgn) return fail("gmgn data unavailable");
    const margin = 1 - c.gmgnMarginPct / 100; // e.g. 50 → must be under half of each limit
    for (const [v, max] of [[gmgn.phishingPct, c.limits.maxPhishingPct], [gmgn.bundlerPct, c.limits.maxBundlerPct], [gmgn.insidersPct, c.limits.maxInsidersPct]]) {
      if (max == null) continue;
      if (!(v != null && v < max * margin)) return fail("gmgn metrics not comfortably inside limits");
    }
  }
  return { strategy: "spot", reason: "token stable: age, mcap, volatility, rugcheck and gmgn all within spot criteria" };
}

/**
 * Stand-in for the GMGN filter while no GMGN key is set: Jupiter's bot-holder
 * share (rough proxy for bundling) and Rugcheck insider warnings. Weaker than
 * GMGN, better than nothing. Returns a reason or null.
 */
export function rejectGmgnFallback(token, rugcheck, fb) {
  if (!fb?.enabled) return null;
  const bots = num(token?.audit?.botHoldersPercentage);
  if (bots == null) { if (fb.requireBotData) return "bot holders % unknown (GMGN fallback)"; }
  else if (bots >= fb.maxBotHoldersPct) return `bot holders ${bots.toFixed(1)}% >= ${fb.maxBotHoldersPct}% (GMGN fallback)`;
  if (fb.blockRugcheckInsiders) {
    const re = new RegExp(fb.insiderPattern || "insider", "i");
    const hit = (Array.isArray(rugcheck?.risks) ? rugcheck.risks : []).find(r => re.test(`${r?.name ?? ""} ${r?.description ?? ""}`));
    if (hit) return `rugcheck: ${hit.name} (GMGN fallback)`;
  }
  return null;
}
