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
const enrich = require("../enrich");
const catalog = require("../squareCatalog");

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
    storageError: db.writeError(),
    enrich: enrich.state
  });
});

// ---------- designs ----------
// Square IDs are kept per environment so testing in sandbox never overwrites
// (and later duplicates) the items in the live catalog. Designs pushed before
// this existed only have top-level IDs, and those were always production.
const SQ_FIELDS = ["square_item_id", "square_variation_id", "square_variation_id_shiny", "square_image_src", "square_image_ok", "square_pushed_at"];
function squareIdsFor(d, env) {
  if (d.square_by_env) return d.square_by_env[env] || {};
  if (env === "production" && d.square_item_id) { const o = {}; SQ_FIELDS.forEach(k => { o[k] = d[k]; }); return o; }
  return {};
}
function toAdmin(d, s) {
  const ids = squareIdsFor(d, square.envName());
  const current = {}; SQ_FIELDS.forEach(k => { current[k] = ids[k] || null; });
  return Object.assign({}, d, current, {
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
    for (const k of ["baseFee", "perGram", "perHour", "markupPct", "minPrice", "roundTo", "shinyUpcharge"]) {
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
            sprite_url: d.sprite_url || null, sprite_revision: d.sprite_revision || null,
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
    enrich.run(); // sprites and evolution families, in the background
    res.json({ ok: true, added, updated, seen: result.total });
  } catch (e) {
    res.status(e.isAuth ? 502 : 500).json({ error: e.message || "Sync failed." });
  } finally {
    syncing = false;
  }
});

router.get("/n3d/check", async (req, res) => {
  try { res.json({ ok: true, info: await n3d.checkKey() }); }
  catch (e) { res.status(422).json({ ok: false, error: e.message }); }
});

// ---------- quotes ----------
router.get("/quotes", (req, res) => {
  const cur = db.getSettings().currency;
  res.json({ data: db.allQuotes().map(q => Object.assign({}, q, { total: fmt(q.total_cents, cur), token: undefined })) });
});

// Failures from Square/N3D/Spoolman are answered with 422, not 502: proxies
// such as Cloudflare or Nginx Proxy Manager can swap a 502 for their own
// "Bad Gateway" page, which hides the actual error from the admin panel.

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
  const rows = [["id", "created_at", "status", "source", "name", "email", "phone", "items", "total", "notes", "customer_email", "business_email", "delivery", "shipping"]];
  for (const q of db.allQuotes()) {
    rows.push([q.id, q.created_at, q.status, q.source, q.customer.name, q.customer.email, q.customer.phone,
      q.items.map(i => `${i.qty}x ${i.title}`).join("; "), (q.total_cents / 100).toFixed(2), q.customer.notes,
      q.email && q.email.customer, q.email && q.email.business,
      q.fulfillment || "", q.shipping_cents != null ? (q.shipping_cents / 100).toFixed(2) : ""]);
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="quotes.csv"');
  res.send(rows.map(r => r.map(csvCell).join(",")).join("\n"));
});

router.post("/smtp/test", async (req, res) => {
  try { await mailer.verify(); res.json({ ok: true }); }
  catch (e) { res.status(422).json({ ok: false, error: e.message }); }
});

// ---------- Spoolman ----------
router.get("/spoolman/test", async (req, res) => {
  try { res.json({ ok: true, info: await spoolman.testConnection() }); }
  catch (e) { res.status(422).json({ ok: false, error: e.message }); }
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
    res.status(422).json({ error: e.message });
  }
});
router.get("/spoolman/report", (req, res) => res.json({ report: lastInventoryReport }));

// ---------- Square ----------
router.get("/square/test", async (req, res) => {
  try { res.json({ ok: true, locations: await square.testConnection() }); }
  catch (e) { res.status(422).json({ ok: false, error: e.message }); }
});

