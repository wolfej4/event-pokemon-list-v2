"use strict";
const express = require("express");
const QRCode = require("qrcode");
const db = require("../db");
const n3d = require("../n3dClient");
const square = require("../squareClient");
const mailer = require("../mailer");
const { checkPassword, requireAdmin } = require("../auth");

const router = express.Router();

// ---- auth ----
router.post("/login", (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: "wrong_password" });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/session", (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// everything below requires a logged-in admin
router.use(requireAdmin);

// ---- designs ----
router.get("/designs", (req, res) => {
  const list = db.allDesigns().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  res.json({ data: list });
});

router.post("/designs/:slug", (req, res) => {
  const { slug } = req.params;
  const existing = db.getDesign(slug);
  if (!existing) return res.status(404).json({ error: "not_found" });

  const body = req.body || {};
  const update = {};

  if ("price" in body) {
    if (body.price === "" || body.price === null) {
      update.price_cents = null;
    } else {
      const dollars = Number(body.price);
      if (Number.isNaN(dollars) || dollars < 0) {
        return res.status(400).json({ error: "invalid_price" });
      }
      update.price_cents = Math.round(dollars * 100);
    }
  }
  if ("shop_url" in body) {
    update.shop_url = body.shop_url ? String(body.shop_url).trim() : null;
  }
  if ("visible" in body) {
    update.visible = !!body.visible;
  }
  if ("featured" in body) {
    update.featured = !!body.featured;
  }

  const saved = db.setAdminFields(slug, update);
  res.json({ data: saved });
});

// ---- settings ----
router.get("/settings", (req, res) => {
  res.json(db.getSettings());
});

router.post("/settings", (req, res) => {
  const {
    businessName, businessEmail, hoursPerDayCapacity, leadTimeBufferDays,
    eventModeEnabled, kioskModeEnabled, kioskIdleMinutes
  } = req.body || {};
  const update = {};
  if (businessName !== undefined) update.businessName = String(businessName).trim();
  if (businessEmail !== undefined) update.businessEmail = String(businessEmail).trim();
  if (hoursPerDayCapacity !== undefined) {
    const n = Number(hoursPerDayCapacity);
    if (Number.isNaN(n) || n <= 0) return res.status(400).json({ error: "invalid_hours_per_day" });
    update.hoursPerDayCapacity = n;
  }
  if (leadTimeBufferDays !== undefined) {
    const n = Number(leadTimeBufferDays);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: "invalid_buffer_days" });
    update.leadTimeBufferDays = n;
  }
  if (eventModeEnabled !== undefined) update.eventModeEnabled = !!eventModeEnabled;
  if (kioskModeEnabled !== undefined) update.kioskModeEnabled = !!kioskModeEnabled;
  if (kioskIdleMinutes !== undefined) {
    const n = Number(kioskIdleMinutes);
    if (Number.isNaN(n) || n < 0.5) return res.status(400).json({ error: "invalid_kiosk_idle_minutes" });
    update.kioskIdleMinutes = n;
  }
  res.json(db.updateSettings(update));
});

router.get("/smtp-status", (req, res) => {
  res.json({ configured: mailer.isConfigured() });
});

router.post("/smtp-test", async (req, res) => {
  try {
    await mailer.verifyConnection();
    res.json({ ok: true });
  } catch (err) {
    res.status(err.isNotConfigured ? 400 : 502).json({ ok: false, error: err.message });
  }
});

// ---- storefront QR code ----
// Encodes whatever host/protocol the browser used to reach /admin, so the
// code always points at wherever this instance is actually being served
// from (custom domain, tunnel, raw IP:port, whatever) without needing that
// URL configured anywhere.
router.get("/qrcode.png", async (req, res) => {
  const url = req.protocol + "://" + req.get("host") + "/";
  try {
    const png = await QRCode.toBuffer(url, { width: 640, margin: 2 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store"); // host can change between requests (different domain/tunnel)
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: "qrcode_failed" });
  }
});

router.get("/qrcode-url", (req, res) => {
  res.json({ url: req.protocol + "://" + req.get("host") + "/" });
});

// ---- sync ----
let syncInProgress = false;

