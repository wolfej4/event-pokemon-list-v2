"use strict";
// Local copies of N3D's pixel-art sprites (character designs only). N3D asks
// integrations to cache them rather than hotlink, and it keeps the storefront
// fast on event wifi. A sprite is re-downloaded only when its revision changes.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const db = require("./db");

// bump when the processing below changes, so cached copies are redone
const PROCESS = "t2";
const DIR = () => path.join(db.DATA_DIR, "sprites");
const safeName = (slug) => String(slug).replace(/[^a-z0-9_-]/gi, "_").slice(0, 120);
const fileFor = (slug) => path.join(DIR(), safeName(slug) + ".webp");

const cacheKey = (d) => (d.sprite_revision || "1") + "." + PROCESS;

// Public URL of the cached copy, or null. The revision in the query string
// lets browsers cache the image forever and still pick up a redraw.
function urlFor(d) {
  if (!d.sprite_cached_rev || !fs.existsSync(fileFor(d.slug))) return null;
  return "/sprites/" + encodeURIComponent(safeName(d.slug)) + ".webp?v=" + encodeURIComponent(d.sprite_cached_rev);
}

async function fetchOne(d) {
  const res = await fetch(d.sprite_url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  // Trim empty transparent margins so the artwork fills its slot, then fit it
  // into a transparent 192px square (display sizes top out around 64px).
  let trimmed = buf;
  try { trimmed = await sharp(buf).trim({ threshold: 1 }).toBuffer(); } catch (e) { /* nothing to trim */ }
  const meta = await sharp(trimmed).metadata();
  const small = Math.max(meta.width || 0, meta.height || 0) < 192;
  const out = await sharp(trimmed).resize(192, 192, {
    fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: small ? "nearest" : "lanczos3" // enlarging pixel art: keep hard pixel edges
  }).webp({ quality: 90, alphaQuality: 100 }).toBuffer();
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(fileFor(d.slug), out);
}

// Downloads every sprite that's new or has a new revision. Returns counts.
async function refresh() {
  const todo = db.allDesigns().filter(d => d.sprite_url &&
    (cacheKey(d) !== d.sprite_cached_rev || !fs.existsSync(fileFor(d.slug))));
  let done = 0, failed = 0;
  const queue = todo.slice();
  async function worker() {
    for (let d = queue.shift(); d; d = queue.shift()) {
      try { await fetchOne(d); db.upsertDesign(d.slug, { sprite_cached_rev: cacheKey(d) }); done++; }
      catch (e) { failed++; console.error("[sprites] " + d.slug + ":", e.message); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { done, failed };
}

module.exports = { refresh, urlFor, fileFor, safeName, DIR };
