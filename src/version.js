"use strict";
// package.json's version plus, when built by the GitHub Actions workflow,
// the short commit it was built from — so a running container can be
// matched back to a specific push instead of guessing from "latest".
const { version } = require("../package.json");
const sha = (process.env.GIT_SHA || "").slice(0, 7);

module.exports = { version, sha };
