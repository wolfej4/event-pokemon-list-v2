"use strict";
// Talks to a self-hosted Spoolman instance (https://github.com/Donkie/Spoolman).
// No API key by default — Spoolman doesn't require one on its own. If it sits
// behind a reverse proxy with its own auth, that isn't supported here yet.
function base() { return String(process.env.SPOOLMAN_URL || "").replace(/\/+$/, ""); }
function configured() { return !!base(); }

async function req(path) {
  if (!configured()) throw new Error("SPOOLMAN_URL is not set.");
  let res;
  try {
    res = await fetch(base() + path);
  } catch (e) {
    throw new Error("Couldn't reach Spoolman at " + base() + " (" + e.message + ")");
  }
  if (!res.ok) {
    let msg = "Spoolman request failed (" + res.status + ")";
    try { const j = await res.json(); if (typeof j.detail === "string") msg = j.detail; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function testConnection() {
  return req("/api/v1/info"); // { version, debug_mode, ... } — cheap way to confirm the URL + that it's actually Spoolman
}

// Pages through every non-archived spool. Spoolman doesn't publish a hard
// page-size cap, so this stops once a page comes back short or after a
// generous number of pages (5000 spools), whichever comes first.
async function listSpools() {
  const limit = 200;
  const out = [];
  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await req(`/api/v1/spool?allow_archived=false&limit=${limit}&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

module.exports = { configured, testConnection, listSpools };
