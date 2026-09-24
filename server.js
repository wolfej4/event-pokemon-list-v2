"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const db = require("./src/db");

const PORT = process.env.PORT || 3000;
for (const [k, msg] of [
  ["N3D_API_KEY", "syncing from N3D will fail"],
  ["ADMIN_PASSWORD", "every admin login will be rejected"],
  ["SQUARE_ACCESS_TOKEN", "Square push is disabled"]
]) if (!process.env[k]) console.warn(`[startup] ${k} is not set — ${msg}.`);

if (!require("./src/mailer").configured()) console.warn("[startup] Email (SMTP) is not set up — quotes will be saved and downloadable, but not emailed. Set it in admin Settings or with SMTP_* env vars.");

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString("hex");
  console.warn("[startup] SESSION_SECRET is not set — using a random one (admin logins reset on restart).");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
app.use(session({
  name: "n3dcat.sid",
  secret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true", maxAge: 12 * 3600 * 1000 }
}));

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use("/api/public", require("./src/routes/public"));
app.use("/api/admin", require("./src/routes/admin"));
app.use("/api", (req, res) => res.status(404).json({ error: "not_found" }));

// lets the admin service worker (served from /admin/sw.js) control /admin itself
app.get("/admin/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/admin");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "admin", "sw.js"));
});
// pages, scripts and styles must be revalidated on every load so a deploy
// (or a caching proxy in front of the app) never mixes old and new files
const revalidate = (res, file) => { if (/\.(html|js|css|json)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); };
app.use("/admin", express.static(path.join(__dirname, "admin"), { setHeaders: revalidate }));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: revalidate }));
app.get(/^\/admin(\/.*)?$/, (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "admin", "index.html")));
app.get("*", (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error("[error]", err);
  res.status(500).json({ error: "server_error" });
});

const server = app.listen(PORT, () => console.log(`N3D catalog listening on :${PORT}`));
function shutdown() {
  db.flushSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
