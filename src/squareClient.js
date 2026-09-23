"use strict";
// Pushes designs to Square as catalog ITEMs with one ITEM_VARIATION and a photo.
// Needs a token with ITEMS_READ + ITEMS_WRITE (+ MERCHANT_PROFILE_READ for the connection test).
const crypto = require("crypto");

const VERSION = process.env.SQUARE_VERSION || "2025-01-23";
function base() {
  if (process.env.SQUARE_API_BASE) return process.env.SQUARE_API_BASE; // for testing
  return process.env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}
function configured() { return !!process.env.SQUARE_ACCESS_TOKEN; }
function authHeaders() {
  if (!configured()) throw new Error("SQUARE_ACCESS_TOKEN is not set");
  return { Authorization: "Bearer " + process.env.SQUARE_ACCESS_TOKEN, "Square-Version": VERSION };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, path, body, attempt = 0) {
  const res = await fetch(base() + path, {
    method,
    headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && attempt < 4) { await sleep(1500 * (attempt + 1)); return call(method, path, body, attempt + 1); }
  const json = await res.json().catch(() => ({}));
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

async function uploadImage(itemId, imageUrl, name) {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error("couldn't download design image (" + img.status + ")");
  const type = img.headers.get("content-type") || "image/jpeg";
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
  const buf = Buffer.from(await img.arrayBuffer());

  const form = new FormData();
  // metadata must be a plain string field; only the photo is a file part
  form.append("request", JSON.stringify({
    idempotency_key: crypto.randomUUID(),
    object_id: itemId,
    is_primary: true,
    image: { type: "IMAGE", id: "#img", image_data: { name: name.slice(0, 250) } }
  }));
  form.append("file", new Blob([buf], { type }), "design." + ext);

  const res = await fetch(base() + "/v2/catalog/images", { method: "POST", headers: authHeaders(), body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("image upload: " + ((json.errors && json.errors.map(x => x.detail).join("; ")) || res.status));
  return json.image && json.image.id;
}

/**
 * Create or update one design in Square.
 * Returns fields to store on the design: { square_item_id, square_variation_id, square_image_src, square_pushed_at }.
 */
async function pushDesign(d, priceCents, { currency = "USD", overwritePrice = true } = {}) {
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
  const out = {
    square_item_id: saved.id,
    square_variation_id: (saved.item_data.variations || [])[0] && saved.item_data.variations[0].id,
    square_pushed_at: new Date().toISOString(),
    square_error: null
  };

  // only re-upload the photo when it's new or N3D changed it
  const needsImage = d.image_url && (!existing || d.square_image_src !== d.image_url);
  if (needsImage) {
    await uploadImage(saved.id, d.image_url, name);
    out.square_image_src = d.image_url;
  }
  return out;
}

module.exports = { configured, testConnection, pushDesign, describe };
