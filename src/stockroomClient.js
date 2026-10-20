"use strict";
// Talks to Voxelwaves Stockroom (wolfej4/voxelwaves-stockroom), which owns how
// many of each design are on the shelf. Both apps share one secret,
// INTEGRATION_KEY, sent as X-API-Key. STOCKROOM_URL is how this container
// reaches Stockroom on the LAN (not through the reverse proxy / Pocket ID).
function base() { return String(process.env.STOCKROOM_URL || "").replace(/\/+$/, ""); }
const key = () => String(process.env.INTEGRATION_KEY || "").trim();
function configured() { return !!(base() && key()); }

async function req(method, path, body, headers) {
  if (!configured()) throw new Error("STOCKROOM_URL and INTEGRATION_KEY must both be set.");
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: Object.assign({ "X-API-Key": key(), "Content-Type": "application/json" }, headers || {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) {
    const err = new Error("Couldn't reach Stockroom at " + base() + " (" + (e.cause && e.cause.code || e.message) + ")");
    err.unreachable = true;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Stockroom refused the key. INTEGRATION_KEY must be the same in both apps.");
  if (!res.ok) {
    const e = new Error(json.detail || json.error || ("Stockroom error " + res.status));
    e.status = res.status; e.code = json.error;
    throw e;
  }
  return json;
}

// { slug: { regular: n, shiny: n } } for every design linked to a Stockroom item.
// Cached for 30 s so a busy storefront asks Stockroom at most twice a minute; if
// Stockroom is down, the last good answer is used for up to 10 minutes, then
// null (the storefront just hides the badges).
const FRESH_MS = 30 * 1000, STALE_MS = 10 * 60 * 1000;
let cache = { at: 0, map: null, error: null }, inflight = null;
async function stockMap() {
  if (!configured()) return null;
  const age = Date.now() - cache.at;
  if (cache.map && age < FRESH_MS) return cache.map;
  if (!inflight) {
    inflight = req("GET", "/api/v1/stock")
      .then(j => { cache = { at: Date.now(), map: j.stock || {}, error: null }; })
      .catch(e => { cache.error = e.message; console.warn("[stockroom] stock read failed:", e.message); })
      .finally(() => { inflight = null; });
  }
  await inflight;
  return cache.map && Date.now() - cache.at < STALE_MS ? cache.map : null;
}
const lastError = () => cache.error;

// Takes a sale off the shelf (delta < 0) or puts one back. `key` makes it
// safe to retry: Stockroom applies each key once.
async function recordMovement({ slug, variant, delta, reason, ref, idempotencyKey }) {
  const out = await req("POST", "/api/v1/movements",
    { catalog_slug: slug, variant: variant || "regular", delta, reason, ref },
    { "Idempotency-Key": idempotencyKey });
  cache.at = 0; // next storefront load sees the new count
  return out;
}

async function testConnection() {
  const j = await req("GET", "/api/v1/stock");
  return { linked: (j.items || []).length };
}

module.exports = { configured, stockMap, lastError, recordMovement, testConnection };
