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

  // Two very different root causes produce the exact same 401 here, so
  // tell them apart instead of logging one generic message:
  //
  // 1. COOKIE_SECURE=true but this request came in over plain HTTP —
  //    the browser (rightly) refuses to store/send a cookie marked
  //    Secure over an insecure connection, and express-session won't
  //    even set it in the first place. Login "succeeds" (200 OK) but no
  //    session cookie is ever saved, so *every* request after that
  //    — in any browser, including a fresh private window — 401s. This
  //    is the likely cause if it happens immediately and consistently.
  // 2. The session really did expire, or the server restarted since
  //    login (sessions are in-memory) — the browser has a cookie the
  //    server just doesn't recognize anymore. This is the likely cause
  //    if it only started happening after a while, or after a redeploy.
  const cookieRequiresHttps = process.env.COOKIE_SECURE === "true";
  const insecureMismatch = cookieRequiresHttps && !req.secure;

  db.addErrorLog({
    type: "auth",
    message: insecureMismatch
      ? "Rejected request — COOKIE_SECURE=true but this request came in over plain HTTP, so the browser never stored the session cookie. Set COOKIE_SECURE=false (or access the admin panel over HTTPS) to fix this."
      : "Rejected request — no valid admin session (likely expired, or the server restarted since login)",
    path: req.originalUrl
  });
  return res.status(401).json({ error: "not_authenticated" });
}

module.exports = { checkPassword, requireAdmin };
