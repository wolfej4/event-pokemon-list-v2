"use strict";
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { unitCents, fmt } = require("../pricing");
const { buildQuotePdf } = require("../pdf");
const logo = require("../logo");
const sprites = require("../sprites");
const evolutions = require("../evolutions");

const router = express.Router();

// The design's evolution family, trimmed to the Pokémon this catalog has a
// design for: [{ slug, to: [...] }]. A stage with no design is skipped and its
// evolutions move up a level. null when no other family member is listed.
function familyFor(d, have) {
  const dex = d.pokemon && d.pokemon.pokedex_number;
  const tree = dex && evolutions.familyOf(dex);
  if (!tree) return null;
  const prune = (node) => {
    const kids = node.to.flatMap(prune);
    return have[node.dex] ? [{ slug: have[node.dex], to: kids }] : kids;
  };
  const forest = prune(tree);
  let count = 0;
  const walk = (n) => { count++; n.to.forEach(walk); };
  forest.forEach(walk);
  return count > 1 ? forest : null;
}

function toPublic(d, s, have) {
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
    // our cached copy, or N3D's public sprite link until the cache catches up
    sprite: sprites.urlFor(d) || d.sprite_url || null,
    family: have ? familyFor(d, have) : null,
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
  const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", undefined, { numeric: true });
  const visible = db.allDesigns().filter(d => d.visible !== false).sort(byTitle);
  // Pokédex number -> the design that stands for it (character designs first)
  const have = {};
  for (const d of visible.slice().sort((a, b) => (a.category === "character" ? 0 : 1) - (b.category === "character" ? 0 : 1))) {
    const n = d.pokemon && d.pokemon.pokedex_number;
    if (n && !have[n]) have[n] = d.slug;
  }
  const list = visible.map(d => toPublic(d, s, have));
  res.json({ data: list });
});

// the order's secret token (from the link in its email) unlocks its PDF
function orderFor(req) {
  const q = db.getQuote(req.params.id);
  const t = String(req.query.t || "");
  if (!q || t.length !== q.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(q.token))) return null;
  return q;
}

router.get("/quotes/:id/pdf", async (req, res) => {
  const q = orderFor(req);
  if (!q) return res.status(404).send("Not found");
  const pdf = await buildQuotePdf(q, db.getSettings());
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="order-${q.id}.pdf"`);
  res.send(pdf);
});

module.exports = router;
