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

// ---------- categories ----------
async function listCategories() {
  const map = {};
  let cursor = null;
  do {
    const j = await call("GET", "/v2/catalog/list?types=CATEGORY" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    for (const o of j.objects || []) if (!o.is_deleted && o.category_data && o.category_data.name) map[o.category_data.name] = o.id;
    cursor = j.cursor;
  } while (cursor);
  return map;
}

// Creates whichever of these category names Square doesn't already have
// (checked by name against the real catalog first, so re-running never makes
// a duplicate), and returns name -> id for all of them. category_type must be
// REGULAR_CATEGORY for an item to carry more than one category.
async function ensureCategories(names) {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return {};
  const existing = await listCategories();
  const missing = unique.filter(n => !existing[n]);
  if (missing.length) {
    const objects = missing.map((name, i) => ({
      type: "CATEGORY", id: "#cat" + i,
      category_data: { name: name.slice(0, 255), category_type: "REGULAR_CATEGORY" }
    }));
    const res = await call("POST", "/v2/catalog/batch-upsert", { idempotency_key: crypto.randomUUID(), batches: [{ objects }] });
    for (const obj of res.objects || []) {
      if (obj.category_data && obj.category_data.name) existing[obj.category_data.name] = obj.id;
    }
  }
  const out = {};
  unique.forEach(n => { if (existing[n]) out[n] = existing[n]; });
  return out;
}

// ---------- custom attributes (Pokédex #, weight) ----------
const ATTR_DEFS = [
  { key: "pokedex_number", name: "Pokédex #", numberConfig: { precision: 0 } },
  { key: "weight_grams", name: "Weight (g)", numberConfig: { precision: 1 } }
];
// Creates the two custom attribute definitions this app uses to show
// Pokédex number and weight as their own fields in Square (not just in the
// description), checked by key against Square's real list first.
// Returns { pokedex_number: {id, key}, weight_grams: {id, key} }.
async function ensureCustomAttributeDefinitions() {
  const j = await call("GET", "/v2/catalog/list?types=CUSTOM_ATTRIBUTE_DEFINITION");
  const existing = {};
  for (const o of j.objects || []) {
    const k = o.custom_attribute_definition_data && o.custom_attribute_definition_data.key;
    if (!o.is_deleted && k) existing[k] = o.id;
  }
  const out = {};
  for (const def of ATTR_DEFS) {
    let id = existing[def.key];
    if (!id) {
      const res = await call("POST", "/v2/catalog/object", {
        idempotency_key: crypto.randomUUID(),
        object: {
          type: "CUSTOM_ATTRIBUTE_DEFINITION", id: "#cad_" + def.key,
          custom_attribute_definition_data: {
            type: "NUMBER", name: def.name, key: def.key,
            allowed_object_types: ["ITEM"],
            seller_visibility: "SELLER_VISIBILITY_READ_WRITE_VALUES",
            number_config: def.numberConfig
          }
        }
      });
      id = res.catalog_object.id;
    }
    out[def.key] = { id, key: def.key };
  }
  return out;
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
 * Create or update one design's item in Square (without the photo; see
 * uploadImage). `opts.categories`/`reportingCategory` come from
 * squareCatalog.categoriesFieldsFor; `customAttributeValues` from
 * squareCatalog.customAttributesFor. `shinyPriceCents` adds/updates a
 * second "Shiny" variation (null removes it, e.g. a design that no longer
 * depicts a Pokémon). `sku` goes on the Regular variation (and "<sku>-SHINY"
 * on Shiny); falsy clears it.
 * Returns { square_item_id, square_variation_id, square_variation_id_shiny,
 * square_pushed_at, created }.
 */
async function upsertItem(d, priceCents, opts = {}) {
  const {
    currency = "USD", overwritePrice = true, categories, reportingCategory,
    customAttributeValues, shinyPriceCents = null, sku = null
  } = opts;
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
  } else {
    object = {
      type: "ITEM", id: "#item", present_at_all_locations: true,
      item_data: { name, description: describe(d), variations: [] }
    };
  }
  object.item_data.categories = categories || [];
  if (reportingCategory) object.item_data.reporting_category = reportingCategory;
  else delete object.item_data.reporting_category;
  object.custom_attribute_values = customAttributeValues || {};

  const itemRef = existing ? object.id : "#item"; // new variations need the real item id once one exists
  const isShiny = (v) => /shiny/i.test((v.item_variation_data || {}).name || "");
  const vars = object.item_data.variations || [];

  let reg = vars.find(v => !isShiny(v));
  const regIsNew = !reg;
  if (regIsNew) {
    reg = { type: "ITEM_VARIATION", id: "#var", present_at_all_locations: true, item_variation_data: { item_id: itemRef, name: "Regular" } };
    vars.unshift(reg);
  }
  if (regIsNew || overwritePrice) setPrice(reg.item_variation_data, priceCents, currency);
  if (sku) reg.item_variation_data.sku = sku; else delete reg.item_variation_data.sku;

  let shiny = vars.find(isShiny);
  if (shinyPriceCents != null) {
    const shinyIsNew = !shiny;
    if (shinyIsNew) {
      shiny = { type: "ITEM_VARIATION", id: "#varshiny", present_at_all_locations: true, item_variation_data: { item_id: itemRef, name: "Shiny" } };
      vars.push(shiny);
    }
    if (shinyIsNew || overwritePrice) setPrice(shiny.item_variation_data, shinyPriceCents, currency);
    if (sku) shiny.item_variation_data.sku = sku + "-SHINY"; else delete shiny.item_variation_data.sku;
  } else if (shiny) {
    vars.splice(vars.indexOf(shiny), 1); // no longer offered (e.g. design isn't a Pokémon anymore)
  }
  object.item_data.variations = vars;

  const res = await call("POST", "/v2/catalog/object", { idempotency_key: crypto.randomUUID(), object });
  const saved = res.catalog_object;
  const savedVars = saved.item_data.variations || [];
  const savedReg = savedVars.find(v => !isShiny(v)) || savedVars[0];
  const savedShiny = savedVars.find(isShiny);
  return {
    square_item_id: saved.id,
    square_variation_id: savedReg && savedReg.id,
    square_variation_id_shiny: savedShiny ? savedShiny.id : null,
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

module.exports = {
  envName, isSandbox, configured, testConnection, upsertItem, uploadImage, listAppItems, deleteItems, describe,
  listCategories, ensureCategories, ensureCustomAttributeDefinitions
};
