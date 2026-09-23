"use strict";
// Matches the filament colors your designs need against what's actually on
// the shelf in Spoolman. The only signal we have from N3D is a hex color, and
// Spoolman filaments have one too, so matching is done by RGB distance rather
// than by name — vendors and catalogs never agree on what to call a color.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function distance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2); // max ~441
}

/**
 * @param designs   db.allDesigns() — reads each design's `filaments` array (color, hex_color, weight_grams)
 * @param spools    spoolmanClient.listSpools() output
 * @param opts.lowStockGrams    matched stock below this counts as "low"
 * @param opts.matchThreshold   max RGB distance (0-441) to accept a Spoolman filament as "the same color"
 */
function buildColorReport(designs, spools, opts) {
  const lowStockGrams = Number(opts.lowStockGrams) || 0;
  const matchThreshold = Number(opts.matchThreshold) || 0;

  // stock on hand, grouped by Spoolman filament (one filament can have several spools)
  const stock = new Map();
  for (const sp of spools || []) {
    if (sp.archived) continue;
    const f = sp.filament;
    const rgb = f && hexToRgb(f.color_hex);
    if (!rgb) continue;
    const key = f.id;
    const cur = stock.get(key) || {
      name: f.name || "", hex: "#" + String(f.color_hex).replace(/^#/, "").toLowerCase(),
      material: f.material || "", vendor: (f.vendor && f.vendor.name) || "",
      grams: 0, spoolCount: 0, rgb
    };
    cur.grams += Number(sp.remaining_weight) || 0;
    cur.spoolCount += 1;
    stock.set(key, cur);
  }
  const stockList = [...stock.values()];

  // colors the catalog actually needs, grouped by hex, with which designs use each
  const need = new Map();
  for (const d of designs || []) {
    for (const f of d.filaments || []) {
      const rgb = hexToRgb(f.hex_color);
      if (!rgb || !f.weight_grams) continue;
      const hex = "#" + String(f.hex_color).replace(/^#/, "").toLowerCase();
      const cur = need.get(hex) || { hex, name: f.color || hex, designs: new Set(), gramsPerSet: 0 };
      cur.designs.add(d.title || d.slug);
      cur.gramsPerSet += Number(f.weight_grams) || 0;
      need.set(hex, cur);
    }
  }

  const rows = [];
  for (const item of need.values()) {
    const rgb = hexToRgb(item.hex);
    let best = null, bestDist = Infinity;
    for (const s of stockList) {
      const d = distance(rgb, s.rgb);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    const matched = best && bestDist <= matchThreshold;
    rows.push({
      hex: item.hex, name: item.name,
      designCount: item.designs.size, designs: [...item.designs].sort(),
      matched: !!matched,
      matchName: matched ? best.name : null, matchHex: matched ? best.hex : null,
      matchVendor: matched ? best.vendor : null, matchMaterial: matched ? best.material : null,
      matchGrams: matched ? Math.round(best.grams) : null, matchSpools: matched ? best.spoolCount : null,
      status: !matched ? "missing" : (best.grams < lowStockGrams ? "low" : "ok")
    });
  }
  const order = { missing: 0, low: 1, ok: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.designCount - a.designCount);

  return {
    rows, generatedAt: new Date().toISOString(),
    spoolCount: (spools || []).filter(s => !s.archived).length,
    filamentCount: stockList.length,
    toBuy: rows.filter(r => r.status !== "ok").length
  };
}

module.exports = { buildColorReport, hexToRgb, distance };
