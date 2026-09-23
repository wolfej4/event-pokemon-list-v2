"use strict";
require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");

const publicRoutes = require("./src/routes/public");
const adminRoutes = require("./src/routes/admin");
const db = require("./src/db");

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!process.env.N3D_API_KEY) {
  console.warn("[startup] N3D_API_KEY is not set — syncing the catalog will fail until it is.");
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn("[startup] ADMIN_PASSWORD is not set — the admin panel will reject every login.");
}
if (!SESSION_SECRET) {
  console.warn("[startup] SESSION_SECRET is not set — using an insecure default. Set one in production.");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // so secure cookies work behind a reverse proxy (nginx/traefik/etc.)

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || "dev-only-insecure-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true", // set true once served over https
    maxAge: 1000 * 60 * 60 * 12 // 12h
  }
}));

app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);

// static sites
app.use("/admin", express.static(path.join(__dirname, "admin")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/admin*", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "index.html"));
});
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("[error]", err);
  db.addErrorLog({ type: "server", message: err.message || "server_error", path: req.originalUrl });
  res.status(500).json({ error: "server_error" });
});

const server = app.listen(PORT, () => {
  console.log(`N3D catalog listening on :${PORT}`);
});

function shutdown() {
  console.log("Shutting down…");
  db.flushSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
