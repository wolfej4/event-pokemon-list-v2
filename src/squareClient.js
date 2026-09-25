"use strict";
// Pushes designs to Square as catalog ITEMs with one ITEM_VARIATION and a photo.
// Needs a token with ITEMS_READ + ITEMS_WRITE (+ MERCHANT_PROFILE_READ for the connection test).
const crypto = require("crypto");
const sharp = require("sharp");

const VERSION = process.env.SQUARE_VERSION || "2025-01-23";
// SQUARE_ENVIRONMENT is what the Unraid compose file sets
const isSandbox = () => String(process.env.SQUARE_ENV || process.env.SQUARE_ENVIRONMENT || "").toLowerCase() === "sandbox";
function base() {
  if (process.env.SQUARE_API_BASE) return process.env.SQUARE_API_BASE; // for testing
  return isSandbox() ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}
function configured() { return !!process.env.SQUARE_ACCESS_TOKEN; }
function authHeaders() {
  if (!configured()) throw new Error("SQUARE_ACCESS_TOKEN is not set");
  return { Authorization: "Bearer " + process.env.SQUARE_ACCESS_TOKEN, "Square-Version": VERSION };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const envName = () => (isSandbox() ? "sandbox" : "production");

// Square answers a token from the other environment with a bare "could not be
// authorized", so say what to check instead.
function authError() {
  const e = new Error(isSandbox()
    ? "Square rejected the access token. The app is in sandbox mode (SQUARE_ENV / SQUARE_ENVIRONMENT = sandbox), which needs the Sandbox access token from the Square Developer Console, not your production one. Update SQUARE_ACCESS_TOKEN or switch the environment back, then redeploy."
    : "Square rejected the access token. The app is in production mode, which needs your Production access token from the Square Developer Console (not the Sandbox one). Check SQUARE_ACCESS_TOKEN, then redeploy.");
  e.status = 401;
  return e;
}

async function call(method, path, body, attempt = 0) {
  const res = await fetch(base() + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && attempt < 4) { await sleep(1500 * (attempt + 1)); return call(method, path, body, attempt + 1); }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw authError();
  if (!res.ok) {
    const e = new Error((json.errors && json.errors.map(x => x.detail || x.code).join("; ")) || ("Square error " + res.status));
    e.status = res.status;
    throw e;
  }
  return json;
}

async function testConnection() {
  const j = await call("GET", "/v2/locations");
  return (j.locations || []).map(l => ({ id: l.id, name: l.name, status: l.status, currency: l.currency }));
}

function describe(d) {
  const parts = [];
  if (d.pokemon) {
    const p = d.pokemon;
    const head = [p.name, p.pokedex_number ? "#" + p.pokedex_number : null].filter(Boolean).join(" ");
    const types = (p.types || []).join(" / ");
    parts.push(types ? `${head} (${types})` : head);
    if (p.description) parts.push(p.description);
  }
  const specs = [];
  if (d.print_time) specs.push("Print time: " + d.print_time);
  if (d.total_weight_grams) specs.push("Weight: " + Math.round(d.total_weight_grams) + " g");
  if (d.filaments && d.filaments.length) specs.push("Colors: " + d.filaments.map(f => f.color).filter(Boolean).join(", "));
  if (specs.length) parts.push(specs.join(" | "));
  parts.push("3D printed to order.");
  return parts.join("\n\n").slice(0, 4000);
}

function setPrice(varData, cents, currency) {
  if (cents > 0) {
    varData.pricing_type = "FIXED_PRICING";
    varData.price_money = { amount: cents, currency };
  } else {
    // no price yet — Square will ask for one at checkout
    varData.pricing_type = "VARIABLE_PRICING";
    delete varData.price_money;
  }
}

// Square only takes JPEG, PNG or GIF (max 15 MB), and N3D images can be
// WebP/AVIF, so every photo is converted to a JPEG on a white background.
async function toSquareJpeg(buf, contentType) {
  try {
    return await sharp(buf, { failOn: "none" })
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    throw new Error("couldn't read the design image (" + (contentType || "unknown type") + "): " + e.message);
  }
}

async function uploadImage(itemId, imageUrl, name) {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error("couldn't download the design image from N3D (HTTP " + img.status + ")");
  const jpeg = await toSquareJpeg(Buffer.from(await img.arrayBuffer()), img.headers.get("content-type"));

  const form = new FormData();
  // Square's multipart parts are "request" (JSON string) and "image_file"
  form.append("request", JSON.stringify({
    idempotency_key: crypto.randomUUID(),
    object_id: itemId,
    is_primary: true,
    image: { type: "IMAGE", id: "#img", image_data: { name: name.slice(0, 250) } }
  }));
  form.append("image_file", new Blob([jpeg], { type: "image/jpeg" }), "design.jpg");

  const res = await fetch(base() + "/v2/catalog/images", { method: "POST", headers: authHeaders(), body: form });
  if (res.status === 401) throw authError();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Square rejected the photo: " + ((json.errors && json.errors.map(x => x.detail || x.code).join("; ")) || res.status));
  const imageId = json.image && json.image.id;
  if (!imageId) throw new Error("Square didn't return the uploaded photo");

  // make sure it actually ended up on the item
  const item = (await call("GET", "/v2/catalog/object/" + encodeURIComponent(itemId))).object;
  const ids = (item && item.item_data && item.item_data.image_ids) || [];
  if (!ids.includes(imageId)) throw new Error("Square accepted the photo but didn't attach it to the item");
  return imageId;
}

/**
 * Create or update one design's item in Square (without the photo; see uploadImage).
 * Returns { square_item_id, square_variation_id, square_pushed_at, created }.
 */
async function upsertItem(d, priceCents, { currency = "USD", overwritePrice = true } = {}) {
  const name = String(d.title || d.slug).slice(0, 255);
  let existing = null;

  if (d.square_item_id) {
    try {
      existing = (await call("GET", "/v2/catalog/object/" + encodeURIComponent(d.square_item_id))).object;
      if (existing && existing.is_deleted) existing = null;
    } catch (e) {
      if (e.status !== 404) throw e; // deleted in Square — recreate below
    }
  }

  let object;
  if (existing) {
    object = existing; // carries version numbers Square needs for an update
    object.item_data.name = name;
    object.item_data.description = describe(d);
    delete object.item_data.description_html;
    delete object.item_data.description_plaintext;
    const vars = object.item_data.variations || [];
    if (!vars.length) {
      vars.push({ type: "ITEM_VARIATION", id: "#var", item_variation_data: { item_id: object.id, name: "Regular" } });
      setPrice(vars[0].item_variation_data, priceCents, currency);
    } else if (overwritePrice) {
      setPrice(vars[0].item_variation_data, priceCents, currency);
    }
    object.item_data.variations = vars;
  } else {
    const varData = { item_id: "#item", name: "Regular" };
    setPrice(varData, priceCents, currency);
    object = {
      type: "ITEM",
      id: "#item",
      present_at_all_locations: true,
      item_data: {
        name,
        description: describe(d),
        variations: [{ type: "ITEM_VARIATION", id: "#var", present_at_all_locations: true, item_variation_data: varData }]
      }
    };
  }

  const res = await call("POST", "/v2/catalog/object", { idempotency_key: crypto.randomUUID(), object });
  const saved = res.catalog_object;
  return {
    square_item_id: saved.id,
    square_variation_id: (saved.item_data.variations || [])[0] && saved.item_data.variations[0].id,
    square_pushed_at: new Date().toISOString(),
    created: !existing
  };
}

// Items this app created (its descriptions end with "3D printed to order."), for duplicate cleanup.
async function listAppItems() {
  const out = [];
  let cursor = null;
  do {
    const j = await call("GET", "/v2/catalog/list?types=ITEM" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    for (const o of j.objects || []) {
      const desc = (o.item_data && (o.item_data.description || o.item_data.description_plaintext)) || "";
      if (!o.is_deleted && /3D printed to order\.\s*$/.test(desc)) out.push({ id: o.id, name: o.item_data.name, updated_at: o.updated_at });
    }
    cursor = j.cursor;
  } while (cursor);
  return out;
}
async function deleteItems(ids) {
  for (let i = 0; i < ids.length; i += 200) await call("POST", "/v2/catalog/batch-delete", { object_ids: ids.slice(i, i + 200) });
}

module.exports = { envName, isSandbox, configured, testConnection, upsertItem, uploadImage, listAppItems, deleteItems, describe };
