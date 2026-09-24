"use strict";
const express = require("express");
const db = require("../db");
const n3d = require("../n3dClient");
const square = require("../squareClient");
const spoolman = require("../spoolmanClient");
const { buildColorReport } = require("../inventory");
const mailer = require("../mailer");
const { formulaCents, unitCents, fmt } = require("../pricing");
const { buildQuotePdf } = require("../pdf");
const { checkPassword, requireAdmin } = require("../auth");
const rateLimit = require("../rateLimit");
const logo = require("../logo");
const payments = require("../payments");

const router = express.Router();

// ---------- auth ----------
router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
  if (!checkPassword((req.body || {}).password)) return res.status(401).json({ error: "Wrong password." });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "session_error" });
    req.session.isAdmin = true;
    res.json({ ok: true });
  });
});
router.post("/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
router.get("/session", (req, res) => res.json({ isAdmin: !!(req.session && req.session.isAdmin) }));

router.use(requireAdmin);

// ---------- status ----------
router.get("/status", (req, res) => {
  res.json({
    n3dKey: !!process.env.N3D_API_KEY,
    smtp: mailer.configured(),
    smtpSource: mailer.config().source,
    square: square.configured(),
    squareEnv: square.isSandbox() ? "sandbox" : "production",
    spoolman: spoolman.configured(),
    paymentProblem: payments.problem(),
    storageError: db.writeError()
  });
});

// ---------- designs ----------
function toAdmin(d, s) {
  return Object.assign({}, d, {
    formula_cents: formulaCents(d, s.pricing),
    effective_cents: unitCents(d, s.pricing)
  });
}

router.get("/designs", (req, res) => {
  const s = db.getSettings();
  const list = db.allDesigns().map(d => toAdmin(d, s))
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { numeric: true }));
  res.json({ data: list });
});

router.post("/designs/:slug", (req, res) => {
  const d = db.getDesign(req.params.slug);
  if (!d) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const u = {};
  if ("price" in b) {
    if (b.price === "" || b.price === null) u.price_cents = null;
    else {
      const n = Number(b.price);
      if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: "Price must be a positive number." });
      u.price_cents = Math.round(n * 100);
    }
  }
  if ("shop_url" in b) {
    const url = String(b.shop_url || "").trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Shop link must start with http:// or https://" });
    u.shop_url = url || null;
  }
  if ("visible" in b) u.visible = !!b.visible;
  // null out explicitly (upsert skips undefined, not null)
  const saved = db.upsertDesign(d.slug, u);
  res.json({ data: toAdmin(saved, db.getSettings()) });
});

// Bulk: clear all overrides or set visibility
router.post("/designs-bulk", (req, res) => {
  const { action, slugs } = req.body || {};
  const targets = Array.isArray(slugs) && slugs.length ? slugs : db.allDesigns().map(d => d.slug);
  let n = 0;
  for (const slug of targets) {
    if (!db.getDesign(slug)) continue;
    if (action === "clear_overrides") db.upsertDesign(slug, { price_cents: null });
    else if (action === "show") db.upsertDesign(slug, { visible: true });
    else if (action === "hide") db.upsertDesign(slug, { visible: false });
    else return res.status(400).json({ error: "unknown action" });
    n++;
  }
  res.json({ ok: true, changed: n });
});

// ---------- settings ----------
// never send the saved SMTP password back to the browser
function publicSettings(s) {
  const smtp = s.smtp || {};
  return Object.assign({}, s, { smtp: Object.assign({}, smtp, { pass: undefined, passSet: !!smtp.pass }) });
}
router.get("/settings", (req, res) => res.json(publicSettings(db.getSettings())));

