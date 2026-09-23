"use strict";
// Price for one unit of a design, in cents.
// A per-design override (price_cents) always wins; otherwise the formula from
// settings.pricing estimates it from filament weight and print time.

function parsePrintHours(t) {
  if (t == null || t === "") return 0;
  if (typeof t === "number") return t / 3600; // seconds
  const s = String(t).trim();
  const hms = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) return Number(hms[1]) + Number(hms[2]) / 60 + Number(hms[3] || 0) / 3600;
  let h = 0;
  const d = s.match(/(\d+(?:\.\d+)?)\s*d/i); if (d) h += Number(d[1]) * 24;
  const hh = s.match(/(\d+(?:\.\d+)?)\s*h/i); if (hh) h += Number(hh[1]);
  const m = s.match(/(\d+(?:\.\d+)?)\s*m/i); if (m) h += Number(m[1]) / 60;
  return h;
}

function formulaCents(d, p) {
  const grams = Number(d.total_weight_grams) || 0;
  const hours = parsePrintHours(d.print_time);
  let dollars = (Number(p.baseFee) || 0) + grams * (Number(p.perGram) || 0) + hours * (Number(p.perHour) || 0);
  dollars *= 1 + (Number(p.markupPct) || 0) / 100;
  dollars = Math.max(dollars, Number(p.minPrice) || 0);
  const r = Number(p.roundTo) || 0;
  if (r > 0) dollars = Math.ceil(dollars / r - 1e-9) * r;
  return Math.round(dollars * 100);
}

function unitCents(d, pricing) {
  if (d.price_cents !== null && d.price_cents !== undefined) return d.price_cents;
  return formulaCents(d, pricing);
}

function fmt(cents, currency = "USD") {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency });
}

module.exports = { parsePrintHours, formulaCents, unitCents, fmt };
