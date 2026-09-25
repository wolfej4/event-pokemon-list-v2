"use strict";
const nodemailer = require("nodemailer");
const { fmt } = require("./pricing");

const db = require("./db");

// SMTP settings saved in the admin panel win; otherwise fall back to the
// SMTP_* environment variables.
function envConfig() {
  const e = process.env;
  let from = e.SMTP_FROM || "";
  if (!from && e.SMTP_FROM_EMAIL) from = e.SMTP_FROM_NAME ? `"${e.SMTP_FROM_NAME.replace(/"/g, "")}" <${e.SMTP_FROM_EMAIL}>` : e.SMTP_FROM_EMAIL;
  return {
    host: e.SMTP_HOST || "", port: Number(e.SMTP_PORT) || 587,
    secure: e.SMTP_SECURE === "true" ? true : e.SMTP_SECURE === "false" ? false : null,
    user: e.SMTP_USER || "", pass: e.SMTP_PASS || "", from
  };
}
function config() {
  const s = db.getSettings().smtp;
  if (s && s.host) return Object.assign({ source: "app" }, s);
  return Object.assign({ source: "env" }, envConfig());
}
function configured() { const c = config(); return !!(c.host && c.from); }

let transporter = null, transporterKey = "";
function getTransport() {
  const c = config();
  if (!c.host || !c.from) return null;
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (!transporter || key !== transporterKey) {
    const port = Number(c.port) || 587;
    transporter = nodemailer.createTransport({
      host: c.host,
      port,
      secure: typeof c.secure === "boolean" ? c.secure : port === 465,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined
    });
    transporterKey = key;
  }
  return transporter;
}

function itemLines(q, cur) {
  const lines = q.items.map(i => `  ${i.qty} × ${i.title} — ${fmt(i.unit_cents * i.qty, cur)}`);
  if (q.fulfillment === "ship") lines.push(`  Shipping — ${fmt(q.shipping_cents, cur)}`);
  if (q.fulfillment === "pickup") lines.push("  Local pickup — free");
  return lines.join("\n");
}

// Sends the customer copy and the business copy. Returns {customer, business} status strings.
async function sendQuoteEmails(q, pdf, settings) {
  const t = getTransport();
  if (!t) return { customer: "skipped: SMTP not configured", business: "skipped: SMTP not configured" };
  const cur = settings.currency || "USD";
  const shop = settings.businessName || "Our shop";
  const attachment = { filename: `order-${q.id}.pdf`, content: pdf, contentType: "application/pdf" };
  const result = {};

  try {
    await t.sendMail({
      from: config().from,
      to: q.customer.email,
      replyTo: settings.businessEmail || undefined,
      subject: `Your order ${q.id} from ${shop}`,
      text: `Hi ${q.customer.name},\n\nThanks for your order! A summary is attached.\n\n${itemLines(q, cur)}\n\nTotal: ${fmt(q.total_cents, cur)}\n\n${q.fulfillment === "pickup" ? "We'll email you when it's ready for pickup." : "We'll email you when it ships."} Reply to this email with any questions.\n\n${shop}`,
      attachments: [attachment]
    });
    result.customer = "sent";
  } catch (e) { result.customer = "failed: " + e.message; }

  if (settings.businessEmail) {
    try {
      await t.sendMail({
        from: config().from,
        to: settings.businessEmail,
        replyTo: q.customer.email,
        subject: `New order ${q.id} — ${q.customer.name} (${fmt(q.total_cents, cur)})`,
        text: `New order.\n\nName: ${q.customer.name}\nEmail: ${q.customer.email}\nPhone: ${q.customer.phone || "—"}\nSource: ${q.source}\nDelivery: ${q.fulfillment === "ship" ? "ship" : q.fulfillment === "pickup" ? "local pickup" : "—"}\n\n${itemLines(q, cur)}\n\nTotal: ${fmt(q.total_cents, cur)}\n\nNotes:\n${q.customer.notes || "—"}`,
        attachments: [attachment]
      });
      result.business = "sent";
    } catch (e) { result.business = "failed: " + e.message; }
  } else {
    result.business = "skipped: no business email set in admin";
  }
  return result;
}

async function verify() {
  const t = getTransport();
  if (!t) throw new Error("Email isn't set up. Enter a mail server and From address in Settings.");
  await t.verify();
  return true;
}

module.exports = { sendQuoteEmails, verify, configured, config };
