"use strict";
// Small JSON-file datastore. Plenty for a few hundred designs and a quote log,
// and it keeps the Docker image free of native modules.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const DEFAULT_SETTINGS = {
  businessName: "",
  businessEmail: "",     // where "our" copy of each quote goes
  businessPhone: "",
  tagline: "Browse designs, build a quote, and we'll email you a PDF estimate.",
  quoteFooter: "This is an estimate, not an invoice. Final pricing is confirmed before printing. " +
               "Designs are fan-made and not affiliated with or endorsed by Nintendo, Game Freak, or The Pokémon Company.",
  currency: "USD",
  pricing: {
    baseFee: 3.00,        // $ per item
    perGram: 0.08,        // $ per gram of filament
    perHour: 1.50,        // $ per hour of print time
    markupPct: 0,         // % added on top
    minPrice: 5.00,       // floor per item
    roundTo: 1.00         // round up to nearest $X (0 = no rounding)
  },
  squareOverwritePrices: true, // re-push replaces the price in Square
  kioskIdleSeconds: 90,
  logos: {},             // { light: {ext,type,v}, dark: {...} } files live in DATA_DIR
  logoShowName: true,    // show business name next to the logo
  lastCursor: null
};

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function load() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) return { designs: {}, quotes: [], settings: structuredClone(DEFAULT_SETTINGS) };
  try {
    const p = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const settings = Object.assign(structuredClone(DEFAULT_SETTINGS), p.settings || {});
    settings.pricing = Object.assign({}, DEFAULT_SETTINGS.pricing, (p.settings || {}).pricing || {});
    return { designs: p.designs || {}, quotes: p.quotes || [], settings };
  } catch (err) {
    console.error("[db] db.json unreadable, backing it up and starting fresh:", err.message);
    try { fs.copyFileSync(DB_PATH, DB_PATH + ".corrupt-" + Date.now()); } catch (_) {}
    return { designs: {}, quotes: [], settings: structuredClone(DEFAULT_SETTINGS) };
  }
}

let state = load();
let timer = null;

function persist() {
  ensureDir();
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
let lastWriteError = null;
function scheduleWrite() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { persist(); lastWriteError = null; }
    catch (e) { lastWriteError = e.message; console.error("[db] write failed:", e.message); }
  }, 150);
}
// Checks the data folder is writable right now (used by the admin status check)
function checkWritable() {
  const probe = path.join(DATA_DIR, ".write-test");
  try { ensureDir(); fs.writeFileSync(probe, "ok"); fs.unlinkSync(probe); return null; }
  catch (e) { return e.message; }
}
const writeError = () => lastWriteError || checkWritable();
function flushSync() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { persist(); } catch (e) { console.error("[db] flush failed:", e.message); }
}

// designs — undefined values are skipped so syncs never clobber admin fields
function upsertDesign(slug, fields) {
  const clean = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  state.designs[slug] = Object.assign({}, state.designs[slug] || {}, clean, { slug });
  scheduleWrite();
  return state.designs[slug];
}
const getDesign = (slug) => state.designs[slug] || null;
const allDesigns = () => Object.values(state.designs);

// quotes
function addQuote(q) { state.quotes.unshift(q); scheduleWrite(); return q; }
function updateQuote(id, fields) {
  const q = state.quotes.find(x => x.id === id);
  if (q) { Object.assign(q, fields); scheduleWrite(); }
  return q || null;
}
const getQuote = (id) => state.quotes.find(q => q.id === id) || null;
const allQuotes = () => state.quotes;

// settings
const getSettings = () => state.settings;
function updateSettings(fields) {
  const next = Object.assign({}, state.settings, fields);
  if (fields.pricing) next.pricing = Object.assign({}, state.settings.pricing, fields.pricing);
  state.settings = next;
  scheduleWrite();
  return next;
}

module.exports = {
  DATA_DIR,
  upsertDesign, getDesign, allDesigns,
  addQuote, updateQuote, getQuote, allQuotes,
  getSettings, updateSettings, flushSync, writeError, DEFAULT_SETTINGS
};
