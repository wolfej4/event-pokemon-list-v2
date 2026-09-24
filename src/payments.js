"use strict";
// Square payment links for quotes, shared by the public and admin routes.
const db = require("./db");
const square = require("./squareClient");

const enabled = () => square.configured() && !!db.getSettings().squarePaymentLinks;

// Creates the link and saves it on the quote. Never throws: a Square problem
// is recorded on the quote so the request itself still goes through.
async function attachLink(quote, req) {
  const s = db.getSettings();
  let payment;
  try {
    payment = await square.createPaymentLink(quote, {
      currency: s.currency || "USD",
      locationId: s.squareLocationId,
      redirectUrl: `${req.protocol}://${req.get("host")}/?paid=${encodeURIComponent(quote.id)}`
    });
  } catch (e) {
    console.error("[square] payment link failed for", quote.id + ":", e.message);
    payment = { error: e.message };
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

module.exports = { enabled, attachLink, refreshStatuses };
