"use strict";
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { unitCents, fmt } = require("../pricing");
const { buildQuotePdf } = require("../pdf");
const QRCode = require("qrcode");
const payments = require("../payments");
const mailer = require("../mailer");
const rateLimit = require("../rateLimit");
const logo = require("../logo");

const router = express.Router();

function toPublic(d, s) {
  const cents = unitCents(d, s.pricing);
  return {
    slug: d.slug,
    title: d.title,
    category: d.category,
    image_url: d.image_url,
    print_time: d.print_time,
    total_weight_grams: d.total_weight_grams,
    is_extra: !!d.purchase_only,
    price_cents: cents,
    price: fmt(cents, s.currency),
    price_is_estimate: d.price_cents == null,
    shop_url: d.shop_url || null,
    pokemon: d.pokemon ? {
      name: d.pokemon.name, pokedex_number: d.pokemon.pokedex_number,
      types: d.pokemon.types, description: d.pokemon.description
    } : null,
    filaments: (d.filaments || []).map(f => ({ color: f.color, series: f.series, hex_color: f.hex_color, weight_grams: f.weight_grams }))
  };
}

router.get("/settings", (req, res) => {
  const s = db.getSettings();
  res.json({
    businessName: s.businessName, tagline: s.tagline, currency: s.currency,
    kioskIdleSeconds: s.kioskIdleSeconds,
    shippingCents: Math.round((Number(s.pricing.shipping) || 0) * 100),
    payOnline: payments.enabled(),
    logo: logo.urls(s),
    logoShowName: s.logoShowName !== false
  });
});

router.get("/logo/:variant", (req, res) => {
  const f = logo.read(db.getSettings(), req.params.variant) ||
            logo.read(db.getSettings(), req.params.variant === "dark" ? "light" : "dark");
  if (!f) return res.status(404).end();
  res.setHeader("Content-Type", f.type);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // URLs carry ?v=
  // an SVG opened directly can't run scripts
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.send(f.buf);
});

router.get("/designs", (req, res) => {
  const s = db.getSettings();
  const list = db.allDesigns().filter(d => d.visible !== false).map(d => toPublic(d, s))
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { numeric: true }));
  res.json({ data: list });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (v, n) => String(v || "").trim().slice(0, n);

// generous limit: everyone on the venue wifi (and the kiosk) shares one IP
router.post("/quotes", rateLimit({ windowMs: 10 * 60 * 1000, max: 40 }), async (req, res) => {
  const body = req.body || {};
  if (body.website) return res.json({ ok: true }); // honeypot: bots fill hidden fields

  const customer = {
    name: clip(body.name, 120),
    email: clip(body.email, 200),
    phone: clip(body.phone, 40),
    notes: clip(body.notes, 2000)
  };
  if (!customer.name) return res.status(400).json({ error: "Enter your name." });
  if (!EMAIL_RE.test(customer.email)) return res.status(400).json({ error: "Enter a valid email address." });
  const fulfillment = body.fulfillment === "ship" ? "ship" : body.fulfillment === "pickup" ? "pickup" : null;
  if (!fulfillment) return res.status(400).json({ error: "Choose shipping or local pickup." });

  const s = db.getSettings();
  const items = [];
  for (const raw of Array.isArray(body.items) ? body.items.slice(0, 100) : []) {
    const d = db.getDesign(String(raw.slug || ""));
    const qty = Math.min(999, Math.max(1, parseInt(raw.qty, 10) || 1));
    if (!d || d.visible === false) continue;
    items.push({
      slug: d.slug, title: d.title, qty,
      unit_cents: unitCents(d, s.pricing), // priced server-side; client totals are display only
      weight_grams: d.total_weight_grams || null,
      estimate: d.price_cents == null
    });
  }
  if (!items.length) return res.status(400).json({ error: "Your cart is empty." });

  const subtotal = items.reduce((sum, i) => sum + i.unit_cents * i.qty, 0);
  const shipping = fulfillment === "ship" ? Math.round((Number(s.pricing.shipping) || 0) * 100) : 0;
  const now = new Date();
  const id = "O-" + now.toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
  const quote = db.addQuote({
    id,
    token: crypto.randomBytes(16).toString("hex"),
    created_at: now.toISOString(),
    source: body.kiosk ? "kiosk" : "web",
    customer, items, fulfillment,
    subtotal_cents: subtotal,
    shipping_cents: shipping,
    total_cents: subtotal + shipping,
    status: "new",
    email: null
  });

  if (payments.enabled()) await payments.attachLink(quote, req); // updates quote in place
  const payUrl = quote.payment && quote.payment.url || null;

  let pdf;
  try { pdf = await buildQuotePdf(quote, s); }
  catch (e) {
    console.error("[order] pdf failed:", e);
    return res.status(500).json({ error: "Your order was saved, but something went wrong on our end. We'll follow up by email." });
  }

  const email = await mailer.sendQuoteEmails(quote, pdf, s);
  db.updateQuote(id, { email });

  res.json({
    ok: true,
    id,
    total: fmt(quote.total_cents, s.currency),
    emailed: email.customer === "sent",
    pdf_url: `/api/public/quotes/${id}/pdf?t=${quote.token}`,
    pay_url: payUrl,
    // an SVG QR code for the booth tablet, so customers pay on their own phone
    pay_qr: payUrl && body.kiosk ? await QRCode.toString(payUrl, { type: "svg", margin: 1 }) : null
  });
});

// the order's secret token (from the checkout redirect or PDF link) unlocks its details
function orderFor(req) {
  const q = db.getQuote(req.params.id);
  const t = String(req.query.t || "");
  if (!q || t.length !== q.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(q.token))) return null;
  return q;
}

// Order confirmation page data. Asks Square for the payment status first,
// since the customer usually arrives here straight from paying.
router.get("/orders/:id", async (req, res) => {
  const q = orderFor(req);
  if (!q) return res.status(404).json({ error: "not_found" });
  if (q.payment && q.payment.order_id && q.payment.status !== "paid") {
    try { await payments.refreshStatuses([q]); } catch (e) { /* show the last known status */ }
  }
  const s = db.getSettings(), cur = s.currency;
  const p = q.payment || {};
  res.json({
    id: q.id,
    created_at: q.created_at,
    name: q.customer.name,
    email: q.customer.email,
    fulfillment: q.fulfillment || null,
    items: q.items.map(i => ({ title: i.title, qty: i.qty, total: fmt(i.unit_cents * i.qty, cur) })),
    subtotal: q.subtotal_cents != null ? fmt(q.subtotal_cents, cur) : null,
    shipping: q.shipping_cents ? fmt(q.shipping_cents, cur) : null,
    total: fmt(q.total_cents, cur),
    paid: p.status === "paid",
    pay_url: p.status !== "paid" && p.url ? p.url : null,
    ship_to: p.status === "paid" ? p.ship_to || null : null,
    business_email: s.businessEmail || null,
    pdf_url: `/api/public/quotes/${q.id}/pdf?t=${q.token}`
  });
});

router.get("/quotes/:id/pdf", async (req, res) => {
  const q = orderFor(req);
  if (!q) return res.status(404).send("Not found");
  const pdf = await buildQuotePdf(q, db.getSettings());
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="order-${q.id}.pdf"`);
  res.send(pdf);
});

module.exports = router;
