"use strict";
// In-memory per-IP limiter. Fine for a single container.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const kept = arr.filter(t => now - t < windowMs);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "Too many requests. Wait a few minutes and try again." });
    arr.push(now);
    hits.set(req.ip, arr);
    next();
  };
}
module.exports = rateLimit;
