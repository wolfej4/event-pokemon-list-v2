"use strict";
// Logo files live on the data volume so they survive image updates.
const fs = require("fs");
const path = require("path");

const VARIANTS = ["light", "dark"];
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

function dataDir() { return require("./db").DATA_DIR; }
function filePath(variant, ext) { return path.join(dataDir(), `logo-${variant}.${ext}`); }

// Identify the file by its contents, not the name or header the browser sent.
function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  const head = buf.slice(0, 2048).toString("utf8").replace(/^\uFEFF/, "").trim().toLowerCase();
  if ((head.startsWith("<svg") || head.startsWith("<?xml")) && head.includes("<svg")) return "svg";
  return null;
}

function save(variant, buf) {
  if (!VARIANTS.includes(variant)) throw new Error("Unknown logo variant.");
  const ext = sniff(buf);
  if (!ext) throw new Error("Upload a PNG, JPG, WebP, or SVG image.");
  fs.mkdirSync(dataDir(), { recursive: true });
  for (const e of Object.keys(TYPES)) { try { fs.unlinkSync(filePath(variant, e)); } catch (_) {} }
  fs.writeFileSync(filePath(variant, ext), buf);
  return { ext, type: TYPES[ext], v: Date.now() };
}

function remove(variant) {
  for (const e of Object.keys(TYPES)) { try { fs.unlinkSync(filePath(variant, e)); } catch (_) {} }
}

function read(settings, variant) {
  const meta = (settings.logos || {})[variant];
  if (!meta) return null;
  try { return { buf: fs.readFileSync(filePath(variant, meta.ext)), type: meta.type }; } catch (_) { return null; }
}

// Public URLs (with a cache-busting version) for the storefront/admin
function urls(settings) {
  const l = settings.logos || {};
  const light = l.light ? `/api/public/logo/light?v=${l.light.v}` : null;
  const dark = l.dark ? `/api/public/logo/dark?v=${l.dark.v}` : null;
  return { light: light || dark, dark: dark || light };
}

// The PDF is always on white paper, so prefer the light-mode logo; PDFKit handles PNG/JPG only.
function pdfImage(settings) {
  for (const v of ["light", "dark"]) {
    const meta = (settings.logos || {})[v];
    if (meta && (meta.ext === "png" || meta.ext === "jpg")) {
      const f = read(settings, v);
      if (f) return f.buf;
    }
  }
  return null;
}

module.exports = { VARIANTS, save, remove, read, urls, pdfImage };
