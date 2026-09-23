"use strict";
const crypto = require("crypto");

function checkPassword(candidate) {
  const real = process.env.ADMIN_PASSWORD || "";
  if (!real) return false;
  // hash both sides so the comparison is constant-time regardless of length
  const a = crypto.createHash("sha256").update(String(candidate || "")).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: "not_authenticated" });
}

module.exports = { checkPassword, requireAdmin };
