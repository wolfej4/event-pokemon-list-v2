"use strict";
// Pushes designs to Square as catalog ITEMs with one ITEM_VARIATION and a photo.
// Needs a token with ITEMS_READ + ITEMS_WRITE (+ MERCHANT_PROFILE_READ for the connection test).
const crypto = require("crypto");

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

// ---------- payment links ----------
// Needs ORDERS_READ + ORDERS_WRITE + PAYMENTS_WRITE (a personal access token has all of them).
async function resolveLocation(preferred) {
  if (preferred) return preferred;
  if (process.env.SQUARE_LOCATION_ID) return process.env.SQUARE_LOCATION_ID;
  const active = (await testConnection()).find(l => l.status === "ACTIVE");
  if (!active) throw new Error("No active Square location found.");
  return active.id;
}

// Creates a Square checkout link for a quote. Prices already include tax, so
// the order carries plain line items with no tax lines.
async function createPaymentLink(quote, { currency, locationId, redirectUrl }) {
  const location_id = await resolveLocation(locationId);
  const ship = quote.fulfillment === "ship";
  const checkout_options = { ask_for_shipping_address: ship };
  if (ship && quote.shipping_cents > 0) checkout_options.shipping_fee = { name: "Shipping", charge: { amount: quote.shipping_cents, currency } };
  if (redirectUrl) checkout_options.redirect_url = redirectUrl;
  const j = await call("POST", "/v2/online-checkout/payment-links", {
    idempotency_key: "quote-" + quote.id,
    description: "Order " + quote.id,
    order: {
      location_id,
      reference_id: quote.id,
      line_items: quote.items.map(i => ({
        name: String(i.title).slice(0, 500),
        quantity: String(i.qty),
        base_price_money: { amount: i.unit_cents, currency }
      }))
    },
    checkout_options,
    pre_populated_data: quote.customer.email ? { buyer_email: quote.customer.email } : undefined
  });
  const l = j.payment_link || {};
  return { url: l.url || l.long_url, link_id: l.id, order_id: l.order_id, location_id, status: "unpaid" };
}

// Looks up the orders behind payment links and reports which are paid,
// plus the shipping address the customer entered at checkout.
async function paymentStatuses(locationId, orderIds) {
  const out = {};
  for (let i = 0; i < orderIds.length; i += 100) {
    const j = await call("POST", "/v2/orders/batch-retrieve", { location_id: locationId, order_ids: orderIds.slice(i, i + 100) });
    for (const o of j.orders || []) {
      const due = o.net_amount_due_money ? o.net_amount_due_money.amount : null;
      const paid = o.state === "COMPLETED" || ((o.tenders || []).length > 0 && due === 0);
      const f = (o.fulfillments || []).find(x => x.shipment_details) || {};
      const r = (f.shipment_details || {}).recipient;
      let ship_to = null;
      if (r) {
        const a = r.address || {};
        ship_to = [r.display_name, a.address_line_1, a.address_line_2,
          [a.locality, a.administrative_district_level_1, a.postal_code].filter(Boolean).join(" "), a.country]
          .filter(Boolean).join("\n");
      }
      out[o.id] = { paid, state: o.state, ship_to };
    }
  }
  return out;
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

// Square only takes JPEG, PNG or GIF (max 15 MB), so check the real format
// from the file's first bytes rather than trusting the content-type header.
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { type: "image/jpeg", ext: "jpg" };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { type: "image/png", ext: "png" };
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString("latin1"))) return { type: "image/gif", ext: "gif" };
  if (buf.length > 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return { unsupported: "WebP" };
  if (buf.length > 12 && /^ftyp(avif|avis)/.test(buf.slice(4, 12).toString("latin1"))) return { unsupported: "AVIF" };
  return { unsupported: "an unrecognized format" };
}

async function uploadImage(itemId, imageUrl, name) {
  // ask image CDNs that negotiate formats for something Square accepts
  const img = await fetch(imageUrl, { headers: { Accept: "image/jpeg,image/png,image/gif;q=0.9,*/*;q=0.1" } });
  if (!img.ok) throw new Error("couldn't download the design image (" + img.status + ")");
  const buf = Buffer.from(await img.arrayBuffer());
  const kind = sniffImage(buf);
  if (kind.unsupported) throw new Error("the design image is " + kind.unsupported + ", and Square only accepts JPEG, PNG or GIF");
  if (buf.length > 15 * 1024 * 1024) throw new Error("the design image is over Square's 15 MB limit");

  const form = new FormData();
  // Square's multipart parts are "request" (JSON string) and "image_file"
  form.append("request", JSON.stringify({
    idempotency_key: crypto.randomUUID(),
    object_id: itemId,
    is_primary: true,
    image: { type: "IMAGE", id: "#img", image_data: { name: name.slice(0, 250) } }
  }));
  form.append("image_file", new Blob([buf], { type: kind.type }), "design." + kind.ext);

  const res = await fetch(base() + "/v2/catalog/images", { method: "POST", headers: authHeaders(), body: form });
  if (res.status === 401) throw authError();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Square rejected the image: " + ((json.errors && json.errors.map(x => x.detail || x.code).join("; ")) || res.status));
  return json.image && json.image.id;
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

async function deletePaymentLink(id) { await call("DELETE", "/v2/online-checkout/payment-links/" + encodeURIComponent(id)); }

module.exports = { envName, createPaymentLink, deletePaymentLink, paymentStatuses, isSandbox, configured, testConnection, upsertItem, uploadImage, listAppItems, deleteItems, describe };
