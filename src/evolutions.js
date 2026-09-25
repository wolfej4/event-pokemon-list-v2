"use strict";
// Evolution families from PokéAPI (N3D's API has no evolution data). Looked up
// once per Pokédex number and cached in DATA_DIR/evolutions.json, so after the
// first run a sync only asks PokéAPI about Pokémon it hasn't seen before.
const fs = require("fs");
const path = require("path");
const db = require("./db");

const BASE = process.env.POKEAPI_BASE || "https://pokeapi.co/api/v2";
const FILE = () => path.join(db.DATA_DIR, "evolutions.json");

// species: { dex: chainId, 0 when PokéAPI has no family for it }
// chains:  { chainId: { dex, name, to: [...] } }
let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch (e) { cache = {}; }
  cache.species = cache.species || {}; cache.chains = cache.chains || {};
  return cache;
}
function save() {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(cache));
}

const idFromUrl = (u) => Number(String(u || "").match(/\/(\d+)\/?$/)?.[1]) || null;
function toNode(link) {
  return { dex: idFromUrl(link.species.url), name: link.species.name, to: (link.evolves_to || []).map(toNode) };
}
function eachNode(node, fn) { fn(node); node.to.forEach(n => eachNode(n, fn)); }

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("PokéAPI HTTP " + res.status);
  return res.json();
}

// Looks up every Pokédex number that isn't cached yet. Returns counts.
async function refresh(dexNumbers) {
  const c = load();
  const todo = [...new Set(dexNumbers.filter(n => Number.isInteger(n) && n > 0))].filter(n => !(n in c.species));
  let looked = 0, failed = 0;
  for (const dex of todo) {
    if (dex in c.species) continue; // filled in by an earlier chain in this run
    try {
      const sp = await getJson(BASE + "/pokemon-species/" + dex + "/");
      const chainId = sp && idFromUrl(sp.evolution_chain && sp.evolution_chain.url);
      if (!chainId) { c.species[dex] = 0; continue; }
      if (!c.chains[chainId]) {
        const ch = await getJson(BASE + "/evolution-chain/" + chainId + "/");
        if (!ch) { c.species[dex] = 0; continue; }
        c.chains[chainId] = toNode(ch.chain);
      }
      // every member of the chain shares it, which saves their lookups
      eachNode(c.chains[chainId], n => { if (n.dex) c.species[n.dex] = chainId; });
      c.species[dex] = chainId;
      looked++;
    } catch (e) {
      failed++; console.error("[evolutions] #" + dex + ":", e.message);
    }
  }
  if (todo.length) save();
  return { looked, failed };
}

// The full family tree containing this Pokédex number, or null.
function familyOf(dex) {
  const c = load();
  const id = c.species[dex];
  return id ? c.chains[id] || null : null;
}

module.exports = { refresh, familyOf };