// Saves the item IDs as soon as Square creates the item, then tries the photo.
// (Saving only after the photo meant a failed photo upload lost the new ID,
// so every push created another copy of the item.)
async function pushOne(slug) {
  const d = db.getDesign(slug);
  if (!d) throw new Error("not found");
  const s = db.getSettings();
  const env = square.envName();
  const ids = squareIdsFor(d, env);
  const saveIds = (fields, extra) => {
    const cur = squareIdsFor(db.getDesign(slug), env);
    const next = Object.assign({}, cur, fields);
    const byEnv = { production: squareIdsFor(d, "production"), sandbox: squareIdsFor(d, "sandbox") };
    byEnv[env] = next;
    return db.upsertDesign(slug, Object.assign({}, next, { square_by_env: byEnv }, extra));
  };

  const priceCents = unitCents(d, s.pricing);
  const dex = d.pokemon && d.pokemon.pokedex_number;
  const sku = dex ? String(dex) : null;
  // every Pokémon design also offers a Shiny variation at an upcharge; plain
  // balls and anything without a Pokémon don't get one
  const shinyPriceCents = d.pokemon ? priceCents + Math.round((Number(s.pricing.shinyUpcharge) || 0) * 100) : null;

  let catFields = {}, customAttrs = {};
  try {
    catFields = await catalog.categoriesFieldsFor(d);
    customAttrs = await catalog.customAttributesFor(d);
  } catch (e) {
    // a hiccup creating a category shouldn't block the item's price and photo from updating
    console.error("[square] categories/attributes failed for " + slug + ":", e.message);
  }

  let item;
  try {
    item = await square.upsertItem(Object.assign({}, d, { square_item_id: ids.square_item_id || null }), priceCents, {
      currency: s.currency, overwritePrice: s.squareOverwritePrices,
      categories: catFields.categories, reportingCategory: catFields.reporting_category,
      customAttributeValues: customAttrs, shinyPriceCents, sku
    });
  } catch (e) {
    console.error("[square] push failed for " + slug + ":", e.message);
    db.upsertDesign(slug, { square_error: e.message });
    throw e;
  }
  const created = item.created; delete item.created;
  let saved = saveIds(created ? Object.assign(item, { square_image_src: null, square_image_ok: false }) : item, { square_error: null });

  // Every push records what happened to the photo, so it never fails silently.
  // Upload when the item is new, N3D changed the image, or it hasn't been
  // confirmed on the item yet (including items pushed before photos worked).
  if (!d.image_url) {
    saved = db.upsertDesign(slug, { square_image_error: "N3D has no image for this design" });
  } else if (created || ids.square_image_src !== d.image_url || !ids.square_image_ok) {
    try {
      await square.uploadImage(item.square_item_id, d.image_url, String(d.title || slug));
      saved = saveIds({ square_image_src: d.image_url, square_image_ok: true }, { square_image_error: null });
    } catch (e) {
      console.error("[square] photo upload failed for " + slug + ":", e.message);
      saved = saveIds({ square_image_ok: false }, { square_image_error: e.message });
    }
  } else if (saved.square_image_error) {
    saved = db.upsertDesign(slug, { square_image_error: null });
  }
  return saved;
}

// Items this app created in Square that aren't the one each design points to:
// the copies left behind when pushes kept recreating items.
function duplicateItems(items) {
  const env = square.envName();
  const byTitle = {};
  for (const d of db.allDesigns()) {
    const id = squareIdsFor(d, env).square_item_id;
    if (id) byTitle[String(d.title || d.slug).slice(0, 255)] = id;
  }
  return items.filter(it => byTitle[it.name] && it.id !== byTitle[it.name]);
}
router.get("/square/duplicates", async (req, res) => {
  try {
    const dups = duplicateItems(await square.listAppItems());
    res.json({ ok: true, count: dups.length, items: dups.slice(0, 500) });
  } catch (e) { res.status(422).json({ error: e.message }); }
});
router.post("/square/duplicates/delete", async (req, res) => {
  try {
    // recompute on the server so only real duplicates can be deleted
    const dups = duplicateItems(await square.listAppItems());
    await square.deleteItems(dups.map(x => x.id));
    res.json({ ok: true, deleted: dups.length });
  } catch (e) { res.status(422).json({ error: e.message }); }
});

router.post("/square/push/:slug", async (req, res) => {
  try { res.json({ ok: true, data: toAdmin(await pushOne(req.params.slug), db.getSettings()) }); }
  catch (e) { res.status(422).json({ error: e.message }); }
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
