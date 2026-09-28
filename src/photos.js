"use strict";
// Local copies of N3D's design photos. Same idea as sprites.js: hotlinking
// every storefront visitor's browser straight to N3D adds up fast, so each
// photo is downloaded once and re-fetched only when N3D's URL for it changes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const db = require("./db");

// bump when the processing below changes, so cached copies are redone
const PROCESS = "t1";
const DIR = () => path.join(db.DATA_DIR, "photos");
const safeName = (slug) => String(slug).replace(/[^a-z0-9_-]/gi, "_").slice(0, 120);
const fileFor = (slug) => path.join(DIR(), safeName(slug) + ".webp");

// N3D's photos don't carry a revision number the way sprites do, so the
// source URL itself is the cache key: an unchanged URL means an unchanged photo.
const cacheKey = (d) => crypto.createHash("sha1").update(d.image_url + "." + PROCESS).digest("hex").slice(0, 12);

// Public URL of the cached copy, or null. The key in the query string lets
// browsers cache the image forever and still pick up a new photo.
function urlFor(d) {
  if (!d.image_url || !d.photo_cached_key || !fs.existsSync(fileFor(d.slug))) return null;
  return "/photos/" + encodeURIComponent(safeName(d.slug)) + ".webp?v=" + encodeURIComponent(d.photo_cached_key);
}

async function fetchOne(d) {
  const res = await fetch(d.image_url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  // Keep the whole photo (no cropping) at a size well past any on-site display.
  const out = await sharp(buf, { failOn: "none" }).rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 90 }).toBuffer();
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(fileFor(d.slug), out);
}

// Downloads every photo that's new or whose N3D URL changed. Returns counts.
async function refresh() {
  const todo = db.allDesigns().filter(d => d.image_url &&
    (cacheKey(d) !== d.photo_cached_key || !fs.existsSync(fileFor(d.slug))));
  let done = 0, failed = 0;
  const queue = todo.slice();
  async function worker() {
    for (let d = queue.shift(); d; d = queue.shift()) {
      try { await fetchOne(d); db.upsertDesign(d.slug, { photo_cached_key: cacheKey(d) }); done++; }
      catch (e) { failed++; console.error("[photos] " + d.slug + ":", e.message); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { done, failed };
}

module.exports = { refresh, urlFor, fileFor, safeName, DIR };