router.post("/sync", async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ error: "sync_already_running" });
  }
  const full = !!(req.body && req.body.full);
  syncInProgress = true;
  try {
    const settings = db.getSettings();
    const since = full ? null : settings.lastCursor;
    let added = 0, updated = 0;

    const result = await n3d.syncCatalog({
      since,
      onPage: async (designs) => {
        for (const d of designs) {
          const isNew = !db.getDesign(d.slug);
          // new designs default to visible=true, no price, no shop link —
          // "contact for pricing" until the admin sets them
          db.upsertDesign(d.slug, {
            title: d.title,
            category: d.category,
            image_url: d.image_url,
            sprite_url: d.sprite_url,
            print_time: d.print_time,
            print_time_seconds: d.print_time_seconds,
            total_weight_grams: d.total_weight_grams,
            round: d.round,
            purchase_only: d.purchase_only,
            updated_at: d.updated_at,
            pokemon: d.pokemon,
            filaments: d.filaments,
            profiles: d.profiles,
            synced_at: new Date().toISOString(),
            visible: isNew ? true : undefined,
            featured: isNew ? false : undefined,
            price_cents: isNew ? null : undefined,
            shop_url: isNew ? null : undefined
          });
          if (isNew) added++; else updated++;
        }
      }
    });

    db.updateSettings({ lastCursor: result.cursor });

    // Incremental syncs only see designs N3D reports as "changed" — but a
    // sprite can show up for an existing character design without its
    // updated_at moving (N3D generates them shortly after a design goes
    // live), so that design could stay spriteless forever if we only ever
    // look at what changed. Run one supplementary full-catalog pass to
    // backfill sprite_url, but only when something is actually missing —
    // keeps a normal incremental sync cheap in the (eventual) common case
    // where every character design already has its sprite.
    let spritesFilled = 0;
    const pendingSprites = !full && db.allDesigns().some(d => d.category === "character" && !d.sprite_url);
    if (pendingSprites) {
      try {
        await n3d.syncCatalog({
          since: null,
          onPage: async (designs) => {
            for (const d of designs) {
              const existing = db.getDesign(d.slug);
              if (existing && !existing.sprite_url && d.sprite_url) {
                db.upsertDesign(d.slug, { sprite_url: d.sprite_url });
                spritesFilled++;
              }
            }
          }
        });
      } catch (err) {
        console.error("[sync] sprite backfill pass failed:", err.message);
      }
    }

    res.json({ ok: true, added, updated, totalSeen: result.totalSeen, spritesFilled });
  } catch (err) {
    const status = err.isAuth ? 502 : 500;
    res.status(status).json({ error: err.message || "sync_failed" });
  } finally {
    syncInProgress = false;
  }
});

router.get("/key-status", async (req, res) => {
  try {
    const info = await n3d.checkKey();
    res.json({ ok: true, info });
  } catch (err) {
    res.status(err.isAuth ? 401 : 502).json({ ok: false, error: err.message });
  }
});

// ---- Square catalog push ----
router.get("/square-status", (req, res) => {
  res.json({ configured: square.isConfigured() });
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pushOne(slug) {
  const design = db.getDesign(slug);
  if (!design) {
    const err = new Error("not_found");
    throw err;
  }
  try {
    const fields = await square.pushDesign(design);
    return db.setSquareFields(slug, Object.assign(
      { square_sync_error: null, square_sync_error_at: null },
      fields
    ));
  } catch (err) {
    db.setSquareFields(slug, {
      square_sync_error: err.message || "square_push_failed",
      square_sync_error_at: new Date().toISOString()
    });
    throw err;
  }
}

router.post("/designs/:slug/square-push", async (req, res) => {
  if (!square.isConfigured()) {
    return res.status(400).json({ error: "Square isn't configured — set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID." });
  }
  try {
    const saved = await pushOne(req.params.slug);
    res.json({ ok: true, data: saved });
  } catch (err) {
    if (err.message === "not_found") return res.status(404).json({ error: "not_found" });
    res.status(err.isAuth ? 502 : 500).json({ error: err.message || "square_push_failed" });
  }
});

let squarePushInProgress = false;

router.post("/square-push-all", async (req, res) => {
  if (!square.isConfigured()) {
    return res.status(400).json({ error: "Square isn't configured — set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID." });
  }
  if (squarePushInProgress) {
    return res.status(409).json({ error: "square_push_already_running" });
  }
  const slugs = Array.isArray(req.body && req.body.slugs) && req.body.slugs.length
    ? req.body.slugs
    : db.allDesigns().filter(d => d.visible !== false).map(d => d.slug);

  squarePushInProgress = true;
  const failures = [];
  let pushed = 0;
  try {
    for (const slug of slugs) {
      try {
        await pushOne(slug);
        pushed++;
      } catch (err) {
        const design = db.getDesign(slug);
        failures.push({ slug, title: design ? design.title : slug, error: err.message || "failed" });
      }
      await sleep(150); // be polite to Square's rate limits
    }
    res.json({ ok: true, pushed, failed: failures.length, failures });
  } finally {
    squarePushInProgress = false;
  }
});

// ---- quote request log ----
router.get("/quotes", (req, res) => {
  res.json({ data: db.listQuoteLogs() });
});

function csvEscape(val) {
  const s = val === null || val === undefined ? "" : String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get("/quotes.csv", (req, res) => {
  const rows = db.listQuoteLogs();
  const header = ["Date", "Customer", "Email", "Items", "Estimated cost", "Lead time (days)", "Status", "Notes"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const itemTitles = (r.items || []).map(i => i.title).join("; ");
    const cost = r.totalCents != null ? "$" + (r.totalCents / 100).toFixed(2) : "";
    const leadTime = r.leadTimeLow != null ? r.leadTimeLow + "-" + r.leadTimeHigh : "";
    lines.push([
      r.createdAt, r.customerName || "", r.customerEmail || "", itemTitles,
      cost, leadTime, r.status || "", r.notes || ""
    ].map(csvEscape).join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=quote-requests.csv");
  res.send(lines.join("\n"));
});

module.exports = router;
