"use strict";
// Apple Pay domain verification file. Apple fetches it from
// /.well-known/apple-developer-merchantid-domain-association; it's uploaded
// in admin and kept on the data volume so it survives image updates.
const fs = require("fs");
const path = require("path");

const NAME = "apple-developer-merchantid-domain-association";
const file = () => path.join(require("./db").DATA_DIR, NAME);

const exists = () => fs.existsSync(file());
const read = () => (exists() ? fs.readFileSync(file()) : null);

function save(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error("Choose the verification file.");
  if (buf.length > 100 * 1024) throw new Error("That file is too large to be Apple's verification file.");
  if (buf.includes(0)) throw new Error("That doesn't look like Apple's verification file (it should be plain text).");
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), buf);
}
function remove() { if (exists()) fs.unlinkSync(file()); }

module.exports = { NAME, exists, read, save, remove };
