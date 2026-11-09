// Self-built 15m candles per pool. No I/O.
//
// GeckoTerminal's keyless API allows ~5 calls/min, far too few to refetch
// candles for every candidate on every candle. Instead each pool is SEEDED once
// with real history (GeckoTerminal) and then EXTENDED by sampling the pool price
// from Meteora every minute. Sampled highs/lows miss intra-minute wicks; the
// strategy's signals work on closes, and ATR only needs to be roughly right.

export class CandleBook {
  constructor({ periodMs = 900_000, maxCandles = 300 } = {}) {
    this.periodMs = periodMs;
    this.maxCandles = maxCandles;
    this.pools = new Map(); // pool → { closed: [], cur: null|candle, seededAt, lastSampleAt, vols: [] }
  }

  bucket(t) { return Math.floor(t / this.periodMs) * this.periodMs; }
  lastClosedStart(now = Date.now()) { return this.bucket(now) - this.periodMs; }

  #entry(pool) {
    let e = this.pools.get(pool);
    if (!e) { e = { closed: [], cur: null, seededAt: null, lastSampleAt: null, vols: [] }; this.pools.set(pool, e); }
    return e;
  }

  #push(e, k) {
    const last = e.closed.at(-1);
    if (last && k.t <= last.t) return; // never rewrite history
    e.closed.push(k);
    if (e.closed.length > this.maxCandles) e.closed.splice(0, e.closed.length - this.maxCandles);
  }

  /** Close the building candle once its period is over. */
  #roll(e, now) {
    if (e.cur && e.cur.t + this.periodMs <= now) {
      const { samples, ...k } = e.cur;
      const vols = e.vols.filter(Number.isFinite);
      k.v = vols.length ? (vols.reduce((a, b) => a + b, 0) / vols.length) * (this.periodMs / 300_000) : 0;
      this.#push(e, k);
      e.cur = null;
      e.vols = [];
    }
  }

  /** Replace history with real candles (closed only, oldest first). */
  seed(pool, candles, now = Date.now()) {
    const e = this.#entry(pool);
    const ks = (candles || [])
      .filter(k => Number.isFinite(k.c) && k.c > 0 && k.t + this.periodMs <= now)
      .sort((a, b) => a.t - b.t)
      .map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v: v ?? 0 }));
    e.closed = ks.slice(-this.maxCandles);
    // Keep a building candle only if it is newer than the seeded history.
    if (e.cur && e.closed.length && e.cur.t <= e.closed.at(-1).t) { e.cur = null; e.vols = []; }
    e.seededAt = now;
  }

  /** Record one price observation (and the pool's 5m volume, if known). */
  sample(pool, price, now = Date.now(), vol5m = null) {
    if (!(price > 0)) return;
    const e = this.#entry(pool);
    this.#roll(e, now);
    const t = this.bucket(now);
    if (!e.cur) e.cur = { t, o: price, h: price, l: price, c: price, samples: 0 };
    e.cur.h = Math.max(e.cur.h, price);
    e.cur.l = Math.min(e.cur.l, price);
    e.cur.c = price;
    e.cur.samples++;
    if (Number.isFinite(vol5m)) e.vols.push(vol5m);
    e.lastSampleAt = now;
  }

  /**
   * Needs (re)seeding: never seeded, or a hole of more than `maxGapCandles`
   * between stored history and now (bot was down, pool stopped being sampled).
   */
  needsSeed(pool, now = Date.now(), maxGapCandles = 2) {
    const e = this.pools.get(pool);
    if (!e?.seededAt) return true;
    this.#roll(e, now);
    const lastT = e.cur?.t ?? e.closed.at(-1)?.t;
    if (lastT == null) return true;
    return this.lastClosedStart(now) - lastT > maxGapCandles * this.periodMs;
  }

  /** Closed candles, oldest first. */
  closed(pool, now = Date.now()) {
    const e = this.pools.get(pool);
    if (!e) return [];
    this.#roll(e, now);
    return e.closed.slice();
  }

  /** Aggregate closed candles into `factor`× longer candles (e.g. 4 → 1h). */
  aggregate(pool, factor, now = Date.now()) {
    const out = [];
    const span = this.periodMs * factor;
    for (const k of this.closed(pool, now)) {
      const t = Math.floor(k.t / span) * span;
      const last = out.at(-1);
      if (!last || last.t !== t) out.push({ ...k, t });
      else { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v; }
    }
    return out;
  }

  /** Forget pools not in `keep` (bounded memory). */
  prune(keep) {
    for (const pool of this.pools.keys()) if (!keep.has(pool)) this.pools.delete(pool);
  }

  toJSON() { return { periodMs: this.periodMs, pools: Object.fromEntries(this.pools) }; }

  static fromJSON(json, opts = {}) {
    const b = new CandleBook(opts);
    if (json?.periodMs === b.periodMs && json.pools && typeof json.pools === "object") {
      for (const [pool, e] of Object.entries(json.pools)) {
        b.pools.set(pool, { closed: Array.isArray(e.closed) ? e.closed : [], cur: e.cur ?? null, seededAt: e.seededAt ?? null, lastSampleAt: e.lastSampleAt ?? null, vols: Array.isArray(e.vols) ? e.vols : [] });
      }
    }
    return b;
  }
}
