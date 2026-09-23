"use strict";
// Lightweight JSON-file "database". Fine for a catalog of a few hundred
// designs and a single admin — avoids native modules (sqlite bindings etc.)
// so the Docker image stays a plain node:alpine build with no compiler.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const MAX_QUOTE_LOGS = 500;
const MAX_ERROR_LOGS = 300;

const DEFAULT_DATA = {
  designs: {},      // slug -> { ...n3d fields..., price_cents, shop_url, visible, featured, synced_at }
  quoteLogs: [],     // recent quote request attempts, newest first, capped at MAX_QUOTE_LOGS
  errorLogs: [],     // recent server-side errors, newest first, capped at MAX_ERROR_LOGS
  settings: {
    businessName: "",
    businessEmail: "",
    lastCursor: null,          // updated_since cursor for incremental N3D sync
    hoursPerDayCapacity: 6,    // printer-hours/day used to estimate lead time
    leadTimeBufferDays: 2,     // extra days added on top of raw print time (queue, shipping, etc.)
    eventModeEnabled: false,   // when true, public catalog only shows featured designs
    kioskModeEnabled: false,   // when true, storefront auto-resets after idle time
    kioskIdleMinutes: 2        // idle minutes before a kiosk auto-reset
  }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DATA, null, 2));
    return structuredClone(DEFAULT_DATA);
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // merge with defaults so new fields introduced later don't crash old data files
    return {
      designs: parsed.designs || {},
      quoteLogs: parsed.quoteLogs || [],
      errorLogs: parsed.errorLogs || [],
      settings: Object.assign({}, DEFAULT_DATA.settings, parsed.settings || {})
    };
  } catch (err) {
    console.error("[db] Failed to read db.json, starting fresh:", err.message);
    return structuredClone(DEFAULT_DATA);
  }
}

let state = load();
let writeTimer = null;

function persist() {
  ensureDataDir();
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try { persist(); } catch (err) { console.error("[db] write failed:", err.message); }
  }, 150);
}

// ---- designs ----
function upsertDesign(slug, fields) {
  const existing = state.designs[slug] || {};
  // drop undefined values so callers can pass "only set this on first insert"
  // fields without clobbering existing admin-set data on updates
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) clean[k] = v;
  }
  state.designs[slug] = Object.assign({}, existing, clean, { slug });
  scheduleWrite();
  return state.designs[slug];
}

function getDesign(slug) {
  return state.designs[slug] || null;
}

function allDesigns() {
  return Object.values(state.designs);
}

function setAdminFields(slug, { price_cents, shop_url, visible, featured }) {
  const existing = state.designs[slug];
  if (!existing) return null;
  if (price_cents !== undefined) existing.price_cents = price_cents;
  if (shop_url !== undefined) existing.shop_url = shop_url;
  if (visible !== undefined) existing.visible = visible;
  if (featured !== undefined) existing.featured = featured;
  scheduleWrite();
  return existing;
}

function setSquareFields(slug, fields) {
  const existing = state.designs[slug];
  if (!existing) return null;
  Object.assign(existing, fields);
  scheduleWrite();
  return existing;
}

// ---- quote logs ----
function addQuoteLog(entry) {
  const record = Object.assign({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    createdAt: new Date().toISOString()
  }, entry);
  state.quoteLogs.unshift(record);
  if (state.quoteLogs.length > MAX_QUOTE_LOGS) {
    state.quoteLogs.length = MAX_QUOTE_LOGS;
  }
  scheduleWrite();
  return record;
}

function listQuoteLogs() {
  return state.quoteLogs;
}

// ---- error logs ----
function addErrorLog(entry) {
  const record = Object.assign({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    createdAt: new Date().toISOString()
  }, entry);
  state.errorLogs.unshift(record);
  if (state.errorLogs.length > MAX_ERROR_LOGS) {
    state.errorLogs.length = MAX_ERROR_LOGS;
  }
  scheduleWrite();
  return record;
}

function listErrorLogs() {
  return state.errorLogs;
}

function clearErrorLogs() {
  state.errorLogs = [];
  scheduleWrite();
}

// ---- settings ----
function getSettings() {
  return state.settings;
}

function updateSettings(fields) {
  state.settings = Object.assign({}, state.settings, fields);
  scheduleWrite();
  return state.settings;
}

function flushSync() {
  // used on graceful shutdown to make sure the last write lands on disk
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try { persist(); } catch (err) { console.error("[db] final flush failed:", err.message); }
}

module.exports = {
  upsertDesign, getDesign, allDesigns, setAdminFields, setSquareFields,
  addQuoteLog, listQuoteLogs,
  addErrorLog, listErrorLogs, clearErrorLogs,
  getSettings, updateSettings, flushSync
};
