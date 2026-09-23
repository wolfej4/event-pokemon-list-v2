"use strict";
const PDFDocument = require("pdfkit");
const { fmt } = require("./pricing");
const logo = require("./logo");

// Builds the quote PDF and resolves with a Buffer.
function buildQuotePdf(quote, settings) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50, info: { Title: "Quote " + quote.id } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const cur = settings.currency || "USD";
    const accent = "#2B4BD9";
    const muted = "#5B6472";
    const L = 50, R = doc.page.width - 50, W = R - L;

    // header: logo (PNG/JPG only; PDFKit can't embed SVG/WebP), then name and contact
    const date = new Date(quote.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const img = logo.pdfImage(settings);
    let hy = 50;
    if (img) {
      try { doc.image(img, L, 45, { fit: [170, 54] }); hy = 105; } catch (e) { hy = 50; }
    }
    if (!img || settings.logoShowName !== false || hy === 50) {
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(img && hy > 50 ? 13 : 20)
        .text(settings.businessName || "Print quote", L, hy, { width: W / 2 });
    } else {
      doc.y = hy;
    }
    doc.font("Helvetica").fontSize(9).fillColor(muted);
    const contact = [settings.businessEmail, settings.businessPhone].filter(Boolean).join("   ");
    if (contact) doc.text(contact, L, doc.y, { width: W / 2 });
    const headerBottom = doc.y;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(accent).text("Estimate " + quote.id, L, 50, { width: W, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor(muted).text(date, { width: W, align: "right" });

    const rule = Math.max(100, headerBottom + 12);
    doc.moveTo(L, rule).lineTo(R, rule).lineWidth(2).strokeColor(accent).stroke();

    // customer
    let y = rule + 15;
    doc.fillColor(muted).fontSize(9).text("Prepared for", L, y);
    doc.fillColor("#111827").fontSize(11).font("Helvetica-Bold").text(quote.customer.name, L, y + 13);
    doc.font("Helvetica").fontSize(9.5).fillColor("#374151");
    const lines = [quote.customer.email, quote.customer.phone].filter(Boolean);
    lines.forEach((ln, i) => doc.text(ln, L, y + 28 + i * 13));
    y += 30 + lines.length * 13 + 16;

    // table
    const cols = [
      { h: "Design", x: L, w: 250, align: "left" },
      { h: "Weight", x: L + 250, w: 60, align: "right" },
      { h: "Qty", x: L + 310, w: 40, align: "right" },
      { h: "Unit", x: L + 350, w: 70, align: "right" },
      { h: "Total", x: L + 420, w: W - 420, align: "right" }
    ];
    doc.rect(L, y, W, 20).fill("#EEF1F6");
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(8.5);
    cols.forEach(c => doc.text(c.h, c.x + 6, y + 6, { width: c.w - 12, align: c.align }));
    y += 20;
    doc.font("Helvetica").fontSize(9.5).fillColor("#111827");

    for (const it of quote.items) {
      const titleH = doc.heightOfString(it.title, { width: cols[0].w - 12 });
      const rowH = Math.max(22, titleH + 10);
      if (y + rowH > doc.page.height - 140) { doc.addPage(); y = 50; }
      const vals = [it.title, it.weight_grams ? Math.round(it.weight_grams) + " g" : "—", String(it.qty),
        fmt(it.unit_cents, cur), fmt(it.unit_cents * it.qty, cur)];
      vals.forEach((v, i) => doc.fillColor("#111827").text(v, cols[i].x + 6, y + 6, { width: cols[i].w - 12, align: cols[i].align }));
      y += rowH;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor("#D9DEE7").stroke();
    }

    y += 10;
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827")
      .text("Estimated total", L + 250, y, { width: 170, align: "right" })
      .text(fmt(quote.total_cents, cur), L + 420, y, { width: W - 426, align: "right" });
    y += 30;

    if (quote.customer.notes) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text("Notes from customer", L, y);
      doc.font("Helvetica").fontSize(9.5).fillColor("#374151").text(quote.customer.notes, L, y + 13, { width: W });
      y = doc.y + 16;
    }

    if (settings.quoteFooter) {
      doc.font("Helvetica").fontSize(8).fillColor(muted).text(settings.quoteFooter, L, Math.max(y, doc.page.height - 110), { width: W });
    }
    doc.end();
  });
}

module.exports = { buildQuotePdf };
