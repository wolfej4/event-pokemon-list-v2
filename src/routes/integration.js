"use strict";
// The link to Voxelwaves Stockroom, mounted at /api/v1:
//
//   GET  /api/v1/designs          Stockroom reads the design list (to link items
//                                  and keep their prices in step). X-API-Key.
//   POST /api/v1/webhooks/square  Square's payment webhook. A completed payment
//                                  takes each sold catalog item off the shelf
//                                  count in Stockroom.
//
// The webhook lives here rather than in Stockroom because this app is already
// public and already knows which Square variation is which design and
// version; Stockroom stays behind Pocket ID with no Square credentials.
const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const square = require("../squareClient");
const stockroom = require("../stockroomClient");
const { squareIdsFor } = require("../squareIds");
const { unitCents, shinyCents } = require("../pricing");

const router = express.Router();

function keyOk(given) {
  const real = String(process.env.INTEGRATION_KEY || "").trim();
  if (!real) return null; // integration off
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

router.get("/designs", (req, res) => {
  const ok = keyOk(req.get("X-API-Key"));
  if (ok === null) return res.status(503).json({ error: "integration_disabled", detail: "Set INTEGRATION_KEY to turn this on." });
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  const s = db.getSettings();
  const designs = db.allDesigns()
    .slice().sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { numeric: true }))
    .map(d => ({
      slug: d.slug,
      title: d.title || d.slug,
      category: d.category || null,
      visible: d.visible !== false,
      pokedex_number: (d.pokemon && d.pokemon.pokedex_number) || null,
      price_cents: unitCents(d, s.pricing),
      shiny_price_cents: shinyCents(d, s.pricing),
      has_shiny: !!d.pokemon
    }));
  res.json({ designs, currency: s.currency });
});

// ---------- Square sales ----------

// The last few webhook deliveries, newest first, for admin → Square.
const recent = [];
function remember(entry) {
  recent.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  recent.length = Math.min(recent.length, 25);
}

// Square signs HMAC-SHA256(signature key, notification URL + raw body), base64.
function signatureOk(req, raw) {
  const sigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
  const given = req.get("x-square-hmacsha256-signature") || "";
  if (!sigKey || !given) return false;
  // must be the URL exactly as entered in the Square Developer Console
  const url = process.env.SQUARE_WEBHOOK_URL || (req.protocol + "://" + req.get("host") + req.originalUrl);
  const want = crypto.createHmac("sha256", sigKey).update(url + raw.toString("utf8")).digest();
  let got;
  try { got = Buffer.from(given, "base64"); } catch (_) { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Square variation ID -> { slug, variant, title } for the environment the app is in.
function variationMap() {
  const env = square.envName(), map = {};
  for (const d of db.allDesigns()) {
    const ids = squareIdsFor(d, env);
    if (ids.square_variation_id) map[ids.square_variation_id] = { slug: d.slug, variant: "regular", title: d.title };
    if (ids.square_variation_id_shiny) map[ids.square_variation_id_shiny] = { slug: d.slug, variant: "shiny", title: d.title };
  }
  return map;
}

router.post("/webhooks/square", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY) return res.status(503).json({ error: "webhook_not_configured" });
  if (!signatureOk(req, raw)) {
    remember({ result: "rejected: bad signature (check SQUARE_WEBHOOK_URL matches the URL in Square exactly)" });
    return res.status(403).json({ error: "bad_signature" });
  }
  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch (_) { return res.status(400).json({ error: "bad_json" }); }

  const payment = event && event.data && event.data.object && event.data.object.payment;
  if (!/^payment\.(created|updated)$/.test(event.type || "") || !payment) return res.json({ ok: true, ignored: event.type });
  if (payment.status !== "COMPLETED" || !payment.order_id) return res.json({ ok: true, ignored: "payment " + payment.status });
  if (!stockroom.configured()) {
    remember({ order: payment.order_id, result: "skipped: Stockroom isn't set up (STOCKROOM_URL, INTEGRATION_KEY)" });
    return res.json({ ok: true, ignored: "stockroom_not_configured" });
  }

  try {
    const order = await square.getOrder(payment.order_id);
    if (!order) throw new Error("Square has no order " + payment.order_id);
    const map = variationMap();
    const lines = [];
    for (const li of order.line_items || []) {
      const hit = map[li.catalog_object_id];
      const qty = Math.round(Number(li.quantity) || 0);
      if (!hit || qty <= 0) { lines.push({ name: li.name, result: hit ? "no quantity" : "not a catalog item" }); continue; }
      try {
        const out = await stockroom.recordMovement({
          slug: hit.slug, variant: hit.variant, delta: -qty, reason: "sale",
          ref: "Square order " + order.id,
          // one key per line of the order: Square resends events and an order can
          // have several payments, but each line comes off the shelf once
          idempotencyKey: "square:" + order.id + ":" + (li.uid || li.catalog_object_id)
        });
        lines.push({ name: li.name, slug: hit.slug, variant: hit.variant, qty, result: out.duplicate ? "already counted" : "now " + out.qty + " on hand" });
      } catch (e) {
        if (e.code === "not_linked") { lines.push({ name: li.name, slug: hit.slug, variant: hit.variant, qty, result: "not linked in Stockroom" }); continue; }
        throw e; // Stockroom down or erroring: let Square retry the whole delivery
      }
    }
    remember({ order: order.id, lines });
    res.json({ ok: true, lines: lines.length });
  } catch (e) {
    console.error("[square webhook]", e.message);
    remember({ order: payment.order_id, result: "will retry: " + e.message });
    res.status(500).json({ error: "retry" });
  }
});

module.exports = router;
module.exports.recent = recent;