router.post("/smtp", (req, res) => {
  const b = req.body || {};
  if (b.clear) return res.json(publicSettings(db.updateSettings({ smtp: {} })));
  const prev = db.getSettings().smtp || {};
  const str = (v) => String(v == null ? "" : v).trim().slice(0, 500);
  const smtp = { host: str(b.host), user: str(b.user), from: str(b.from) };
  if (!smtp.host) return res.status(400).json({ error: "Enter the mail server host." });
  if (!smtp.from) return res.status(400).json({ error: "Enter the From address." });
  const port = parseInt(b.port, 10);
  if (!(port >= 1 && port <= 65535)) return res.status(400).json({ error: "Port must be a number between 1 and 65535." });
  smtp.port = port;
  smtp.secure = b.secure === true || b.secure === "true" ? true : b.secure === false || b.secure === "false" ? false : null;
  // a blank password keeps the saved one; clearPass removes it
  smtp.pass = b.clearPass ? "" : (b.pass ? String(b.pass).slice(0, 500) : (prev.pass || ""));
  res.json(publicSettings(db.updateSettings({ smtp })));
});

router.post("/settings", (req, res) => {
  const b = req.body || {};
  const u = {};
  for (const k of ["businessName", "businessEmail", "businessPhone", "tagline", "quoteFooter"]) {
    if (b[k] !== undefined) u[k] = String(b[k]).trim().slice(0, 2000);
  }
  if (b.currency !== undefined) u.currency = /^[A-Z]{3}$/.test(b.currency) ? b.currency : "USD";
  if (b.kioskIdleSeconds !== undefined) u.kioskIdleSeconds = Math.min(3600, Math.max(15, parseInt(b.kioskIdleSeconds, 10) || 90));
  if (b.squareOverwritePrices !== undefined) u.squareOverwritePrices = !!b.squareOverwritePrices;
  if (b.logoShowName !== undefined) u.logoShowName = !!b.logoShowName;
  if (b.squarePaymentLinks !== undefined) u.squarePaymentLinks = !!b.squarePaymentLinks;
  if (b.squareLocationId !== undefined) u.squareLocationId = String(b.squareLocationId || "").trim().slice(0, 64);
  if (b.spoolmanLowStockGrams !== undefined) {
    const n = Number(b.spoolmanLowStockGrams);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "Low-stock threshold must be 0 or more." });
    u.spoolmanLowStockGrams = n;
  }
  if (b.spoolmanMatchThreshold !== undefined) {
    const n = Number(b.spoolmanMatchThreshold);
    if (!Number.isFinite(n) || n < 0 || n > 441) return res.status(400).json({ error: "Color match sensitivity must be between 0 and 441." });
    u.spoolmanMatchThreshold = n;
  }
  if (b.pricing) {
    u.pricing = {};
    for (const k of ["baseFee", "perGram", "perHour", "markupPct", "minPrice", "roundTo", "shipping"]) {
      if (b.pricing[k] === undefined) continue;
      const n = Number(b.pricing[k]);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `Pricing value "${k}" must be 0 or more.` });
      u.pricing[k] = n;
    }
  }
  res.json(publicSettings(db.updateSettings(u)));
});

// ---------- logo ----------
router.post("/logo/:variant", express.raw({ type: () => true, limit: "2mb" }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Choose an image file." });
    const meta = logo.save(req.params.variant, req.body);
    const logos = Object.assign({}, db.getSettings().logos, { [req.params.variant]: meta });
    const s = db.updateSettings({ logos });
    res.json({ ok: true, logo: logo.urls(s), logos: s.logos });
  } catch (e) {
    if (e.code === "EACCES" || e.code === "EPERM") {
      return res.status(500).json({ error: "The app can't write to its data folder. See the warning at the top of the admin panel." });
    }
    res.status(400).json({ error: e.message });
  }
});
router.delete("/logo/:variant", (req, res) => {
  if (!logo.VARIANTS.includes(req.params.variant)) return res.status(400).json({ error: "Unknown logo variant." });
  logo.remove(req.params.variant);
  const logos = Object.assign({}, db.getSettings().logos);
  delete logos[req.params.variant];
  const s = db.updateSettings({ logos });
  res.json({ ok: true, logo: logo.urls(s), logos: s.logos });
});

