"use strict";
// Works out which Square categories and custom-attribute values each design
// should carry, and caches the category/definition IDs Square hands back so
// a bulk push doesn't ask Square to look them up for every single design.
const square = require("./squareClient");

// National Pokédex ranges by region/generation. A regional form (e.g. Alolan
// Raichu) keeps its original species' number, so it's grouped under the
// region that number belongs to (Kanto for Raichu), not the variant's own
// region. Numbers past the last known range (a future generation) are left
// uncategorized rather than guessed.
const REGIONS = [
  [1, 151, "Kanto"], [152, 251, "Johto"], [252, 386, "Hoenn"], [387, 493, "Sinnoh"],
  [494, 649, "Unova"], [650, 721, "Kalos"], [722, 809, "Alola"], [810, 905, "Galar"],
  [906, 1025, "Paldea"]
];
function regionOf(dex) {
  const n = Number(dex);
  if (!Number.isFinite(n)) return null;
  const hit = REGIONS.find(([lo, hi]) => n >= lo && n <= hi);
  return hit ? hit[2] : null;
}
const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const BALLS_CATEGORY = "Poké Balls";

// The Square category names one design belongs in: its Pokémon type(s) and
// region for a character design, or the shared category for a plain ball
// (Poké Ball, Great Ball, ...). Anything else (Extras with no Pokémon) gets
// none.
function categoryNamesFor(d) {
  if (d.category === "standard") return [BALLS_CATEGORY];
  if (!d.pokemon) return [];
  const names = (d.pokemon.types || []).map(cap);
  const region = regionOf(d.pokemon.pokedex_number);
  if (region) names.push(region);
  return names;
}

// Resolved once per push run (or whenever a brand-new name shows up) and
// reused for every design after that; re-checked against Square's real
// catalog rather than trusted blindly, so a restart or switching between
// sandbox and production never creates a duplicate category.
let catCache = { env: null, map: {} };
async function categoryIdsFor(names) {
  const env = square.envName();
  if (catCache.env !== env) catCache = { env, map: {} };
  const missing = names.filter(n => !catCache.map[n]);
  if (missing.length) Object.assign(catCache.map, await square.ensureCategories(missing));
  const out = {};
  names.forEach(n => { if (catCache.map[n]) out[n] = catCache.map[n]; });
  return out;
}

let attrCache = { env: null, ids: null };
async function attributeDefinitionIds() {
  const env = square.envName();
  if (attrCache.env !== env || !attrCache.ids) attrCache = { env, ids: await square.ensureCustomAttributeDefinitions() };
  return attrCache.ids;
}

// { categories: [{id}, ...], reporting_category: {id} } ready to hand to
// square.upsertItem, or {} when the design has none.
async function categoriesFieldsFor(d) {
  const names = categoryNamesFor(d);
  if (!names.length) return { categories: [] };
  const ids = await categoryIdsFor(names);
  const categories = names.filter(n => ids[n]).map(n => ({ id: ids[n] }));
  if (!categories.length) return { categories: [] };
  return { categories, reporting_category: { id: categories[0].id } };
}

// custom_attribute_values for a design's Pokédex number and weight (whichever
// it has), ready to hand to square.upsertItem.
async function customAttributesFor(d) {
  const dex = d.pokemon && d.pokemon.pokedex_number;
  const weight = d.total_weight_grams;
  if (!dex && !weight) return {};
  const defs = await attributeDefinitionIds();
  const out = {};
  if (dex && defs.pokedex_number) {
    out[defs.pokedex_number.key] = {
      key: defs.pokedex_number.key, custom_attribute_definition_id: defs.pokedex_number.id,
      type: "NUMBER", number_value: String(Math.round(dex))
    };
  }
  if (weight && defs.weight_grams) {
    out[defs.weight_grams.key] = {
      key: defs.weight_grams.key, custom_attribute_definition_id: defs.weight_grams.id,
      type: "NUMBER", number_value: (Math.round(weight * 10) / 10).toString()
    };
  }
  return out;
}

module.exports = { regionOf, categoryNamesFor, categoriesFieldsFor, customAttributesFor, BALLS_CATEGORY };
