"use strict";
const crypto = require("crypto");
const db = require("./db");

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal length to avoid leaking length via timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPassword(candidate) {
  const real = process.env.ADMIN_PASSWORD || "";
  if (!real) return false;
  return timingSafeEqual(candidate || "", real);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  // Sessions are in-memory, so this fires a lot after a server
  // restart/redeploy — the browser still has an old session cookie the
  // server no longer recognizes. Logging it here (rather than only where
  // each route reports "sync failed" etc.) gives one place to see the
  // real cause instead of a handful of unrelated-looking error messages.
  db.addErrorLog({
    type: "auth",
    message: "Rejected request — no valid admin session (likely expired, or the server restarted since login)",
    path: req.originalUrl
  });
  return res.status(401).json({ error: "not_authenticated" });
}

module.exports = { checkPassword, requireAdmin };