// ---------- N3D sync ----------
let syncing = false;
router.post("/sync", async (req, res) => {
  if (syncing) return res.status(409).json({ error: "A sync is already running." });
  syncing = true;
  const full = !!(req.body && req.body.full);
  try {
    let added = 0, updated = 0;
    const result = await n3d.syncCatalog({
      since: full ? null : db.getSettings().lastCursor,
      onPage: async (designs) => {
        for (const d of designs) {
          if (!d || !d.slug) continue;
          const isNew = !db.getDesign(d.slug);
          db.upsertDesign(d.slug, {
            title: d.title, category: d.category, image_url: d.image_url,
            print_time: d.print_time, total_weight_grams: d.total_weight_grams,
            round: d.round, purchase_only: d.purchase_only, updated_at: d.updated_at,
            pokemon: d.pokemon, filaments: d.filaments,
            synced_at: new Date().toISOString(),
            // first-time defaults; undefined leaves existing admin values alone
            visible: isNew ? true : undefined,
            price_cents: isNew ? null : undefined,
            shop_url: isNew ? null : undefined
          });
          isNew ? added++ : updated++;
        }
      }
    });
    if (result.cursor) db.updateSettings({ lastCursor: result.cursor });
    res.json({ ok: true, added, updated, seen: result.total });
  } catch (e) {
    res.status(e.isAuth ? 502 : 500).json({ error: e.message || "Sync failed." });
  } finally {
    syncing = false;
  }
});

