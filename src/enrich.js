"use strict";
// Background work after a sync: cache N3D sprites and look up evolution
// families. Runs outside the sync request so a slow download can't time the
// sync out behind a proxy.
const db = require("./db");
const sprites = require("./sprites");
const photos = require("./photos");
const evolutions = require("./evolutions");

const state = { running: false, startedAt: null, finishedAt: null, sprites: null, photos: null, families: null, error: null };

async function run() {
  if (state.running) return state;
  Object.assign(state, { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  try {
    state.sprites = await sprites.refresh();
    state.photos = await photos.refresh();
    const dex = db.allDesigns().map(d => d.pokemon && d.pokemon.pokedex_number).filter(Boolean);
    state.families = await evolutions.refresh(dex);
    console.log(`[enrich] sprites: ${state.sprites.done} saved, ${state.sprites.failed} failed; photos: ${state.photos.done} saved, ${state.photos.failed} failed; families: ${state.families.looked} looked up, ${state.families.failed} failed`);
  } catch (e) {
    state.error = e.message;
    console.error("[enrich]", e);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
  return state;
}

module.exports = { run, state };
