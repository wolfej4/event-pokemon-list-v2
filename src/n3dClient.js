"use strict";
const BASE = process.env.N3D_API_BASE || "https://www.n3dmelbourne.com/api/v1";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const db = require("./db");

// The key saved in admin wins; otherwise fall back to N3D_API_KEY.
function config() {
  const saved = db.getSettings().n3dApiKey;
  if (saved) return { key: saved, source: "app" };
  return { key: process.env.N3D_API_KEY || "", source: "env" };
}
function configured() { return !!config().key; }
function key() {
  const k = config().key;
  if (!k) throw new Error("The N3D API key isn't set. Add it in admin \u2192 Settings, or set N3D_API_KEY.");
  return k;
}

async function request(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + key() } });
  if (res.status === 429) {
    const reset = res.headers.get("X-RateLimit-Reset");
    const e = new Error("rate_limited"); e.isRateLimit = true;
    e.resetAt = reset ? Number(reset) * 1000 : Date.now() + 15000;
    throw e;
  }
  if (res.status === 401) { const e = new Error("N3D rejected the API key (401). Check N3D_API_KEY."); e.isAuth = true; throw e; }
  if (!res.ok) {
    let msg = "N3D request failed (" + res.status + ")";
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

const checkKey = () => request("/me");

// Pages through /designs; onPage(array) is called for each page.
async function syncCatalog({ since, onPage } = {}) {
  let page = 1, hasNext = true, cursor = since || null, total = 0, retries = 0;
  while (hasNext) {
    const qs = new URLSearchParams({ limit: "200", include: "details", include_extras: "true", page: String(page) });
    if (since) qs.set("updated_since", since);
    let json;
    try { json = await request("/designs?" + qs); }
    catch (e) {
      if (e.isRateLimit && retries++ < 5) { await sleep(Math.max(1000, e.resetAt - Date.now()) + 500); continue; }
      throw e;
    }
    retries = 0;
    const data = json.data || [];
    for (const d of data) if (d.updated_at && (!cursor || d.updated_at > cursor)) cursor = d.updated_at;
    total += data.length;
    if (onPage) await onPage(data);
    hasNext = !!(json.pagination && json.pagination.has_next);
    page++;
    if (hasNext) await sleep(250);
  }
  return { cursor, total };
}

module.exports = { checkKey, syncCatalog, configured, config };