router.get("/n3d/check", async (req, res) => {
  try { res.json({ ok: true, info: await n3d.checkKey() }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- quotes ----------
router.get("/quotes", async (req, res) => {
  // check Square for newly paid links; a Square outage shouldn't hide the list
  let paymentError = null;
  if (square.configured()) {
    try { await payments.refreshStatuses(db.allQuotes().slice(0, 300)); }
    catch (e) { paymentError = e.message; }
  }
  const cur = db.getSettings().currency;
  res.json({ paymentError, paymentProblem: payments.problem(), data: db.allQuotes().map(q => Object.assign({}, q, { total: fmt(q.total_cents, cur), token: undefined })) });
});

// Cheap poll for the admin badge and notifications: orders still marked "new".
router.get("/orders/new", (req, res) => {
  const cur = db.getSettings().currency;
  const list = db.allQuotes().filter(q => q.status === "new");
  res.json({
    count: list.length,
    orders: list.slice(0, 20).map(q => ({
      id: q.id, name: q.customer.name, total: fmt(q.total_cents, cur),
      fulfillment: q.fulfillment || null, created_at: q.created_at
    }))
  });
});

router.post("/quotes/:id/payment-link", async (req, res) => {
  const q = db.getQuote(req.params.id);
  if (!q) return res.status(404).json({ error: "not_found" });
  if (!square.configured()) return res.status(400).json({ error: "SQUARE_ACCESS_TOKEN isn't set." });
  if (q.payment && q.payment.url) return res.json({ ok: true, payment: q.payment });
  const saved = await payments.attachLink(q, req);
  if (saved.payment.error) return res.status(502).json({ error: saved.payment.error });
  res.json({ ok: true, payment: saved.payment });
});

router.post("/quotes/:id", (req, res) => {
  const status = String((req.body || {}).status || "");
  if (!["new", "printing", "ready", "shipped", "completed", "cancelled"].includes(status)) return res.status(400).json({ error: "bad status" });
  const q = db.updateQuote(req.params.id, { status });
  if (!q) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.get("/quotes/:id/pdf", async (req, res) => {
  const q = db.getQuote(req.params.id);
  if (!q) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="estimate-${q.id}.pdf"`);
  res.send(await buildQuotePdf(q, db.getSettings()));
});

router.post("/quotes/:id/resend", async (req, res) => {
  const q = db.getQuote(req.params.id);
  if (!q) return res.status(404).json({ error: "not_found" });
  const s = db.getSettings();
  const email = await mailer.sendQuoteEmails(q, await buildQuotePdf(q, s), s);
  db.updateQuote(q.id, { email });
  res.json({ ok: true, email });
});

function csvCell(v) {
  const s = v == null ? "" : String(v);
  // guard against spreadsheet formula injection
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
router.get("/quotes.csv", (req, res) => {
  const rows = [["id", "created_at", "status", "source", "name", "email", "phone", "items", "total", "notes", "customer_email", "business_email", "delivery", "shipping", "payment", "ship_to"]];
  for (const q of db.allQuotes()) {
    rows.push([q.id, q.created_at, q.status, q.source, q.customer.name, q.customer.email, q.customer.phone,
      q.items.map(i => `${i.qty}x ${i.title}`).join("; "), (q.total_cents / 100).toFixed(2), q.customer.notes,
      q.email && q.email.customer, q.email && q.email.business,
      q.fulfillment || "", q.shipping_cents != null ? (q.shipping_cents / 100).toFixed(2) : "",
      q.payment ? (q.payment.status || "error") : "", q.payment && q.payment.ship_to]);
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="quotes.csv"');
  res.send(rows.map(r => r.map(csvCell).join(",")).join("\n"));
});

router.post("/smtp/test", async (req, res) => {
  try { await mailer.verify(); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- Spoolman ----------
router.get("/spoolman/test", async (req, res) => {
  try { res.json({ ok: true, info: await spoolman.testConnection() }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

let lastInventoryReport = null;
router.post("/spoolman/check", async (req, res) => {
  try {
    const spools = await spoolman.listSpools();
    const s = db.getSettings();
    lastInventoryReport = buildColorReport(db.allDesigns(), spools, {
      lowStockGrams: s.spoolmanLowStockGrams, matchThreshold: s.spoolmanMatchThreshold
    });
    res.json({ ok: true, report: lastInventoryReport });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
router.get("/spoolman/report", (req, res) => res.json({ report: lastInventoryReport }));

// ---------- Square ----------
router.get("/square/test", async (req, res) => {
  try { res.json({ ok: true, locations: await square.testConnection() }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

async function pushOne(slug) {
  const d = db.getDesign(slug);
  if (!d) throw new Error("not found");
  const s = db.getSettings();
  try {
    const out = await square.pushDesign(d, unitCents(d, s.pricing), {
      currency: s.currency, overwritePrice: s.squareOverwritePrices
    });
    return db.upsertDesign(slug, out);
  } catch (e) {
    db.upsertDesign(slug, { square_error: e.message });
    throw e;
  }
}

router.post("/square/push/:slug", async (req, res) => {
  try { res.json({ ok: true, data: toAdmin(await pushOne(req.params.slug), db.getSettings()) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post("/square/test-payment-link", async (req, res) => {
  if (!square.configured()) return res.status(400).json({ error: "SQUARE_ACCESS_TOKEN isn't set." });
  try { const l = await payments.testLink(req); res.json({ ok: true, location_id: l.location_id }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Bulk push runs in the background so a long run doesn't time out behind a proxy.
const job = { running: false, total: 0, done: 0, failed: 0, errors: [], startedAt: null, finishedAt: null };
router.post("/square/push-all", (req, res) => {
  if (job.running) return res.status(409).json({ error: "A Square push is already running." });
  const onlyVisible = !(req.body && req.body.includeHidden);
  const slugs = db.allDesigns().filter(d => !onlyVisible || d.visible !== false).map(d => d.slug);
  Object.assign(job, { running: true, total: slugs.length, done: 0, failed: 0, errors: [], startedAt: new Date().toISOString(), finishedAt: null });
  (async () => {
    for (const slug of slugs) {
      try { await pushOne(slug); }
      catch (e) { job.failed++; if (job.errors.length < 50) job.errors.push({ slug, error: e.message }); }
      job.done++;
      await new Promise(r => setTimeout(r, 300)); // stay well under Square's rate limit
    }
    job.running = false;
    job.finishedAt = new Date().toISOString();
  })();
  res.json({ ok: true, total: slugs.length });
});
router.get("/square/status", (req, res) => res.json(job));

module.exports = router;
