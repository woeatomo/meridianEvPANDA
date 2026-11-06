// Network adapters for the EvilPanda engine. Every function is read-only.
// Failures throw (or return null where documented) — callers must treat
// missing data as "unknown", never as "safe".

import { randomUUID } from "node:crypto";

const JUP = "https://datapi.jup.ag/v1";
const DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag/pools";
const DLMM_API = "https://dlmm.datapi.meteora.ag/pools";
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";

const lastCall = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Serialises calls per key so free APIs (GeckoTerminal, GMGN) aren't rate-limited. */
async function pace(key, delayMs) {
  const prev = lastCall.get(key) ?? Promise.resolve(0);
  const turn = prev.then(async last => {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    return Date.now();
  });
  lastCall.set(key, turn.catch(() => Date.now()));
  await turn;
}

export async function getJson(url, { headers = {}, timeoutMs = 12_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ─── Token data ──────────────────────────────────────────────────────────────

export async function jupiterToken(mint) {
  const list = await getJson(`${JUP}/assets/search?query=${mint}`);
  return (Array.isArray(list) ? list : []).find(t => t.id === mint) ?? null;
}

export async function jupiterNarrative(mint) {
  try {
    const data = await getJson(`${JUP}/chaininsight/narrative/${mint}`);
    return typeof data?.narrative === "string" ? data.narrative : null;
  } catch {
    return null;
  }
}

/** Rugcheck summary or null when unreachable. */
export async function rugcheckSummary(mint, { delayMs = 1000 } = {}) {
  await pace("rugcheck", delayMs);
  try {
    return await getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  } catch {
    return null;
  }
}

/** GMGN token security (rates for phishing/bundler/insiders/top10) or null without key / on error. */
export async function gmgnSecurity(mint, g) {
  if (!g.apiKey) return null;
  const url = new URL(`${String(g.baseUrl).replace(/\/+$/, "")}/v1/token/security`);
  url.searchParams.set("chain", "sol");
  url.searchParams.set("address", mint);
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("client_id", randomUUID());
  for (let attempt = 0; attempt <= (g.maxRetries ?? 2); attempt++) {
    await pace("gmgn", g.requestDelayMs ?? 2500);
    try {
      const res = await fetch(url, { headers: { "X-APIKEY": g.apiKey }, signal: AbortSignal.timeout(12_000) });
      if (res.status === 429) { await sleep(Math.min(30_000, 3000 * 2 ** attempt)); continue; }
      if (!res.ok) return null;
      const payload = await res.json();
      return payload?.data?.data || payload?.data || null;
    } catch {
      return null;
    }
  }
  return null;
}

// ─── Pools ───────────────────────────────────────────────────────────────────

export async function discoveryPool(address, timeframe = "24h") {
  const params = new URLSearchParams({ page_size: "1", filter_by: `pool_address=${address}`, timeframe });
  const data = await getJson(`${DISCOVERY}?${params}`);
  const pool = data?.data?.find(p => p.pool_address === address);
  if (!pool) throw new Error("pool data unavailable");
  return pool;
}

/** Token/SOL DLMM pool addresses for a mint. */
export async function poolsForMint(mint, solMint) {
  const params = new URLSearchParams({ query: mint, page_size: "50", sort_by: "tvl:desc" });
  const data = await getJson(`${DLMM_API}?${params}`);
  if (!Array.isArray(data?.data)) throw new Error("invalid pool search response");
  return data.data.filter(p => p.token_x?.address === mint && p.token_y?.address === solMint).map(p => p.address).slice(0, 10);
}

/** Broad scan for the screener: DLMM token/SOL pools with real activity. Returns base mints. */
export async function scanDiscovery(sc, solMint) {
  const filters = [
    "pool_type=dlmm",
    `base_token_market_cap>=${sc.minMcap}`,
    sc.maxMcap != null ? `base_token_market_cap<=${sc.maxMcap}` : null,
    `volume>=${sc.minPoolVolume}`,
  ].filter(Boolean).join("&&");
  const params = new URLSearchParams({ page_size: String(sc.pageSize), filter_by: filters, timeframe: sc.timeframe, category: sc.category });
  const data = await getJson(`${DISCOVERY}?${params}`);
  const pools = Array.isArray(data?.data) ? data.data : [];
  const byMint = new Map();
  for (const p of pools) {
    if (p.token_y?.address !== solMint || !p.token_x?.address) continue;
    const prev = byMint.get(p.token_x.address);
    const createdAt = Number(p.token_x?.created_at ?? p.base_token_created_at ?? 0);
    if (!prev) byMint.set(p.token_x.address, { mint: p.token_x.address, createdAt, name: p.name });
  }
  // EvilPanda sorts by age: newest tokens first.
  return [...byMint.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Discord LP-call candidates relayed by the Agent Meridian API (read-only, no account needed). */
export async function discordCandidates(d) {
  const data = await getJson(`${String(d.url).replace(/\/+$/, "")}/signals/discord/candidates`, {
    headers: d.apiKey ? { "x-api-key": d.apiKey } : {},
  });
  const list = Array.isArray(data?.candidates) ? data.candidates : [];
  return list
    .map(c => ({
      mint: c.mint || c.token_mint || c.discovery_pool?.token_x?.address || null,
      sourceCount: c.source_count || 1,
      lastSeenAt: c.last_seen_at || null,
    }))
    .filter(c => c.mint);
}

// ─── Candles (GeckoTerminal) ─────────────────────────────────────────────────

const chartPoolCache = new Map();

/** Most liquid pool for a token (longest/cleanest price history), cached. */
export async function chartPoolFor(mint, delayMs) {
  const hit = chartPoolCache.get(mint);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.pool;
  await pace("gecko", delayMs);
  const data = await getJson(`${GECKO}/tokens/${mint}/pools?page=1`);
  const pool = data?.data?.[0]?.attributes?.address;
  if (!pool) throw new Error("no chart pool found");
  chartPoolCache.set(mint, { pool, at: Date.now() });
  return pool;
}

/**
 * Closed OHLCV candles, oldest → newest. The still-forming candle is dropped.
 * @param {"minute"|"hour"} unit
 */
export async function candles(pool, { unit = "minute", aggregate = 15, limit = 200, currency = "token", delayMs = 2200 } = {}) {
  await pace("gecko", delayMs);
  const params = new URLSearchParams({ aggregate: String(aggregate), limit: String(limit), currency, token: "base" });
  const data = await getJson(`${GECKO}/pools/${pool}/ohlcv/${unit}?${params}`);
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) throw new Error("ohlcv unavailable");
  const periodMs = (unit === "hour" ? 3_600_000 : 60_000) * aggregate;
  const now = Date.now();
  return list
    .map(([t, o, h, l, c, v]) => ({ t: Number(t) * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
    .filter(k => Number.isFinite(k.c) && k.c > 0 && k.t + periodMs <= now)
    .sort((a, b) => a.t - b.t);
}
