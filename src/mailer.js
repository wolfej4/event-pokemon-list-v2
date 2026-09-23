"use strict";
const nodemailer = require("nodemailer");
const { fmt } = require("./pricing");

let transporter = null;
function configured() { return !!(process.env.SMTP_HOST && process.env.SMTP_FROM); }
function getTransport() {
  if (!configured()) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

function itemLines(q, cur) {
  return q.items.map(i => `  ${i.qty} × ${i.title} — ${fmt(i.unit_cents * i.qty, cur)}`).join("\n");
}

// Sends the customer copy and the business copy. Returns {customer, business} status strings.
async function sendQuoteEmails(q, pdf, settings) {
  const t = getTransport();
  if (!t) return { customer: "skipped: SMTP not configured", business: "skipped: SMTP not configured" };
  const cur = settings.currency || "USD";
  const shop = settings.businessName || "Our shop";
  const attachment = { filename: `estimate-${q.id}.pdf`, content: pdf, contentType: "application/pdf" };
  const result = {};

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM,
      to: q.customer.email,
      replyTo: settings.businessEmail || undefined,
      subject: `Your print estimate ${q.id} from ${shop}`,
      text: `Hi ${q.customer.name},\n\nThanks for your request. Your estimate is attached.\n\n${itemLines(q, cur)}\n\nEstimated total: ${fmt(q.total_cents, cur)}\n\nReply to this email with any questions or to confirm your order.\n\n${shop}`,
      attachments: [attachment]
    });
    result.customer = "sent";
  } catch (e) { result.customer = "failed: " + e.message; }

  if (settings.businessEmail) {
    try {
      await t.sendMail({
        from: process.env.SMTP_FROM,
        to: settings.businessEmail,
        replyTo: q.customer.email,
        subject: `New quote request ${q.id} — ${q.customer.name} (${fmt(q.total_cents, cur)})`,
        text: `New quote request.\n\nName: ${q.customer.name}\nEmail: ${q.customer.email}\nPhone: ${q.customer.phone || "—"}\nSource: ${q.source}\n\n${itemLines(q, cur)}\n\nEstimated total: ${fmt(q.total_cents, cur)}\n\nNotes:\n${q.customer.notes || "—"}`,
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
  if (!t) throw new Error("SMTP_HOST and SMTP_FROM are not set");
  await t.verify();
  return true;
}

module.exports = { sendQuoteEmails, verify, configured };
