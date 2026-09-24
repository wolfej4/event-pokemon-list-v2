"use strict";
// Square payment links for quotes, shared by the public and admin routes.
const db = require("./db");
const square = require("./squareClient");

const enabled = () => square.configured() && !!db.getSettings().squarePaymentLinks;
let lastError = null; // { message, at, id } from the most recent failed link

// Square sends the customer back here after paying. Only offered over HTTPS,
// since a plain-http LAN address is useless to a phone outside the network.
function redirectUrl(req, id) {
  if (req.protocol !== "https") return undefined;
  return `https://${req.get("host")}/?paid=${encodeURIComponent(id)}`;
}

// Why customers can't pay right now, or null if they can.
function problem() {
  if (!square.configured()) return "SQUARE_ACCESS_TOKEN isn't set, so checkout can't take payment. Add it to the stack's environment variables and redeploy.";
  if (!db.getSettings().squarePaymentLinks) return "\u201cTake payment at checkout\u201d is turned off on the Square tab, so orders are saved without a way to pay.";
  if (lastError) return "Square refused the last payment link (order " + lastError.id + "): " + lastError.message;
  return null;
}

// Makes a $1 link and deletes it again, to check the token and account can take online payments.
async function testLink(req) {
  const s = db.getSettings();
  const link = await square.createPaymentLink({
    id: "TEST-" + Date.now(), fulfillment: "pickup", shipping_cents: 0, customer: {},
    items: [{ title: "Payment link test", qty: 1, unit_cents: 100 }]
  }, { currency: s.currency || "USD", locationId: s.squareLocationId, redirectUrl: redirectUrl(req, "TEST") });
  try { await square.deletePaymentLink(link.link_id); } catch (e) { /* harmless leftover test link */ }
  lastError = null;
  return link;
}

// Creates the link and saves it on the quote. Never throws: a Square problem
// is recorded on the quote so the request itself still goes through.
async function attachLink(quote, req) {
  const s = db.getSettings();
  let payment;
  try {
    payment = await square.createPaymentLink(quote, {
      currency: s.currency || "USD",
      locationId: s.squareLocationId,
      redirectUrl: redirectUrl(req, quote.id)
    });
    lastError = null;
  } catch (e) {
    console.error("[square] payment link failed for", quote.id + ":", e.message);
    payment = { error: e.message };
    lastError = { message: e.message, id: quote.id, at: new Date().toISOString() };
  }
  return db.updateQuote(quote.id, { payment });
}

// Asks Square which unpaid links have been paid and records it.
async function refreshStatuses(quotes) {
  const open = quotes.filter(q => q.payment && q.payment.order_id && q.payment.status !== "paid");
  const byLocation = {};
  for (const q of open) (byLocation[q.payment.location_id] = byLocation[q.payment.location_id] || []).push(q);
  for (const [loc, list] of Object.entries(byLocation)) {
    const st = await square.paymentStatuses(loc, list.map(q => q.payment.order_id));
    for (const q of list) {
      const r = st[q.payment.order_id];
      if (r && r.paid) db.updateQuote(q.id, { payment: Object.assign({}, q.payment, { status: "paid", paid_at: new Date().toISOString(), ship_to: r.ship_to }) });
    }
  }
}

module.exports = { enabled, attachLink, refreshStatuses, problem, testLink };
