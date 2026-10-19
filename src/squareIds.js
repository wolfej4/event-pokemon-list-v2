"use strict";
// Square IDs are kept per environment so testing in sandbox never overwrites
// (and later duplicates) the items in the live catalog. Designs pushed before
// this existed only have top-level IDs, and those were always production.
const SQ_FIELDS = ["square_item_id", "square_variation_id", "square_variation_id_shiny", "square_image_src", "square_image_ok", "square_pushed_at"];
function squareIdsFor(d, env) {
  if (d.square_by_env) return d.square_by_env[env] || {};
  if (env === "production" && d.square_item_id) { const o = {}; SQ_FIELDS.forEach(k => { o[k] = d[k]; }); return o; }
  return {};
}

module.exports = { SQ_FIELDS, squareIdsFor };
