'use strict';
// Shared state and small helpers for the Embody Viewer.
// Loaded first; world.js (the renderer) and the page script both use these.

const $ = (s) => document.querySelector(s);

const S = {
  state: null, youId: null, placeId: null, sel: null,
  names: new Map(), seen: new Set(), ents: new Map(), slots: new Map(),
  speech: new Map(), activity: new Map(), captions: [], faceAt: new Map(),
  spot: null, youSpot: null, lastTalk: null,
  mode: 0, pal: 'neon', fade: 1, fadeDir: -1, pendingPlace: null,
  set: null,                // the current place's set: props, spots, lights, camera
  amb: null,                // the current light: sun, sky, fog, rays
  lat: { act: null, pushAt: 0, live: false },
  form: null, rate: 4, q: 1.6,
};
const cam = { target: [0, 1.3, 0.4], yaw: 0, pitch: 0.2, dist: 15, fov: 0.95, spin: false, idleAt: 0 };
let time = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nm = (id) => (id == null ? 'the world' : S.names.get(id) || id);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
