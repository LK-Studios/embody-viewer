'use strict';
// =====================================================================
//  The world renderer for the Embody Viewer.
//
//  Every place gets a set built from its own description, everyone in it
//  is placed and posed by what the world says about them, and the light
//  does the rest:
//    pass 1  raymarch the set (two targets: light/material/fog/lines and
//            depth/emission/light-source)
//    pass 2  compose at low resolution: god rays, glow, dust, heat shimmer
//    pass 3  halftone dots or ASCII glyphs at full resolution
// =====================================================================

const MAXG = 48;          // object groups: the first level of culling
const PRIM_ROWS = 1024;   // primitives in the data texture
const MAT = {
  SAND: 0, STONE: 1, ROCK: 2, PERSON: 3, YOU: 4, WATER: 5, WOOD: 6, CLOTH: 7, GLASS: 8, FLOOR: 9,
  SEL: 10, DOWN: 11, EXIT: 12, DARK: 13, SUN: 14, SKY: 15, EMBER: 16, FIRE: 17, METAL: 18, BONE: 19,
  SALT: 20, TARP: 21, PAN: 22, BANNER: 23, KETH: 24, LAMP: 25, CAVE: 26, ROPE: 27, BRASS: 28, TERRAIN: 31,
};
const SH = {
  BOX: 0, SPHERE: 1, CAPSULE: 2, CYL: 3, PRISM: 4, HUMAN: 5, HOODOO: 6, ARCH: 7, RIBS: 8, ROCK: 9,
  SAIL: 10, BANNER: 11, TOWER: 12, WELL: 13, WALL: 14, SHARDS: 15, FLAME: 16, FLOCK: 17, SEG: 18,
  TORUS: 19, CONE: 20, COILS: 21,
};

// ---------------------------------------------------------------------
//  Palettes: 32 materials each, and a sky for each part of the day
// ---------------------------------------------------------------------
const PALETTES = {
  neon: {
    ink: '#120a35', line: '#efeaff', stripes: 1,
    mats: ['#5a4ad6', '#7266e8', '#4c3cc0', '#8d84ff', '#ff5fc8', '#38c6ff', '#6a4ce0', '#a48cff', '#2a1f78', '#2f68ff',
      '#ffd84a', '#2c2378', '#7dfcff', '#1a1250', '#ff4fd8', '#cdc2f6', '#ff3d7a', '#ffa05c', '#5e58a8', '#e4dcff',
      '#eee8ff', '#8f6bff', '#6b5ce0', '#ff5fc8', '#b9a5ff', '#ffe08a', '#2a2070', '#9d8cf0', '#ffd27a', '#888888', '#888888', '#5a4ad6'],
    sky: {
      day: ['#8f7fe6', '#cdc2f6', '#ff4fd8', '#8a1cff'],
      dawn: ['#5f55cc', '#f2b8ea', '#ff8fd0', '#b03cff'],
      dusk: ['#3a2788', '#ff8fc8', '#ffb26b', '#ff3d7a'],
      night: ['#0d0830', '#2a1f6e', '#e9e4ff', '#9c8cff'],
      cave: ['#0d0830', '#1c1450', '#e9e4ff', '#9c8cff'],
    },
  },
  desert: {
    ink: '#1a1009', line: '#fff3dc', stripes: 0,
    mats: ['#c98c4f', '#a8957c', '#a24c32', '#3a2a22', '#d2553a', '#3f8fb0', '#7a5030', '#d8c2a0', '#1c1a22', '#9a7a5a',
      '#ffe08a', '#4a2e22', '#6fe0e8', '#20140c', '#fff1c1', '#f2dcb4', '#ff4a2a', '#ffb347', '#5a5450', '#efe4cf',
      '#f4efe6', '#8a7356', '#b89a72', '#8e1f2a', '#c8b08a', '#ffd27a', '#3a2a24', '#9a8060', '#c8a050', '#888888', '#888888', '#c98c4f'],
    sky: {
      day: ['#d9a865', '#f2dcb4', '#fff1c1', '#ff8a3c'],
      dawn: ['#7a86b8', '#f4c7a0', '#ffe2b0', '#ff7a4a'],
      dusk: ['#5a3050', '#ff9a4a', '#ffd27a', '#ff5a2a'],
      night: ['#0c1020', '#253048', '#f4f0e6', '#a8b0c8'],
      cave: ['#0c0a0a', '#1e1712', '#f4f0e6', '#a8b0c8'],
    },
  },
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// ---------------------------------------------------------------------
//  GLSL
// ---------------------------------------------------------------------
const GL_DEFS = Object.entries(MAT).map(([k, v]) => `#define M_${k} ${v}`).join('\n') + `\n#define MAXG ${MAXG}\n`;

const GL_NOISE = `
float hash1(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sn(vec3 p) { return sin(p.x * 1.7 + sin(p.z * 1.3)) * sin(p.y * 1.9 + sin(p.x * 2.1)) * sin(p.z * 1.5 + sin(p.y * 1.1)); }
`;

const GL_SDF = `
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdCap(vec3 p, float h, float r) { p.y -= clamp(p.y, -h, h); return length(p) - r; }
float sdCyl(vec3 p, float r, float h) { vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h); return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)); }
float sdPrism(vec3 p, vec2 h) { vec3 q = abs(p); return max(q.z - h.y, max(q.x * 0.866025 + p.y * 0.5, -p.y) - h.x * 0.5); }
float sdSeg(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float sdTaper(vec3 p, vec3 a, vec3 b, float ra, float rb) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - mix(ra, rb, h); }
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-5); }
float limb(vec3 p, vec3 a, vec3 b, vec3 c, float r0, float r1, float r2) { return min(sdTaper(p, a, b, r0, r1), sdTaper(p, b, c, r1, r2)); }

// A person: feet at y = 0, facing +z, about 1.8 tall.
// C = (walk, style, stride, flags: +1 lying, +2 armed)   D = (pose, arms, clock offset, props)
// pose 0 stand, 1 sit cross-legged, 3 kneel.  arms 0 swing, 1 spyglass, 2 crossed, 3 hilt, 4 ledger,
// 5 yoke, 6 talking, 7 drill.  props +1 spyglass, +2 ledger, +4 yoke and jars, +8 staff.
// style 0 plain, 1 guard, 2 Keth, 3 carrier, 4 long coat, 5 elder, 6 captain.
float sdHuman(vec3 p, vec4 C, vec4 D) {
  float walk = C.x, ph = C.z;
  int style = int(C.y + 0.5);
  int pose = int(D.x + 0.5), arms = int(D.y + 0.5);
  float tp = uTime + D.z;
  float props = D.w;
  bool armed = mod(C.w, 4.0) > 1.5;
  bool pGlass = mod(props, 2.0) > 0.5;
  bool pLedger = mod(floor(props * 0.5), 2.0) > 0.5;
  bool pYoke = mod(floor(props * 0.25), 2.0) > 0.5;
  bool pStaff = mod(floor(props * 0.125), 2.0) > 0.5;
  float sw = sin(ph) * 0.55 * walk;
  float still = 1.0 - walk;
  float sway = sin(tp * 0.45) * 0.018 * still;
  float breath = sin(tp * 1.7) * 0.008;
  float stoop = style == 5 ? 0.16 : 0.0;
  float hipY = pose == 1 ? 0.2 : (pose == 3 ? 0.55 : 0.9);
  vec3 u = p - vec3(sway, hipY - 0.9 - abs(cos(ph)) * 0.035 * walk, 0.0);
  float lean = stoop + (pGlass ? 0.1 : 0.0) + (arms == 4 ? 0.05 : 0.0);
  u.z += max(u.y - 0.9, 0.0) * lean;
  float d = length(u - vec3(0.0, 1.62, 0.02)) - 0.12;
  d = smin(d, sdSeg(u, vec3(0.0, 1.43, 0.0), vec3(0.0, 1.52, 0.01), 0.055), 0.05);
  d = smin(d, sdTaper(u, vec3(0.0, 0.98, 0.0), vec3(0.0, 1.32, 0.0), 0.13, 0.165 + breath), 0.06);
  d = smin(d, sdSeg(u, vec3(-0.17, 1.37, 0.0), vec3(0.17, 1.37, 0.0), 0.07), 0.06);
  d = smin(d, sdSeg(u, vec3(-0.09, 0.93, 0.0), vec3(0.09, 0.93, 0.0), 0.11), 0.06);
  float leg;
  if (pose == 1) {
    leg = min(limb(p, vec3(-0.1, 0.2, 0.0), vec3(-0.38, 0.13, 0.3), vec3(0.1, 0.08, 0.42), 0.085, 0.062, 0.045),
              limb(p, vec3(0.1, 0.2, 0.0), vec3(0.38, 0.13, 0.3), vec3(-0.1, 0.08, 0.42), 0.085, 0.062, 0.045));
  } else if (pose == 3) {
    leg = min(limb(p, vec3(-0.1, 0.55, 0.0), vec3(-0.1, 0.08, 0.14), vec3(-0.1, 0.06, -0.32), 0.085, 0.062, 0.045),
              limb(p, vec3(0.1, 0.55, 0.0), vec3(0.13, 0.52, 0.42), vec3(0.13, 0.05, 0.42), 0.085, 0.062, 0.045));
  } else {
    vec3 lp = p - vec3(sway, 0.0, 0.0);
    float s = lp.x < 0.0 ? -1.0 : 1.0;
    vec3 q = vec3(abs(lp.x), lp.y, lp.z);
    float a = s * sw;
    vec3 hip = vec3(0.1, 0.9, 0.0);
    vec3 knee = hip + vec3(0.01, -0.43 * cos(a), 0.43 * sin(a));
    float kb = max(0.0, -a) * 0.9 + 0.04;
    vec3 ankle = knee + vec3(0.0, -0.42 * cos(a - kb), 0.42 * sin(a - kb));
    leg = limb(q, hip, knee, ankle, 0.085, 0.062, 0.045);
    leg = min(leg, sdSeg(q, ankle + vec3(0.0, -0.025, -0.03), ankle + vec3(0.0, -0.03, 0.1), 0.038));
  }
  d = smin(d, leg, 0.04);
  vec3 shR = vec3(0.21, 1.36, 0.0), shL = vec3(-0.21, 1.36, 0.0);
  float bR = -0.8 * sw, bL = 0.8 * sw;
  vec3 elR = shR + vec3(0.04, -0.28 * cos(bR), 0.28 * sin(bR));
  vec3 haR = elR + vec3(0.01, -0.26 * cos(bR + 0.3), 0.26 * sin(bR + 0.3));
  vec3 elL = shL + vec3(-0.04, -0.28 * cos(bL), 0.28 * sin(bL));
  vec3 haL = elL + vec3(-0.01, -0.26 * cos(bL + 0.3), 0.26 * sin(bL + 0.3));
  if (arms == 1) { elR = vec3(0.24, 1.32, 0.2); haR = vec3(0.06, 1.58, 0.26); elL = vec3(-0.18, 1.2, 0.22); haL = vec3(-0.01, 1.56, 0.44); }
  else if (arms == 2) { elR = vec3(0.25, 1.1, 0.08); haR = vec3(-0.1, 1.2, 0.17); elL = vec3(-0.25, 1.1, 0.08); haL = vec3(0.1, 1.22, 0.15); }
  else if (arms == 3) { elR = vec3(0.27, 1.08, -0.02); haR = vec3(-0.13, 0.97, 0.12); }
  else if (arms == 4) { elL = vec3(-0.22, 1.08, 0.06); haL = vec3(-0.1, 1.1, 0.34); elR = vec3(0.22, 1.1, 0.1); haR = vec3(-0.02, 1.14 + 0.02 * sin(tp * 6.0), 0.31); }
  else if (arms == 5) { elR = vec3(0.34, 1.3, 0.05); haR = vec3(0.42, 1.46, 0.02); elL = vec3(-0.34, 1.3, 0.05); haL = vec3(-0.42, 1.46, 0.02); }
  else if (arms == 6) { float g = sin(tp * 3.1) * 0.5 + 0.5; elR = vec3(0.28, 1.12, 0.12); haR = vec3(0.2, 1.22 + 0.12 * g, 0.4); }
  else if (arms == 7) { float c = sin(tp * 1.6); elR = vec3(0.3, 1.36 + 0.12 * c, 0.18); haR = vec3(0.2 - 0.2 * c, 1.5 + 0.18 * c, 0.42 - 0.08 * c); elL = vec3(-0.26, 1.1, 0.12); haL = vec3(-0.12, 1.16, 0.3); }
  if (pStaff) { elL = vec3(-0.28, 1.12, 0.12); haL = vec3(-0.3, 1.2, 0.3); }
  d = smin(d, min(limb(u, shR, elR, haR, 0.058, 0.048, 0.04), limb(u, shL, elL, haL, 0.058, 0.048, 0.04)), 0.035);
  if (pGlass) d = min(d, sdTaper(u, haR + vec3(-0.03, 0.02, -0.04), haR + vec3(-0.06, 0.06, 0.44), 0.03, 0.022));
  if (pLedger) d = min(d, sdBox(u - haL - vec3(0.04, 0.03, 0.02), vec3(0.11, 0.016, 0.08), 0.004));
  if (pYoke) {
    float sx = sin(ph * 0.5 + tp * 0.9) * 0.05;
    d = min(d, sdSeg(u, vec3(-0.8, 1.47, 0.0), vec3(0.8, 1.47, 0.0), 0.035));
    vec3 ju = vec3(abs(u.x), u.y, u.z);
    d = min(d, sdSeg(ju, vec3(0.76, 1.46, 0.0), vec3(0.76 + sx, 1.12, 0.0), 0.012));
    d = min(d, sdEllipsoid(ju - vec3(0.76 + sx, 0.93, 0.0), vec3(0.16, 0.21, 0.16)));
  }
  if (pStaff) d = min(d, sdSeg(p, vec3(-0.32, 0.0, 0.34), vec3(-0.3, 1.9, 0.29), 0.022));
  if (armed) {
    if (arms == 7) d = min(d, sdSeg(u, haR, haR + vec3(0.04, 0.48, 0.46), 0.017));
    else d = min(d, sdSeg(u, vec3(-0.17, 0.97, 0.06), vec3(-0.26, 0.38, -0.14), 0.022));
  }
  if (style == 1 || style == 6) {
    d = smin(d, length(u - vec3(0.0, 1.67, 0.0)) - 0.135, 0.02);
    d = min(d, sdSeg(u, vec3(0.0, 1.79, -0.1), vec3(0.0, 1.83 + (style == 6 ? 0.07 : 0.0), 0.08), 0.026));
    vec3 au = vec3(abs(u.x), u.y, u.z);
    d = min(d, sdSeg(au, vec3(0.17, 1.41, 0.0), vec3(0.27, 1.37, 0.0), 0.085));
    if (style == 6) {
      vec3 cu = u; cu.z += 0.16 + max(1.38 - u.y, 0.0) * (0.08 + 0.05 * sin(tp * 2.2 + u.y * 3.0));
      d = min(d, sdBox(cu - vec3(0.0, 0.95, 0.0), vec3(0.2 + max(1.38 - u.y, 0.0) * 0.1, 0.44, 0.02), 0.01));
    }
  } else if (style == 2) {
    d = smin(d, length(u - vec3(0.0, 1.64, -0.035)) - 0.155, 0.03);
    d = smin(d, sdSeg(u, vec3(0.0, 1.72, -0.1), vec3(0.0, 1.62, -0.32), 0.035), 0.03);
    vec3 cu = u;
    float fl = max(1.4 - u.y, 0.0);
    cu.z += fl * (0.07 + 0.05 * sin(tp * 2.3 + u.y * 4.0 + u.x * 2.0));
    cu.x += fl * 0.03 * sin(tp * 1.7 + u.y * 3.0);
    float hem = pose == 1 ? 0.62 : 0.45;
    d = smin(d, sdTaper(cu, vec3(0.0, 1.4, -0.05), vec3(0.0, hem, -0.1), 0.19, 0.33), 0.05);
    d = min(d, sdSeg(u, vec3(0.05, 1.48, -0.1), vec3(0.2 + 0.06 * sin(tp * 3.0), 1.3, -0.46 - 0.05 * sin(tp * 2.7)), 0.024));
  } else if (style == 3) {
    d = smin(d, sdBox(u - vec3(0.0, 1.13, -0.24), vec3(0.17, 0.25, 0.11), 0.04), 0.03);
    d = min(d, sdCyl(u - vec3(0.0, 1.75, 0.0), 0.28, 0.014));
    d = smin(d, length(u - vec3(0.0, 1.78, 0.0)) - 0.1, 0.03);
  } else if (style == 4) {
    vec3 cu = u; cu.z += max(1.3 - u.y, 0.0) * 0.04 * sin(tp * 1.9 + u.y * 2.0);
    d = smin(d, sdTaper(cu, vec3(0.0, 1.3, 0.0), vec3(0.0, pose == 1 ? 0.5 : 0.28, -0.02), 0.16, 0.3), 0.05);
    d = smin(d, sdTaper(u, vec3(0.0, 1.38, -0.03), vec3(0.0, 1.56, -0.06), 0.16, 0.12), 0.03);
  } else if (style == 5) {
    d = smin(d, sdEllipsoid(u - vec3(0.0, 1.48, -0.03), vec3(0.27, 0.24, 0.21)), 0.07);
    d = smin(d, length(u - vec3(0.0, 1.65, 0.0)) - 0.14, 0.03);
  }
  return d * 0.8;
}

float sdHoodoo(vec3 q, float rb, vec4 C, vec4 D) {
  float h = C.w;
  float y = clamp(q.y, 0.0, h);
  float f = y / h;
  float rad = mix(rb, C.x, smoothstep(0.0, 0.9, f)) * (1.0 + 0.07 * sin(y * D.x + q.x * 0.5)) + 0.05 * sn(q * 2.1);
  float col = max(length(q.xz) - rad, max(-q.y, q.y - h)) * 0.8;
  float cap = sdEllipsoid(q - vec3(0.0, h + C.z * 0.3, 0.0), vec3(C.y, C.z, C.y * 0.9)) + 0.06 * sn(q * 1.7);
  return smin(col, cap, 0.25);
}
float sdArch(vec3 q, float th, vec4 C) {
  vec2 w = vec2(length(q.xy) - C.x, q.z);
  float m = min(th, C.z);
  float d = length(w / vec2(th, C.z)) * m - m;
  return (d + 0.09 * sn(q * 1.2)) * 0.8;
}
float sdRibs(vec3 q, float th, vec4 C, vec4 D) {
  float n = D.x, sp = C.x;
  float id = clamp(floor(q.x / sp + 0.5), -floor(n * 0.5), floor((n - 1.0) * 0.5));
  float lx = q.x - id * sp;
  float ca = cos(D.y), sa = sin(D.y);
  vec2 yz = vec2(ca * q.y + sa * q.z, -sa * q.y + ca * q.z);
  float hr = hash1(id * 7.3 + 1.0);
  float R = C.y * (1.0 - 0.06 * hr);
  float d = length(vec2(length(yz) - R, lx)) - th;
  float cut = -C.z + step(0.62, hr) * hr * C.y * 0.6;
  return max(d, cut - yz.x);
}
float sdSail(vec3 q, vec4 C, vec4 D) {
  vec2 e = clamp(q.xz / vec2(C.x, C.z), -1.0, 1.0);
  float sag = D.x * (1.0 - e.x * e.x) * (1.0 - e.y * e.y);
  float fl = D.y * sin(q.x * 1.8 + uTime * 2.4) * sin(q.z * 1.3 + uTime * 1.7) * (1.0 - e.x * e.x);
  return sdBox(vec3(q.x, q.y + sag - fl, q.z), vec3(C.x, 0.025, C.z), 0.01) * 0.6;
}
float sdBanner(vec3 q, vec4 C, vec4 D) {
  if (D.y > 0.5) {
    float u = clamp(q.x / (2.0 * C.x), 0.0, 1.0);
    float off = D.x * u * sin(q.x * 2.6 - uTime * 4.2);
    return sdBox(vec3(q.x - C.x, q.y - off * 0.3, q.z - off), vec3(C.x, C.y, 0.02), 0.004) * 0.6;
  }
  float v = clamp((C.y - q.y) / (2.0 * C.y), 0.0, 1.0);
  float off = D.x * v * sin(q.y * 2.2 + q.x * 1.4 - uTime * 2.6);
  return sdBox(vec3(q.x, q.y, q.z - off), vec3(C.x, C.y, 0.02), 0.004) * 0.6;
}
float sdTower(vec3 q, float r1, vec4 C, vec4 D) {
  float h = C.w;
  float d = sdTaper(q, vec3(0.0), vec3(0.0, h, 0.0), r1, C.x);
  float a = atan(q.z, q.x);
  d -= 0.06 * smoothstep(0.5, 1.0, cos(a * D.x)) * step(q.y, h * 0.92);
  d = min(d, sdCyl(q - vec3(0.0, h, 0.0), C.x * 1.35, 0.08));
  return d * 0.85;
}
float sdWell(vec3 q, float ro, vec4 C) {
  float h = C.w;
  float d = max(sdCyl(q - vec3(0.0, h * 0.5, 0.0), ro, h * 0.5), -sdCyl(q - vec3(0.0, h * 0.5 + 0.1, 0.0), C.x, h * 0.5 + 0.2));
  return min(d, length(vec2(length(q.xz) - (ro + C.x) * 0.5, q.y - h)) - (ro - C.x) * 0.62);
}
float sdWall(vec3 q, float r, vec4 C, vec4 D) {
  float d = sdBox(q, C.xyz, r);
  if (D.x > 0.0) {
    float cx = q.x - D.x * floor(q.x / D.x + 0.5);
    float mer = sdBox(vec3(cx, q.y - C.y - D.y * 0.5, q.z), vec3(D.x * 0.27, D.y * 0.5, C.z * 0.98), 0.01);
    d = min(d, max(mer, abs(q.x) - C.x));
  }
  return d + 0.012 * sn(q * 7.0);
}
float sdShards(vec3 q, vec4 C, vec4 D) {
  float area = sdBox(vec3(q.x, 0.0, q.z), vec3(C.x, 1.0, C.z), 0.0);
  vec2 id = floor(q.xz / D.x);
  vec2 lc = q.xz - (id + 0.5) * D.x;
  float h = hash2(id);
  float d = 1e5;
  if (h < D.y) {
    vec2 o = (vec2(hash2(id + 3.1), hash2(id + 5.7)) - 0.5) * D.x * 0.45;
    vec3 l = vec3(lc.x - o.x, q.y, lc.y - o.y);
    float tilt = (h / D.y - 0.5) * 0.9;
    l.xy = vec2(cos(tilt) * l.x - sin(tilt) * l.y, sin(tilt) * l.x + cos(tilt) * l.y);
    if (D.z > 0.5) {
      float s = 0.025 + 0.045 * max(0.0, sin(uTime * (2.0 + h * 5.0) + h * 30.0));
      d = length(l - vec3(0.0, 0.08 + h * 0.5, 0.0)) - s;
    } else {
      float ht = 0.14 + h * 0.55;
      d = sdBox(l - vec3(0.0, ht * 0.5, 0.0), vec3(0.04 + h * 0.06, ht * 0.5, 0.02 + h * 0.03), 0.01);
    }
  }
  float cellD = D.x * 0.5 - max(abs(lc.x), abs(lc.y));
  d = min(d, max(cellD + 0.02, q.y - 1.2));
  return max(d, area);
}
float sdFlame(vec3 q, float r, vec4 C, vec4 D) {
  float h = C.w;
  float y = clamp(q.y / h, 0.0, 1.0);
  vec2 off = vec2(sin(uTime * 7.0 + q.y * 5.0 + D.x), cos(uTime * 6.1 + q.y * 4.3 + D.x)) * 0.06 * y;
  float rad = r * pow(1.0 - y, 0.7) * (0.75 + 0.35 * sin(uTime * 11.0 + q.y * 9.0 + D.x * 3.0));
  float d = length(q.xz - off) - rad;
  return max(max(d, -q.y), q.y - h) * 0.6;
}
float sdFlock(vec3 q, float sz, vec4 C, vec4 D) {
  float d = 1e5;
  for (int i = uZero; i < 6; i++) {
    if (float(i) >= D.x) break;
    float fi = float(i);
    float a = uTime * D.y * (0.8 + 0.1 * fi) + fi * 2.1;
    float R = C.x * (0.7 + 0.15 * fi);
    vec3 l = q - vec3(cos(a) * R, sin(uTime * 0.5 + fi) * 1.5 + fi * 0.6, sin(a) * R);
    vec2 tg = vec2(-sin(a), cos(a));
    l.xz = vec2(dot(l.xz, vec2(tg.y, -tg.x)), dot(l.xz, tg));
    float flap = sin(uTime * 9.0 + fi * 1.7) * 0.5;
    vec3 wl = vec3(abs(l.x), l.y, l.z);
    float wing = sdSeg(wl, vec3(0.0), vec3(sz * 1.2, sz * flap, -sz * 0.2), sz * 0.08);
    float body = sdSeg(l, vec3(0.0, 0.0, -sz * 0.4), vec3(0.0, 0.0, sz * 0.4), sz * 0.12);
    d = min(d, min(wing, body));
  }
  return d;
}
float sdCoils(vec3 q, float tube, vec4 C, vec4 D) {
  float d = 1e5;
  for (int i = uZero; i < 4; i++) {
    if (float(i) >= D.x) break;
    float fi = float(i);
    vec3 l = q - vec3(0.0, fi * C.y * 1.6 - 1.0, 0.0);
    float ang = atan(l.z, l.x) + uTime * 0.04 * (mod(fi, 2.0) * 2.0 - 1.0);
    float R = C.x * (1.0 - 0.12 * fi);
    float ridge = 0.12 * tube * smoothstep(0.3, 1.0, sin(ang * 26.0));
    d = min(d, length(vec2(length(l.xz) - R, l.y)) - tube * (1.0 - 0.15 * fi) - ridge);
  }
  return d * 0.8;
}
`;

const GL_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Pass 1: the set, raymarched.
const GL_SCENE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${GL_DEFS}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform vec3 uCamR;
uniform vec3 uCamU;
uniform vec3 uCamF;
uniform float uTan;
uniform float uTime;
uniform int uZero;
uniform vec3 uSun;
uniform float uSunI;
uniform vec3 uMoon;
uniform float uNight;
uniform float uFogK;
uniform float uFogH;
uniform vec2 uWind;
uniform float uStripes;
uniform float uLinesOn;
uniform float uIndoor;
uniform vec4 uT0;
uniform vec4 uT1;
uniform vec4 uT2;
uniform vec4 uT3;
uniform vec4 uT4;
uniform int uGroups;
uniform vec4 uSceneB;
uniform vec4 uG0[MAXG];
uniform vec4 uG1[MAXG];
uniform sampler2D uPrims;
uniform int uLights;
uniform vec4 uLightP[4];
uniform vec4 uLightC[4];
uniform int uShafts;
uniform vec4 uShaftA[4];
uniform vec4 uShaftB[4];
${GL_NOISE}
${GL_SDF}

// ---- ground: dunes with crests, buttes, a plateau edge, a road, the thing under the sand
float terrainH(vec2 p) {
  float r = length(p);
  vec2 w = vec2(p.x * 0.8 + p.y * 0.6, -p.x * 0.6 + p.y * 0.8);
  float c1 = 1.0 - abs(sin(w.x * 0.15 + sin(w.y * 0.06) * 1.7));
  float c2 = 1.0 - abs(sin(w.x * 0.27 + w.y * 0.1 + 1.7));
  float dunes = (c1 * c1 * 0.8 + c2 * c2 * 0.35) - 0.42;
  float band = 1.0;
  if (uT1.x > 0.5) band = smoothstep(0.38, 0.62, vnoise(p * 0.03 + vec2(uTime * 0.002 + uT1.y, 0.0)));
  float h = uT0.x * dunes * band * smoothstep(uT0.y, uT0.y + 12.0, r);
  if (uT0.z > 0.0) {
    float m = smoothstep(0.5, 0.64, vnoise(p * 0.016 + 3.7)) * smoothstep(50.0, 75.0, r);
    h += uT0.z * m * (0.8 + 0.2 * vnoise(p * 0.15));
  }
  if (uT2.y > 0.0) h -= uT2.y * smoothstep(uT2.z, uT2.z + 5.0, r + 2.0 * vnoise(p * 0.25));
  if (uT2.x > 0.0) {
    vec2 c = vec2(cos(uTime * 0.045), sin(uTime * 0.045)) * 34.0;
    vec2 dv = p - c;
    h += uT2.x * 1.4 * exp(-dot(dv, dv) * 0.015);
  }
  if (uT1.z > 0.0) h *= smoothstep(uT1.z, uT1.z + 4.0, abs(dot(p, vec2(cos(uT1.w), -sin(uT1.w)))));
  return h;
}
float terrainSDF(vec3 p) {
  float k = 0.45;
  if (uT2.y > 0.0) { float r = length(p.xz); if (r > uT2.z - 2.0 && r < uT2.z + 8.0) k = 0.2; }
  return (p.y - terrainH(p.xz)) * k;
}
int groundMat(vec3 p) {
  int m = int(uT0.w + 0.5);
  bool low = uT2.y > 0.0 && p.y < -3.0;
  if (uT1.x > 0.5 || low) {
    float band = smoothstep(0.38, 0.62, vnoise(p.xz * 0.03 + vec2(uTime * 0.002 + uT1.y, 0.0)));
    m = band > 0.3 ? M_SAND : M_GLASS;
  }
  if (uT1.z > 0.0 && abs(dot(p.xz, vec2(cos(uT1.w), -sin(uT1.w)))) < uT1.z + 0.4 * vnoise(p.xz * 0.6)) m = M_SALT;
  if (uT3.z > 0.5 && p.x < -11.0 + 3.0 * vnoise(p.xz * 0.08)) m = M_GLASS;
  return m;
}

// ---- one primitive from the data texture
vec2 evalPrim(int i, vec3 p) {
  vec4 A = texelFetch(uPrims, ivec2(0, i), 0);
  vec4 B = texelFetch(uPrims, ivec2(1, i), 0);
  vec4 C = texelFetch(uPrims, ivec2(2, i), 0);
  vec4 D = texelFetch(uPrims, ivec2(3, i), 0);
  vec3 q = p - B.xyz;
  q.xz = vec2(A.z * q.x + A.w * q.z, -A.w * q.x + A.z * q.z);
  int t = int(A.x + 0.5);
  float d = 1e5;
  if (t == 0) d = sdBox(q, C.xyz, B.w);
  else if (t == 1) d = C.x > 0.0 ? sdEllipsoid(q, C.xyz) : length(q) - B.w;
  else if (t == 2) { if (C.x > 0.5) q = q.yxz; d = sdCap(q, C.w, B.w); }
  else if (t == 3) d = sdCyl(q, B.w, C.w);
  else if (t == 4) d = sdPrism(q, C.xy);
  else if (t == 5) {
    vec3 bq = q / B.w;
    if (mod(C.w, 2.0) > 0.5) bq = vec3(-bq.z, bq.x + 0.9, bq.y - 0.16);
    float bd = (length(bq - vec3(0.0, 0.95, 0.0)) - 1.15) * B.w;
    d = bd > 0.3 ? bd : sdHuman(bq, C, D) * B.w;
  }
  else if (t == 6) d = sdHoodoo(q, B.w, C, D);
  else if (t == 7) d = sdArch(q, B.w, C);
  else if (t == 8) d = sdRibs(q, B.w, C, D);
  else if (t == 9) {
    // rock: C.w mixes a rounded boulder into a blocky cliff; D = (fluting, its scale, ledges, ledge frequency)
    float round = sdEllipsoid(q, C.xyz);
    float blocky = sdBox(q, C.xyz * 0.92, min(C.x, min(C.y, C.z)) * 0.22);
    d = mix(round, blocky, C.w);
    d += D.x * sn(vec3(q.x * 0.9, q.y * 0.22, q.z * 0.9) * D.y);
    float band = fract(q.y * D.w * 0.16 + sn(q * 0.35) * 0.25);
    d -= D.z * smoothstep(0.55, 0.9, band);
    d *= 0.72;
  }
  else if (t == 10) d = sdSail(q, C, D);
  else if (t == 11) d = sdBanner(q, C, D);
  else if (t == 12) d = sdTower(q, B.w, C, D);
  else if (t == 13) d = sdWell(q, B.w, C);
  else if (t == 14) d = sdWall(q, B.w, C, D);
  else if (t == 15) d = sdShards(q, C, D);
  else if (t == 16) d = sdFlame(q, B.w, C, D);
  else if (t == 17) d = sdFlock(q, B.w, C, D);
  else if (t == 18) d = D.x > 0.0 ? sdTaper(q, vec3(0.0), C.xyz, B.w, D.x) : sdSeg(q, vec3(0.0), C.xyz, B.w);
  else if (t == 19) { if (C.z > 1.5) q = q.xzy; else if (C.z > 0.5) q = q.yxz; d = length(vec2(length(q.xz) - C.x, q.y)) - B.w; }
  else if (t == 20) d = sdTaper(q, vec3(0.0), vec3(0.0, C.w, 0.0), B.w, C.x) * 0.9;
  else if (t == 21) d = sdCoils(q, B.w, C, D);
  return vec2(d, A.y);
}

// ---- the whole set: ground, cave, and every group whose bound is close enough to matter
vec2 sceneMap(vec3 p) {
  vec2 res = vec2(terrainSDF(p), float(M_TERRAIN));
  if (uT3.x > 0.5) {
    float walls = uT3.w - length(p.xz) + 0.6 * sn(p * 0.6);
    float roof = (uT3.y - p.y) + 0.5 * sn(p * 0.5 + 3.0);
    if (uShafts > 0) roof = max(roof, -(length(p.xz - uShaftA[0].xz) - uShaftA[0].w * 1.15));
    float cave = min(walls, roof);
    if (cave < res.x) res = vec2(cave, float(M_CAVE));
  }
  if (uGroups > 0 && length(p - uSceneB.xyz) - uSceneB.w < res.x) {
    for (int g = uZero; g < MAXG; g++) {
      if (g >= uGroups) break;
      vec4 b = uG0[g];
      if (length(p - b.xyz) - b.w > res.x) continue;
      int s = int(uG1[g].x), n = int(uG1[g].y);
      float gd = 1e5, gm = 0.0;
      for (int k = uZero; k < 160; k++) {
        if (k >= n) break;
        vec2 e = evalPrim(s + k, p);
        if (e.y < -0.5) gd = max(gd, -e.x);
        else if (e.x < gd) { gd = e.x; gm = e.y; }
      }
      if (gd < res.x) res = vec2(gd, gm);
    }
  }
  return res;
}

float skyLum(vec3 rd) {
  float up = clamp(rd.y * 2.0, 0.0, 1.0);
  float l = mix(mix(0.92, 0.62, up), mix(0.3, 0.08, up), uNight);
  vec2 cp = rd.xz / (rd.y + 0.25) * 2.2 + vec2(uTime * 0.01, 0.0);
  float cl = smoothstep(0.55, 0.85, vnoise(cp) * 0.7 + vnoise(cp * 2.7) * 0.3) * smoothstep(0.02, 0.3, rd.y);
  return l + cl * mix(0.08, -0.06, uNight);
}
vec2 voro(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = vec2(hash2(n + g), hash2(n + g + 17.3));
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return vec2(sqrt(f1), sqrt(f2));
}
vec2 rayCyl(vec3 ro, vec3 rd, vec3 a, vec3 b, float r) {
  vec3 ba = b - a; float L = length(ba); vec3 ax = ba / L;
  vec3 oc = ro - a;
  vec3 dd = rd - ax * dot(rd, ax), o = oc - ax * dot(oc, ax);
  float A = dot(dd, dd), B = dot(dd, o), Cc = dot(o, o) - r * r;
  float disc = B * B - A * Cc;
  if (disc < 0.0 || A < 1e-6) return vec2(-1.0);
  float s = sqrt(disc);
  float t0 = (-B - s) / A, t1 = (-B + s) / A;
  float ry = dot(rd, ax), oy = dot(oc, ax);
  if (abs(ry) > 1e-5) { float ta = -oy / ry, tb = (L - oy) / ry; t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb)); }
  else if (oy < 0.0 || oy > L) return vec2(-1.0);
  return t1 > t0 ? vec2(t0, t1) : vec2(-1.0);
}
float volumes(vec3 ro, vec3 rd, float tEnd) {
  float v = 0.0;
  for (int k = uZero; k < 4; k++) {
    if (k >= uShafts) break;
    vec4 A = uShaftA[k], B = uShaftB[k];
    vec2 seg = rayCyl(ro, rd, A.xyz, B.xyz, A.w);
    if (seg.y <= 0.0) continue;
    float t0 = max(seg.x, 0.0), t1 = min(seg.y, tEnd);
    if (t1 <= t0) continue;
    vec3 m = ro + rd * (0.5 * (t0 + t1));
    float len = (t1 - t0) / (2.0 * A.w);
    if (B.w > 0.0) {
      float dust = 0.65 + 0.35 * vnoise(vec2(m.y * 1.5 - uTime * 0.3, m.x * 2.0 + m.z * 2.0));
      v += B.w * len * dust * (0.35 + 0.65 * uSunI);
    } else {
      float a = atan(m.z - A.z, m.x - A.x);
      float sw = 0.5 + 0.5 * sin(a * 3.0 + m.y * 1.7 - uTime * 4.0);
      v += -B.w * len * sw * (1.0 - smoothstep(A.y, B.y, m.y) * 0.7);
    }
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  float asp = uRes.x / uRes.y;
  vec3 rd = normalize(uCamF + uv.x * uCamR * uTan * asp + uv.y * uCamU * uTan);
  vec3 ro = uCamPos;
  // One loop and a single call to sceneMap (the shader compiler inlines every call site):
  // phase 0 marches the view ray, 1 samples the normal and the occlusion, 2 marches the shadow ray.
  int phase = 0, sub = 0;
  float t = 0.02, m = 0.0, ne = 0.0, occ = 0.0, occW = 1.0, st = 0.05, sres = 1.0;
  bool hit = false;
  vec3 hp = ro, nacc = vec3(0.0), n = vec3(0.0, 1.0, 0.0);
  for (int i = uZero; i < 270; i++) {
    vec3 k = vec3(0.0), q;
    if (phase == 0) {
      q = ro + rd * t;
      if ((uT3.x < 0.5 && rd.y > 0.0 && q.y > 45.0) || t > 240.0) break;
    } else if (phase == 1) {
      if (sub < 4) { k = 0.5773 * (2.0 * vec3(float(((sub + 3) >> 1) & 1), float((sub >> 1) & 1), float(sub & 1)) - 1.0); q = hp + ne * k; }
      else q = hp + n * (0.12 * float(sub - 3));
    } else {
      q = hp + n * 0.04 + uSun * st;
    }
    vec2 h = sceneMap(q);
    if (phase == 0) {
      if (h.x < 0.0007 * t + 0.0004) { hit = true; m = h.y; hp = q; ne = 0.0012 + 0.0004 * t; phase = 1; sub = 0; }
      else t += h.x * (1.0 + 0.35 * smoothstep(40.0, 140.0, t));
    } else if (phase == 1) {
      if (sub < 4) nacc += k * h.x;
      else { occ += (0.12 * float(sub - 3) - h.x) * occW; occW *= 0.6; }
      sub++;
      if (sub == 4) n = normalize(nacc);
      if (sub == 8) phase = (uSunI > 0.0 && dot(n, uSun) > 0.0) ? 2 : 3;
    } else {
      sres = min(sres, 9.0 * h.x / st);
      st += clamp(h.x, 0.05, 1.2);
      vec3 sp = hp + n * 0.04 + uSun * st;
      if (sres < 0.02 || st > 45.0 || (sp.y > 30.0 && uT3.x < 0.5)) phase = 3;
    }
    if (phase == 3) break;
  }
  if (hit && sub < 4) n = length(nacc) > 0.0 ? normalize(nacc) : vec3(0.0, 1.0, 0.0);
  occ = clamp(1.0 - 1.6 * occ, 0.25, 1.0);
  sres = clamp(sres, 0.0, 1.0);
  vec3 p = hit ? hp : ro + rd * t;
  vec2 gw = fwidth(p.xz);
  float lum = 0.0, b = 0.0, line = 0.0, emit = 0.0, src = 0.0, depth = 1.0;
  float mat = float(M_SKY);
  float back = max(dot(rd, uSun), 0.0);

  if (!hit) {
    float sd = acos(clamp(dot(rd, uSun), -1.0, 1.0));
    float up = clamp(rd.y * 2.2, 0.0, 1.0);
    lum = skyLum(rd) + 0.25 * exp(-sd * 4.0) * uSunI;
    b = up;
    src = lum * 0.3 * (1.0 - uNight * 0.7);
    if (uNight > 0.5) {
      vec3 sp = floor(rd * 260.0);
      if (fract(sin(dot(sp, vec3(12.9898, 78.233, 37.719))) * 43758.5453) > 0.996) lum = 0.95;
      float md = acos(clamp(dot(rd, uMoon), -1.0, 1.0));
      if (md < 0.06) { mat = float(M_SUN); b = 0.85 - md * 4.0; lum = 0.95; src = 0.6; }
      lum += 0.12 * exp(-md * 7.0);
    } else {
      float sunR = 0.16;
      if (sd < sunR) {
        float sv = clamp((rd.y - uSun.y) / sunR, -1.0, 1.0);
        float band = fract(sv * 4.0 - uTime * 0.15);
        bool cut = uStripes > 0.5 && sv < 0.1 && band < 0.32 * (0.1 - sv);
        if (!cut) { mat = float(M_SUN); b = sv * 0.5 + 0.5; lum = mix(0.45, 1.0, b); src = 1.0; }
      }
    }
  } else {
    int mi = int(m + 0.5);
    bool terr = mi == M_TERRAIN;
    if (terr) mi = groundMat(p);
    bool body = mi == M_PERSON || mi == M_YOU || mi == M_SEL || mi == M_DOWN;
    float sunVis = uSunI > 0.0 ? sres : 0.0;
    float dif = max(dot(n, uSun), 0.0) * sunVis * uSunI;
    float sky = (0.5 + 0.5 * n.y) * mix(0.3, 0.1, uNight) * uIndoor;
    if (uT3.x > 0.5) sky *= 0.35;
    float bounce = (max(0.0, -n.y) * 0.12 + max(0.0, dot(n, -normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-4))) * 0.07) * uSunI;
    float moon = uNight * max(dot(n, uMoon), 0.0) * 0.22;
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * (0.25 + 0.75 * back) * (0.3 + 0.7 * max(uSunI, uNight * 0.5));
    float pl = 0.0;
    for (int k = uZero; k < 4; k++) {
      if (k >= uLights) break;
      vec3 L = uLightP[k].xyz - p;
      float dl = length(L);
      float fl = 1.0 + uLightC[k].y * (0.6 * sin(uTime * 13.0 + float(k) * 3.1) + 0.4 * sin(uTime * 7.3 + float(k)));
      pl += uLightC[k].x * fl * (0.35 + 0.65 * max(dot(n, L / dl), 0.0)) / (1.0 + dl * dl / (uLightP[k].w * uLightP[k].w));
    }
    lum = sky * occ + dif * 0.95 + bounce * occ + moon + pl;
    if (mi == M_SAND || mi == M_PAN) {
      float rip = 0.5 + 0.5 * sin(dot(p.xz, uWind) * 6.0 + vnoise(p.xz * 0.7) * 4.0);
      lum *= 0.9 + 0.1 * rip;
      vec2 wp = vec2(dot(p.xz, uWind) * 0.7 - uTime * 1.6, dot(p.xz, vec2(-uWind.y, uWind.x)) * 5.0);
      lum += smoothstep(0.78, 0.96, vnoise(wp)) * 0.07 * uSunI;
    }
    if (mi == M_ROCK || mi == M_CAVE || mi == M_STONE) lum *= 0.86 + 0.14 * sin(p.y * 5.0 + sn(p * 0.8) * 2.0);
    if (mi == M_GLASS || mi == M_WATER || mi == M_METAL) {
      vec3 r = reflect(rd, n);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
      float spec = pow(max(dot(r, uSun), 0.0), mi == M_METAL ? 18.0 : 70.0) * 1.6 * uSunI * sunVis;
      float base = mi == M_METAL ? 0.6 : 0.28;
      lum = lum * base + (skyLum(r) * (uT3.x > 0.5 ? 0.15 : 0.55) * fres + spec) * (mi == M_METAL ? 0.5 : 1.0);
      if (mi == M_WATER) lum += 0.05 * sin(length(p.xz) * 9.0 - uTime * 2.5) * (1.0 - fres);
    }
    if (mi == M_BONE || mi == M_SALT) lum *= 1.12;
    if (mi == M_FIRE) { lum = 0.92 + 0.08 * sin(uTime * 17.0 + p.y * 9.0); emit = lum; }
    else if (mi == M_EMBER) { lum = 0.45 + 0.22 * sin(uTime * 1.3 + p.x * 2.0 + p.z); emit = lum; }
    else if (mi == M_LAMP) { lum = 0.95; emit = 0.9; }
    else if (mi == M_EXIT) { lum = 0.75 + 0.2 * sin(uTime * 2.6 + p.y * 2.0); emit = 0.5; }
    if (body) lum = 0.05 + rim * 1.1 + pl * 0.6 + dif * 0.08 + moon * 0.3;
    float fogH = uFogH;
    float ymid = max(0.5 * (ro.y + p.y), 0.0);
    float fog = 1.0 - exp(-uFogK * exp(-ymid * fogH) * t);
    float fogL = mix(0.88, 0.3, uNight) + 0.45 * pow(back, 6.0) * uSunI;
    if (uT3.x > 0.5) fogL = 0.12;
    if (uIndoor < 0.9) fog *= 0.5;
    lum = mix(lum, fogL, fog);
    b = fog;
    mat = float(mi);
    depth = t / 240.0;
    if (terr || mi == M_FLOOR) {
      float l = 0.0;
      bool cracked = uT4.z > 0.5 && (mi == M_GLASS || mi == M_PAN);
      if ((uLinesOn > 0.5 && !cracked) || mi == M_FLOOR) {
        float spacing = mi == M_FLOOR ? 1.0 : 2.0;
        vec2 g = p.xz / spacing, w = gw / spacing;
        vec2 f = abs(fract(g - 0.5) - 0.5) / max(w, vec2(1e-4));
        float gl = 1.0 - clamp(min(f.x, f.y) - 0.5, 0.0, 1.0);
        l = max(l, gl * (1.0 - smoothstep(0.2, 0.55, max(w.x, w.y))) * (mi == M_FLOOR ? 0.5 : 1.0));
      }
      float ww = max(gw.x, gw.y);
      if (uT4.z > 0.5 && (mi == M_GLASS || mi == M_PAN) && n.y > 0.8) {
        float sc = mi == M_GLASS ? 0.45 : 0.9;
        vec2 v = voro(p.xz * sc);
        l = max(l, (1.0 - smoothstep(0.0, 0.05 + ww * sc * 2.0, v.y - v.x)) * (1.0 - smoothstep(0.25, 0.8, ww * sc)) * (mi == M_GLASS ? 0.75 : 0.45));
      }
      if (uT4.x > 0.0) l = max(l, 1.0 - smoothstep(0.0, 0.05 + ww * 1.5, abs(length(p.xz) - uT4.x)));
      if (uT4.y > 0.5 && uT1.z > 0.0) {
        float rd2 = abs(dot(p.xz, vec2(cos(uT1.w), -sin(uT1.w))));
        l = max(l, (1.0 - smoothstep(0.0, 0.06 + ww * 1.5, abs(rd2 - 0.75))) * 0.8);
      }
      line = l * (1.0 - fog * 0.85);
    }
  }
  lum += volumes(ro, rd, hit ? t : 240.0);
  o0 = vec4(clamp(lum, 0.0, 1.0), mat / 31.0, b, line);
  o1 = vec4(depth, clamp(emit, 0.0, 1.0), 0.0, clamp(src, 0.0, 1.0));
}`;

// Pass 2: compose. Light shafts toward the sun, glow, motes of dust, heat shimmer.
const GL_COMPOSE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uS0;
uniform sampler2D uS1;
uniform vec2 uRes;
uniform vec2 uSunUV;
uniform float uRays;
uniform float uTime;
uniform float uShimmer;
uniform float uDust;
uniform float uContrast;
uniform vec2 uWind2;
out vec4 o;
${GL_NOISE}
void main() {
  vec2 px = 1.0 / uRes;
  vec2 uv = gl_FragCoord.xy * px;
  float depth = texture(uS1, uv).x;
  float far = smoothstep(0.06, 0.3, depth);
  vec2 wob = vec2(sin(uv.y * 160.0 + uTime * 5.0), cos(uv.x * 110.0 + uTime * 3.7)) * px * 1.3 * uShimmer * far;
  vec4 s0 = texelFetch(uS0, ivec2(clamp(uv + wob, 0.0, 0.9999) * uRes), 0);
  float lum = s0.r;
  int mi = int(s0.g * 31.0 + 0.5);
  if (uRays > 0.001) {
    vec2 dir = uSunUV - uv;
    float acc = 0.0, w = 1.0;
    for (int i = 1; i <= 28; i++) {
      vec2 q = uv + dir * (float(i) / 28.0) * 0.92;
      if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
      acc += texture(uS1, q).w * w;
      w *= 0.94;
    }
    lum += acc / 28.0 * uRays * (mi == 15 || mi == 14 ? 0.35 : 1.0);
  }
  float glow = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785; glow += texture(uS1, uv + vec2(cos(a), sin(a)) * px * 3.5).y; }
  lum += glow * 0.045;
  if (uDust > 0.0) {
    for (int l = 0; l < 2; l++) {
      float sc = l == 0 ? 90.0 : 170.0;
      vec2 g = uv * vec2(sc * uRes.x / uRes.y, sc) + uWind2 * uTime * (l == 0 ? 6.0 : 11.0) + vec2(0.0, sin(uTime * 0.7 + uv.x * 10.0) * 0.6);
      vec2 id = floor(g);
      vec2 f = fract(g) - 0.5;
      float h = hash2(id + float(l) * 13.1);
      if (h > 1.0 - 0.06 * uDust) {
        vec2 c = vec2(hash2(id + 3.3), hash2(id + 7.7)) - 0.5;
        float md = length(f - c * 0.6);
        float zd = 0.03 + hash2(id + 9.1) * 0.25;
        if (zd < depth) lum += (1.0 - smoothstep(0.08, 0.2, md)) * 0.35 * (l == 0 ? 1.0 : 0.6);
      }
    }
  }
  // an S-curve: deep shadows, hot highlights
  lum = clamp(lum, 0.0, 1.0);
  lum = mix(lum, lum * lum * (3.0 - 2.0 * lum), uContrast);
  o = vec4(lum, s0.g, s0.b, s0.a);
}`;

// Pass 3: halftone dots or ASCII glyphs.
const GL_PRESENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uScene;
uniform sampler2D uGlyph;
uniform vec2 uRes;
uniform vec2 uSceneRes;
uniform vec2 uCell;
uniform int uMode;
uniform float uGlyphN;
uniform float uFade;
uniform float uVig;
uniform vec3 uPal[32];
uniform vec3 uInk;
uniform vec3 uLine;
uniform vec3 uSkyTop;
uniform vec3 uSkyBot;
uniform vec3 uSunA;
uniform vec3 uSunB;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 cell = floor(fc / uCell);
  vec2 ctr = (cell + 0.5) * uCell;
  vec4 s = texelFetch(uScene, ivec2(clamp(ctr / uRes, 0.0, 0.9999) * uSceneRes), 0);
  float lum = s.r;
  int mi = int(s.g * 31.0 + 0.5);
  vec3 col;
  if (mi == 15) col = mix(uSkyBot, uSkyTop, s.b);
  else if (mi == 14) col = mix(uSunB, uSunA, s.b);
  else col = mix(uPal[mi], uSkyBot, s.b * 0.8);
  float line = texture(uScene, fc / uRes).a;
  bool body = mi == 3 || mi == 4 || mi == 10 || mi == 11;
  vec3 c;
  if (uMode == 0) {
    vec3 paper = mix(col, vec3(1.0), 0.3);
    vec3 ink = mix(col, uInk, 0.6);
    float r = 0.72 * sqrt(clamp(1.0 - lum, 0.0, 1.0));
    float d = length((fc - ctr) / uCell.y);
    float aa = 1.2 / uCell.y;
    c = mix(paper, ink, 1.0 - smoothstep(r - aa, r + aa, d));
    c = mix(c, uLine, clamp(line, 0.0, 1.0) * 0.85);
  } else if (uMode == 2) {
    // raw light, no dots: for judging a set
    vec4 r = texture(uScene, fc / uRes);
    vec4 rn = texelFetch(uScene, ivec2(clamp(fc / uRes, 0.0, 0.9999) * uSceneRes), 0);
    int rm = int(rn.g * 31.0 + 0.5);
    vec3 rc = rm == 15 ? mix(uSkyBot, uSkyTop, rn.b) : rm == 14 ? mix(uSunB, uSunA, rn.b) : mix(uPal[rm], uSkyBot, rn.b * 0.8);
    c = mix(uInk, mix(rc, vec3(1.0), 0.2), clamp(r.r, 0.0, 1.0));
    c = mix(c, uLine, clamp(r.a, 0.0, 1.0) * 0.5);
  } else {
    float l = mi == 15 ? lum * 0.38 : lum;
    float gi = floor(clamp(l, 0.0, 1.0) * (uGlyphN - 1.0) + 0.5);
    vec3 fg = mix(col, vec3(1.0), 0.18) * (0.6 + 0.6 * lum);
    float lc = 0.0;
    for (int k = 0; k < 4; k++) {
      vec2 off = vec2((k == 0 || k == 2) ? -0.3 : 0.3, k < 2 ? -0.3 : 0.3) * uCell;
      lc = max(lc, texture(uScene, (ctr + off) / uRes).a);
    }
    if (lc > 0.5) { gi = 5.0; fg = uLine * (0.7 + 0.3 * lc); }
    if (body && lum < 0.4) { gi = 8.0; fg = mix(col, uInk, 0.45); }
    vec2 lp = (fc - cell * uCell) / uCell;
    float g = texture(uGlyph, vec2((gi + lp.x) / uGlyphN, 1.0 - lp.y)).a;
    c = mix(uInk, fg, g);
  }
  if (uFade > 0.001) c = mix(c, uInk, step(hash(cell), uFade));
  vec2 q = fc / uRes;
  c *= 1.0 - uVig + uVig * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.3);
  o = vec4(c, 1.0);
}`;

// ---------------------------------------------------------------------
//  WebGL
// ---------------------------------------------------------------------
const canvas = $('#gl');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, desynchronized: true, powerPreference: 'high-performance' });
if (!gl) { $('#boot').textContent = 'This viewer needs WebGL2.'; throw new Error('no webgl2'); }

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log);
    $('#boot').textContent = 'Shader error: ' + String(log).slice(0, 300);
    throw new Error(log);
  }
  return s;
}
function program(fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, GL_VS));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const locs = {};
  p.u = (name) => (name in locs ? locs[name] : (locs[name] = gl.getUniformLocation(p, name)));
  return p;
}
const compileT0 = performance.now();
const progScene = program(GL_SCENE);
console.info(`scene shader compiled in ${Math.round(performance.now() - compileT0)} ms`);
const progCompose = program(GL_COMPOSE);
const progPresent = program(GL_PRESENT);

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function colorTex(w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const fboScene = gl.createFramebuffer();
const fboCompose = gl.createFramebuffer();
let tex0 = null, tex1 = null, texC = null, sceneW = 0, sceneH = 0;
function sizeScene(w, h) {
  if (w === sceneW && h === sceneH) return;
  sceneW = w; sceneH = h;
  for (const t of [tex0, tex1, texC]) if (t) gl.deleteTexture(t);
  tex0 = colorTex(w, h); tex1 = colorTex(w, h); texC = colorTex(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex0, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, tex1, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboCompose);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texC, 0);
}

const primTex = gl.createTexture();
const primData = new Float32Array(PRIM_ROWS * 16);
gl.bindTexture(gl.TEXTURE_2D, primTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, PRIM_ROWS, 0, gl.RGBA, gl.FLOAT, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

const RAMP = ' .:-=+*#%@';
const glyphTex = gl.createTexture();
(function makeGlyphs() {
  const cw = 40, ch = 64;
  const c = document.createElement('canvas');
  c.width = cw * RAMP.length; c.height = ch;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.font = `bold ${Math.round(ch * 0.8)}px Consolas, "Cascadia Mono", "Courier New", monospace`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  [...RAMP].forEach((g, i) => x.fillText(g, i * cw + cw / 2, ch * 0.54));
  gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
})();

// ---------------------------------------------------------------------
//  Shapes
// ---------------------------------------------------------------------
const PR = {
  box: (pos, s, m, rot = 0, r = 0.04) => ({ t: SH.BOX, m, pos, rot, r: Math.min(r, s[0], s[1], s[2]), s }),
  sphere: (pos, r, m) => ({ t: SH.SPHERE, m, pos, r }),
  ellipsoid: (pos, s, m, rot = 0) => ({ t: SH.SPHERE, m, pos, rot, r: Math.max(...s), s }),
  capsule: (pos, r, h, m, lying = false, rot = 0) => ({ t: SH.CAPSULE, m, pos, rot, r, c: [lying ? 1 : 0, 0, 0, h] }),
  cyl: (pos, r, h, m, rot = 0) => ({ t: SH.CYL, m, pos, rot, r, h }),
  prism: (pos, h, len, m, rot = 0) => ({ t: SH.PRISM, m, pos, rot, c: [h, len, 0, 0] }),
  hoodoo: (pos, h, rBase, rNeck, rCap, hCap, m, rot = 0) => ({ t: SH.HOODOO, m, pos, rot, r: rBase, c: [rNeck, rCap, hCap, h], d: [7, 0, 0, 0] }),
  arch: (pos, span, thick, depth, m, rot = 0) => ({ t: SH.ARCH, m, pos, rot, r: thick, c: [span, 0, depth, 0] }),
  ribs: (pos, n, spacing, radius, thick, cut, roll, m, rot = 0) => ({ t: SH.RIBS, m, pos, rot, r: thick, c: [spacing, radius, cut, 0], d: [n, roll, 0, 0] }),
  rock: (pos, s, m, rot = 0, o = {}) => ({ t: SH.ROCK, m, pos, rot, c: [s[0], s[1], s[2], o.blocky ?? 0.25], d: [o.noise ?? 0.12, o.freq ?? 1.4, o.strata ?? 0.07, o.sfreq ?? 5.5] }),
  sail: (pos, w, dpt, sag, flutter, m, rot = 0) => ({ t: SH.SAIL, m, pos, rot, c: [w, 0, dpt, 0], d: [sag, flutter, 0, 0] }),
  banner: (pos, w, h, wave, flying, m, rot = 0) => ({ t: SH.BANNER, m, pos, rot, c: [w, h, 0, 0], d: [wave, flying ? 1 : 0, 0, 0] }),
  tower: (pos, r1, r2, h, fins, m, rot = 0) => ({ t: SH.TOWER, m, pos, rot, r: r1, c: [r2, 0, 0, h], d: [fins, 0, 0, 0] }),
  well: (pos, rOut, rIn, h, m) => ({ t: SH.WELL, m, pos, r: rOut, c: [rIn, 0, 0, h] }),
  wall: (pos, s, crenel, merlon, m, rot = 0) => ({ t: SH.WALL, m, pos, rot, r: 0.03, c: [s[0], s[1], s[2], 0], d: [crenel, merlon, 0, 0] }),
  shards: (pos, w, dpt, cell, density, m, sparks = false, rot = 0) => ({ t: SH.SHARDS, m, pos, rot, c: [w, 0, dpt, 0], d: [cell, density, sparks ? 1 : 0, 0] }),
  flame: (pos, r, h, seed = 0) => ({ t: SH.FLAME, m: MAT.FIRE, pos, r, c: [0, 0, 0, h], d: [seed, 0, 0, 0] }),
  flock: (pos, R, n, speed, size, m = MAT.DARK) => ({ t: SH.FLOCK, m, pos, r: size, c: [R, 0, 0, 0], d: [n, speed, 0, 0] }),
  seg: (a, b, r, m, r2 = 0) => ({ t: SH.SEG, m, pos: a, r, c: [b[0] - a[0], b[1] - a[1], b[2] - a[2], 0], d: [r2, 0, 0, 0] }),
  torus: (pos, R, tube, axis, m, rot = 0) => ({ t: SH.TORUS, m, pos, rot, r: tube, c: [R, 0, axis, 0] }),
  cone: (pos, r1, r2, h, m, rot = 0) => ({ t: SH.CONE, m, pos, rot, r: r1, c: [r2, 0, 0, h] }),
  coils: (pos, R, tube, n, m) => ({ t: SH.COILS, m, pos, r: tube, c: [R, 1.6, 0, 0], d: [n, 0, 0, 0] }),
  sub: (p) => ({ ...p, m: -1 }),
};

function putPrim(row, p) {
  const o = row * 16;
  const rot = p.rot || 0;
  primData[o] = p.t; primData[o + 1] = p.m; primData[o + 2] = Math.cos(rot); primData[o + 3] = Math.sin(rot);
  primData[o + 4] = p.pos[0]; primData[o + 5] = p.pos[1]; primData[o + 6] = p.pos[2]; primData[o + 7] = p.r || 0;
  const s = p.s || [0, 0, 0];
  const c = p.c || [s[0], s[1], s[2], p.h || 0];
  primData[o + 8] = c[0]; primData[o + 9] = c[1]; primData[o + 10] = c[2]; primData[o + 11] = c[3];
  const d = p.d || [0, 0, 0, 0];
  primData[o + 12] = d[0]; primData[o + 13] = d[1]; primData[o + 14] = d[2]; primData[o + 15] = d[3];
}

// a sphere around one primitive, generous enough for its animation
function primBound(p) {
  const s = p.s || [0, 0, 0], c = p.c || [s[0], s[1], s[2], p.h || 0], r = p.r || 0, d = p.d || [0, 0, 0, 0];
  const [x, y, z] = p.pos;
  const at = (dy, rad) => [x, y + dy, z, rad];
  switch (p.t) {
    case SH.BOX: case SH.WALL: return at(0, Math.hypot(c[0], c[1] + d[1], c[2]) + r + 0.05);
    case SH.SPHERE: return at(0, c[0] > 0 ? Math.max(c[0], c[1], c[2]) : r);
    case SH.CAPSULE: return at(0, c[3] + r);
    case SH.CYL: return at(0, Math.hypot(r, c[3]));
    case SH.PRISM: return at(0, Math.hypot(c[0], c[1]) * 1.2);
    case SH.HUMAN: return at(0.95 * r, 1.25 * r);
    case SH.HOODOO: return at(c[3] * 0.55, c[3] * 0.6 + Math.max(r, c[1]) + c[2]);
    case SH.ARCH: return at(0, c[0] + r + c[2]);
    case SH.RIBS: return at(0, Math.hypot(c[0] * d[0] * 0.5, c[1]) + r + 0.5);
    case SH.ROCK: return at(0, Math.max(c[0], c[1], c[2]) * 1.35 + 0.3);
    case SH.SAIL: return at(0, Math.hypot(c[0], c[2]) + d[0] + 0.3);
    case SH.BANNER: return at(0, Math.hypot(c[0], c[1]) * (d[1] ? 2.2 : 1) + 0.4);
    case SH.TOWER: case SH.WELL: return at(c[3] * 0.5, Math.hypot(r, c[3] * 0.6) + 0.3);
    case SH.SHARDS: return at(0.4, Math.hypot(c[0], c[2]) + 0.9);
    case SH.FLAME: return at(c[3] * 0.5, c[3] * 0.7 + r);
    case SH.FLOCK: return at(2, c[0] * 1.5 + 3);
    case SH.SEG: return [x + c[0] / 2, y + c[1] / 2, z + c[2] / 2, Math.hypot(c[0], c[1], c[2]) / 2 + Math.max(r, d[0]) + 0.02];
    case SH.TORUS: return at(0, c[0] + r);
    case SH.CONE: return at(c[3] / 2, Math.hypot(Math.max(r, c[0]), c[3] / 2) + 0.1);
    case SH.COILS: return at(2, c[0] + r * 2 + 6);
  }
  return at(0, 3);
}
function groupBound(prims) {
  const bs = prims.filter((p) => p.m >= 0).map(primBound);
  if (!bs.length) return [0, -100, 0, 0.001];
  let cx = 0, cy = 0, cz = 0;
  for (const b of bs) { cx += b[0]; cy += b[1]; cz += b[2]; }
  cx /= bs.length; cy /= bs.length; cz /= bs.length;
  let r = 0;
  for (const b of bs) r = Math.max(r, Math.hypot(b[0] - cx, b[1] - cy, b[2] - cz) + b[3]);
  return [cx, cy, cz, r];
}

// ---------------------------------------------------------------------
//  Sets: one for each kind of place in the Glass Reach
// ---------------------------------------------------------------------
// Rough positions for bearings between places (north is -z).
const WORLD_MAP = [
  [/scar gate|the hold/i, [0, 0]], [/gate yard/i, [0, -1]], [/salt road/i, [0, -6]], [/landing/i, [4, -11]],
  [/glass flats/i, [-3, -13]], [/red ridge/i, [-3, -22]], [/deepwell/i, [-2, -23]], [/bone field/i, [-12, -15]], [/^the deep$/i, [-6, -14]],
];
const mapPos = (name) => { for (const [re, p] of WORLD_MAP) if (re.test(name || '')) return p; return null; };

function setKind(here) {
  const name = here.name || '';
  const tests = [
    ['deep', /^the deep$/i], ['deepwell', /deepwell|cavern|cave/i], ['bones', /bone field|wreck/i], ['yard', /yard|drill|barrack/i],
    ['hold', /\bhold\b|keep|hall|fort|castle/i], ['road', /road|track|trail/i], ['landing', /landing|carrier|caravan|market|camp/i],
    ['ridge', /ridge|crag|cliff|bluff|mesa/i], ['flats', /flats|glass|pan/i],
  ];
  for (const [k, re] of tests) if (re.test(name)) return k;
  const desc = here.state?.description || '';
  for (const [k, re] of tests) if (re.test(desc)) return k;
  return 'dunes';
}
// the kinds the narrator knows for its epigraphs
function pickRecipe(here) {
  const k = setKind(here);
  return { landing: 'camp', deepwell: 'ridge', bones: 'flats', deep: 'dunes' }[k] || k;
}

function newSet(kind, here) {
  const set = {
    kind, here, R: rng(hashStr((here.id || '') + (here.name || kind))),
    groups: [], cur: null,
    spots: { stand: [], sit: [], lookout: [], work: [], drill: [], patrol: [], shade: [], overlook: [], elder: [], items: [], you: { p: [0, 5], y: 0 } },
    anchors: [], exitAt: [], lights: [], shafts: [], windows: [], dyn: [],
    terr: { t0: [0.9, 8, 10, MAT.SAND], t1: [0, 0, 0, 0], t2: [0, 0, 0, 0], t3: [0, 0, 0, 0], t4: [0, 0, 0, 0] },
    cam: { target: [0, 1.4, -2], dist: 18, pitch: 0.22, yaw: 0, maxDist: 34 },
    landmark: [0, 0, 90], exitR: 13, dust: 0.6, shimmer: 0.4, rays: 1, indoor: false, cave: false, lines: true,
  };
  set.obj = () => { set.cur = []; set.groups.push(set.cur); return set; };
  set.add = (...ps) => { if (!set.cur) set.obj(); for (const p of ps) set.cur.push(p); return set; };
  set.r = (a, b) => a + (b - a) * set.R();
  return set;
}
const isNight = () => (S.amb?.night || 0) > 0.6;
const isDim = () => (S.amb?.night || 0) > 0.25;

// ---- composite pieces
function cliffLine(set, a, b, height, thick, baseY = 0) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.round(len / 5.5));
  const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
  set.obj();
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n;
    const h = height * set.r(0.75, 1.25);
    set.add(PR.rock([a[0] + (b[0] - a[0]) * f, baseY + h * 0.42, a[1] + (b[1] - a[1]) * f],
      [len / n * 0.62, h * 0.56, thick * set.r(0.8, 1.2)], MAT.ROCK, th + set.r(-0.12, 0.12), { noise: 0.45, freq: 0.7, strata: 0.35, sfreq: 2.2, blocky: 0.85 }));
  }
}
function boulder(set, pos, size, m = MAT.ROCK) {
  set.add(PR.rock([pos[0], pos[1] + size * 0.45, pos[2]], [size * set.r(0.9, 1.3), size * set.r(0.6, 0.9), size * set.r(0.8, 1.2)], m, set.r(0, 3), { noise: 0.14, freq: 1.4 / size, strata: 0.06, sfreq: 6 }));
}
function hoodoo(set, pos, h) {
  set.obj().add(PR.hoodoo(pos, h, h * 0.22, h * 0.12, h * 0.26, h * 0.12, MAT.ROCK, set.r(0, 3)));
}
function fire(set, pos, big = false) {
  set.obj();
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; set.add(PR.sphere([pos[0] + Math.cos(a) * 0.55, 0.08, pos[2] + Math.sin(a) * 0.55], 0.13, MAT.STONE)); }
  set.add(PR.seg([pos[0] - 0.4, 0.1, pos[2] - 0.2], [pos[0] + 0.35, 0.18, pos[2] + 0.25], 0.07, MAT.WOOD));
  set.add(PR.seg([pos[0] + 0.3, 0.1, pos[2] - 0.3], [pos[0] - 0.3, 0.2, pos[2] + 0.3], 0.07, MAT.WOOD));
  set.add(PR.flame([pos[0], 0.12, pos[2]], big ? 0.32 : 0.24, big ? 1.0 : 0.7, pos[0] * 3.1));
  set.lights.push({ pos: [pos[0], 0.7, pos[2]], radius: big ? 4.5 : 3.6, power: 1.1, flicker: 1 });
}
function brazier(set, pos) {
  set.obj().add(PR.cone([pos[0], 0, pos[2]], 0.08, 0.3, 1.0, MAT.METAL), PR.cyl([pos[0], 1.05, pos[2]], 0.34, 0.08, MAT.METAL));
  if (isDim()) { set.add(PR.flame([pos[0], 1.1, pos[2]], 0.22, 0.6, pos[0])); set.lights.push({ pos: [pos[0], 1.6, pos[2]], radius: 4, power: 1, flicker: 1 }); }
}
function bannerPole(set, pos, h, m = MAT.BANNER, w = 0.7) {
  set.obj().add(PR.seg([pos[0], 0, pos[2]], [pos[0], h, pos[2]], 0.05, MAT.WOOD));
  const wind = Math.atan2(S.amb?.wind?.[1] ?? 0.4, S.amb?.wind?.[0] ?? 1);
  set.add(PR.banner([pos[0], h - 0.4, pos[2]], w, 0.32, 0.25, true, m, wind));
}
function ketCloths(set, pos, to) {
  // Keth cloths: strips knotted along a cord between two leaning poles
  set.obj().add(PR.seg([pos[0], 0, pos[2]], [pos[0] + 0.15, 2.7, pos[2]], 0.045, MAT.WOOD), PR.seg([to[0], 0, to[2]], [to[0] - 0.15, 2.4, to[2]], 0.045, MAT.WOOD));
  const a = [pos[0] + 0.15, 2.65, pos[2]], b = [to[0] - 0.15, 2.35, to[2]];
  set.add(PR.seg(a, [(a[0] + b[0]) / 2, 2.25, (a[2] + b[2]) / 2], 0.012, MAT.ROPE), PR.seg([(a[0] + b[0]) / 2, 2.25, (a[2] + b[2]) / 2], b, 0.012, MAT.ROPE));
  const yaw = Math.atan2(b[2] - a[2], b[0] - a[0]);
  for (let i = 1; i < 8; i++) {
    const f = i / 8, sag = 0.4 * Math.sin(f * Math.PI);
    set.add(PR.banner([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f - sag - 0.2, a[2] + (b[2] - a[2]) * f], 0.13, 0.2, 0.12, false, i % 3 ? MAT.KETH : MAT.CLOTH, yaw));
  }
}
function tent(set, pos, yaw, size = 1) {
  set.obj().add(PR.prism([pos[0], 0.9 * size, pos[2]], 1.8 * size, 1.6 * size, MAT.CLOTH, yaw));
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const k of [-1, 1]) {
    const ax = pos[0] - s * k * 1.7 * size, az = pos[2] + c * k * 1.7 * size;
    set.add(PR.seg([pos[0] - s * k * 1.55 * size, 1.75 * size, pos[2] + c * k * 1.55 * size], [ax - s * k * 0.9, 0, az + c * k * 0.9], 0.012, MAT.ROPE));
  }
}
function cask(set, pos, r = 0.42, h = 0.56) {
  set.add(PR.cyl([pos[0], h, pos[2]], r, h, MAT.WOOD), PR.torus([pos[0], h * 0.45, pos[2]], r + 0.01, 0.025, 0, MAT.METAL), PR.torus([pos[0], h * 1.55, pos[2]], r + 0.01, 0.025, 0, MAT.METAL));
}
function waystone(set, pos, h) {
  set.obj().add(PR.rock([pos[0], h * 0.48, pos[2]], [0.45, h * 0.52, 0.32], MAT.STONE, set.r(0, 3), { noise: 0.04, freq: 3, strata: 0.03, sfreq: 9 }));
  set.add(PR.box([pos[0], h + 0.05, pos[2]], [0.55, 0.08, 0.4], MAT.STONE, set.r(0, 3), 0.03));
  set.add(PR.box([pos[0], h * 0.7, pos[2]], [0.47, 0.04, 0.34], MAT.EXIT, 0, 0.02));
}
function crawler(set, at, yaw, cond) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const L = (x, y, z) => [at[0] + c * x - s * z, at[1] + y, at[2] + s * x + c * z];
  set.obj();
  if (cond !== 'side') {
    const k = cond === 'dead' ? 0.75 : 0;
    set.add(PR.box(L(0, 2.0 - k, 0), [6, 0.95, 1.9], MAT.METAL, yaw, 0.35));
    if (cond === 'dead') set.add(PR.sub(PR.box(L(-1.6, 2.9 - k, 0.4), [2.4, 0.5, 1.2], 0, yaw)));
    set.add(PR.box(L(-0.6, 3.02 - k, 0), [4.6, 0.12, 1.7], MAT.METAL, yaw));
    if (cond !== 'dead') {
      set.add(PR.capsule(L(-1.6, 3.6, 0.85), 0.62, 2.0, MAT.METAL, true, yaw), PR.capsule(L(-1.6, 3.6, -0.85), 0.62, 2.0, MAT.METAL, true, yaw));
    } else {
      set.add(PR.ribs(L(-1.6, 2.1 - k, 0), 6, 0.9, 1.9, 0.07, 0.2, 0, MAT.METAL, yaw));
      set.add(PR.capsule(L(-4.2, 0.5, 3.2), 0.55, 1.6, MAT.METAL, true, yaw + 0.5));
    }
    set.add(PR.box(L(4.5, 3.4 - k, 0), [1.3, 0.85, 1.55], MAT.METAL, yaw, 0.25));
    set.add(PR.box(L(5.79, 3.55 - k, 0), [0.06, 0.16, 1.2], cond === 'parked' && isDim() ? MAT.LAMP : MAT.DARK, yaw, 0.02));
    for (const zz of [-2.05, 2.05]) {
      set.add(PR.box(L(0, 0.95 - k, zz), [6.3, 0.85, 0.42], MAT.DARK, yaw, 0.4));
      for (const xx of [-4.6, -2.3, 0, 2.3, 4.6]) set.add(PR.torus(L(xx, 0.95 - k, zz + Math.sign(zz) * 0.45), 0.52, 0.1, 2, MAT.METAL, yaw));
    }
    set.add(PR.seg(L(3.4, 3.9 - k, 0.6), L(3.4, 5.2 - k, 0.6), 0.12, MAT.METAL));
    set.add(PR.seg(L(-4.8, 3.1 - k, 0), L(-4.8, 6.4 - k, 0), 0.06, MAT.METAL));
    if (cond === 'parked') {
      set.add(PR.sphere(L(-4.8, 6.45, 0), 0.13, isDim() ? MAT.LAMP : MAT.METAL));
      if (isDim()) set.lights.push({ pos: L(-4.8, 6.3, 0), radius: 7, power: 0.8, flicker: 0 });
      const wind = Math.atan2(S.amb?.wind?.[1] ?? 0.4, S.amb?.wind?.[0] ?? 1);
      set.add(PR.banner(L(-4.8, 6.0, 0), 0.7, 0.3, 0.25, true, MAT.BANNER, wind));
      for (let i = 0; i < 3; i++) set.add(PR.box(L(-6.4 + i * 0.32, 0.22 + i * 0.4, 0), [0.3, 0.2 + i * 0.2, 1.0], MAT.METAL, yaw, 0.04));
    } else {
      set.obj();
      for (const zz of [-3.6, 3.4]) set.add(PR.rock(L(set.r(-2, 2), 0.25, zz), [3.8, 0.9, 1.5], MAT.SAND, yaw + set.r(-0.2, 0.2), { noise: 0.04, freq: 1, strata: 0, sfreq: 1 }));
    }
  } else {
    // on its side and broken across the back, half sunk, the ribs of it showing
    // fore half: the cab end, still whole
    set.add(PR.box(L(3.2, 1.0, 0), [2.8, 1.9, 0.95], MAT.METAL, yaw, 0.35));
    set.add(PR.box(L(3.4, 3.05, 1.05), [3.0, 0.42, 0.85], MAT.DARK, yaw, 0.35));
    for (const xx of [1.4, 3.4, 5.4]) set.add(PR.torus(L(xx, 3.5, 1.05), 0.52, 0.1, 0, MAT.METAL, yaw));
    set.add(PR.box(L(5.0, 1.1, -1.45), [1.3, 1.5, 0.8], MAT.METAL, yaw, 0.25), PR.box(L(6.32, 1.5, -1.45), [0.05, 0.75, 0.55], MAT.DARK, yaw, 0.02));
    set.add(PR.sub(PR.box(L(2.4, 2.2, 0.95), [1.1, 0.75, 0.5], 0, yaw)), PR.sub(PR.sphere(L(4.6, 2.5, -1.4), 0.75, 0)));
    // aft half, twisted off and sunk deeper, its skin peeled back
    const y2 = yaw + 0.42, c2 = Math.cos(y2), s2 = Math.sin(y2), o2 = L(-1.4, 0, 0.6);
    const L2 = (x, y, z) => [o2[0] + c2 * x - s2 * z, y, o2[2] + s2 * x + c2 * z];
    set.obj().add(PR.box(L2(-2.6, 0.55, 0), [2.4, 1.9, 0.95], MAT.METAL, y2, 0.35), PR.box(L2(-2.6, 2.55, 1.05), [2.6, 0.42, 0.85], MAT.DARK, y2, 0.35));
    for (const xx of [-4.2, -1.9]) set.add(PR.torus(L2(xx, 3.0, 1.05), 0.52, 0.1, 0, MAT.METAL, y2));
    set.add(PR.sub(PR.box(L2(-1.0, 1.7, 0.2), [1.6, 1.6, 1.4], 0, y2)));
    set.obj().add(PR.ribs(L2(-1.2, 0.6, 0), 4, 0.7, 1.75, 0.07, 0.15, Math.PI / 2, MAT.METAL, y2));
    // the ribs across the break, and what spilled out of it
    set.obj().add(PR.ribs(L(-0.2, 0.9, 0.2), 3, 0.75, 1.8, 0.08, 0.2, Math.PI / 2, MAT.METAL, yaw + 0.2));
    set.add(PR.seg(L(0.6, 2.6, 0.9), L(-2.2, 0.0, 3.6), 0.035, MAT.ROPE), PR.seg(L(0.4, 1.8, 0.9), L(-0.8, 0.0, 3.0), 0.03, MAT.ROPE));
    set.obj().add(PR.capsule(L(-3.6, 0.42, -4.6), 0.6, 1.8, MAT.METAL, true, yaw + 0.7), PR.seg(L(5.6, 2.6, -1.6), L(9.6, 0.1, -3.4), 0.07, MAT.METAL));
    set.add(PR.torus(L(-7.6, 0.7, 2.6), 0.52, 0.1, 1, MAT.METAL, yaw + 1.1), PR.box(L(1.6, 0.1, 3.4), [0.8, 0.05, 0.5], MAT.METAL, yaw + 0.6, 0.02), PR.box(L(-4.8, 0.15, -2.6), [0.6, 0.08, 0.9], MAT.METAL, yaw - 0.5, 0.02));
    set.add(PR.shards(L(0.0, 0, -2.6), 5, 2.2, 0.8, 0.4, MAT.LAMP, true, yaw));
    set.obj();
    for (const [xx, zz, l] of [[3.2, -2.4, 3.4], [-3.0, 2.8, 3.0], [-4.4, -2.2, 2.6]]) set.add(PR.rock(L(xx, 0.25, zz), [l, 0.85, 1.4], MAT.SAND, yaw + set.r(-0.2, 0.2), { noise: 0.04, freq: 1, strata: 0, sfreq: 1, blocky: 0 }));
  }
}
function farHold(set, pos, scale = 1) {
  // the Hold in its gap, seen from far away
  set.obj();
  const [x, y, z] = pos;
  set.add(PR.box([x, y + 2.5 * scale, z], [5 * scale, 2.5 * scale, 3 * scale], MAT.STONE, 0, 0.1));
  set.add(PR.cyl([x + 4 * scale, y + 4 * scale, z], 1.4 * scale, 4 * scale, MAT.STONE));
  cliffLine(set, [x - 90, z + 10], [x - 7 * scale, z], 22 * scale, 9, y);
  cliffLine(set, [x + 7 * scale, z], [x + 90, z + 10], 22 * scale, 9, y);
}
function farRidge(set, pos) {
  cliffLine(set, [pos[0] - 26, pos[2]], [pos[0] + 26, pos[2] - 3], 15, 6, pos[1]);
  set.obj().add(PR.hoodoo([pos[0] - 18, pos[1], pos[2] + 3], 9, 2, 1.1, 2.4, 1, MAT.ROCK), PR.hoodoo([pos[0] + 14, pos[1], pos[2] + 2], 7, 1.6, 0.9, 1.9, 0.9, MAT.ROCK));
}

// ---- the places
const SETS = {
  hold(set) {
    // Scar Gate's hall, cut away like a stage: a cracked cistern under the floor, a map nobody trusts
    Object.assign(set.terr, { t0: [0.6, 22, 0, MAT.SAND] });
    set.cam = { target: [0, 1.5, -3.0], dist: 12.5, pitch: 0.24, yaw: 0, maxDist: 26 };
    set.lines = false; set.dust = 1.0; set.shimmer = 0.05; set.indoor = true; set.sunAz = 0.12; set.sunElev = 0.95;
    set.obj().add(PR.box([0, 0.04, -3], [9, 0.05, 5.4], MAT.FLOOR, 0, 0.01), PR.sub(PR.cyl([-3.2, 0.05, -3.5], 1.0, 0.2, 0)));
    set.obj().add(PR.box([0, 2.5, -8.4], [9.6, 2.5, 0.45], MAT.STONE, 0, 0.03));
    for (const x of [-5.2, 5.2]) set.add(PR.sub(PR.box([x, 3.1, -8.4], [0.32, 1.0, 0.8], 0)));
    set.add(PR.sub(PR.box([0, 1.4, -8.4], [1.15, 1.4, 0.8], 0)), PR.sub(PR.sphere([0, 2.75, -8.4], 1.15, 0)));
    set.windows = [[-5.2, 3.1, -8.4], [5.2, 3.1, -8.4], [0, 1.8, -8.4]];
    for (const sx of [-1, 1]) set.obj().add(PR.box([sx * 9.4, 2.5, -3.2], [0.45, 2.5, 5.6], MAT.STONE, 0, 0.03));
    set.obj();
    for (let z = -7.6; z <= 1.6; z += 1.53) set.add(PR.box([0, 5.0, z], [9.8, 0.14, 0.18], MAT.WOOD, 0, 0.03));
    set.add(PR.box([0, 5.25, -6.9], [9.8, 0.12, 1.6], MAT.WOOD, 0, 0.02));
    set.obj();
    for (const [x, z] of [[-4.6, -5.6], [4.6, -5.6], [-4.6, -1.2], [4.6, -1.2]]) set.add(PR.cyl([x, 2.5, z], 0.32, 2.5, MAT.STONE), PR.box([x, 4.88, z], [0.5, 0.12, 0.5], MAT.STONE, 0, 0.03));
    set.obj().add(PR.box([2.7, 0.86, -3.2], [1.4, 0.07, 0.9], MAT.WOOD, 0, 0.02), PR.box([2.7, 0.94, -3.2], [1.22, 0.01, 0.76], MAT.BONE, 0.04, 0.005));
    for (const [x, z] of [[1.4, -2.4], [4.0, -2.4], [1.4, -4.0], [4.0, -4.0]]) set.add(PR.seg([x, 0, z], [x, 0.82, z], 0.05, MAT.WOOD));
    for (let i = 0; i < 5; i++) set.add(PR.cyl([2.0 + set.r(0, 1.4), 1.0, -3.6 + set.r(0, 0.9)], 0.04, 0.05, MAT.BRASS));
    set.obj().add(PR.well([-3.2, 0, -3.5], 1.32, 1.0, 0.32, MAT.STONE), PR.cyl([-3.2, 0.02, -3.5], 1.0, 0.03, MAT.WATER));
    set.add(PR.seg([-4.4, 0.3, -4.5], [-4.4, 2.0, -4.5], 0.06, MAT.WOOD), PR.seg([-2.0, 0.3, -4.5], [-2.0, 2.0, -4.5], 0.06, MAT.WOOD), PR.seg([-4.5, 2.0, -4.5], [-1.9, 2.0, -4.5], 0.06, MAT.WOOD));
    set.add(PR.box([-3.2, 1.6, -4.44], [0.28, 0.34, 0.01], MAT.BONE, 0.05, 0.004));
    set.obj();
    for (const x of [-1.4, -0.7]) set.add(PR.ellipsoid([x, 0.62, -5.0], [0.3, 0.62, 0.3], MAT.STONE), PR.cyl([x, 1.25, -5.0], 0.12, 0.06, MAT.TARP));
    cask(set, [-5.3, 0, -2.3], 0.45, 0.6);
    set.obj().add(PR.seg([5.6, 0, -1.6], [5.6, 1.15, -1.6], 0.05, MAT.WOOD), PR.box([5.6, 1.22, -1.6], [0.36, 0.05, 0.26], MAT.WOOD, 0.3, 0.02), PR.box([5.6, 1.29, -1.6], [0.3, 0.01, 0.2], MAT.BONE, 0.3, 0.004));
    for (const x of [-7, 7]) set.obj().add(PR.banner([x, 3.4, -7.85], 0.62, 1.4, 0.05, false, MAT.BANNER));
    set.obj().add(PR.box([-7.2, 0.22, -6.9], [1.2, 0.22, 0.35], MAT.WOOD, 0, 0.03));
    brazier(set, [-6.6, 0, -5.4]); brazier(set, [6.6, 0, -5.4]);
    cliffLine(set, [-12.5, -24], [-12.5, 12], 15, 5); cliffLine(set, [12.5, -24], [12.5, 12], 15, 5);
    cliffLine(set, [-11, -22], [11, -22], 16, 4);
    set.spots.you = { p: [0, -0.4], y: 0 };
    set.spots.stand = [[-1.8, -2.0], [1.4, -0.9], [4.0, -5.4], [-5.0, -5.2], [0.4, -5.0]].map((p) => ({ p, y: 0 }));
    set.spots.shade = [[6.8, -2.6], [-7.2, -3.8]].map((p) => ({ p, y: 0 }));
    set.spots.overlook = [{ p: [2.3, -1.9], y: 0, face: [2.7, -3.2] }];
    set.spots.sit = [{ p: [-7.2, -6.6], y: 0.44 }];
    set.spots.work = [[-3.2, -2.3], [-1.0, -4.2], [-5.0, -1.6]].map((p) => ({ p, y: 0 }));
    set.spots.items = [[1.0, -6.4], [-1.6, -6.6], [6.2, -4.0]].map((p) => ({ p, y: 0 }));
    set.anchors = [
      { re: /cistern/i, p: [-3.2, -3.5], tagH: 1.0, pickR: 1.3 }, { re: /writ/i, p: [5.6, -1.6], tagH: 1.8 },
      { re: /notice/i, p: [-3.2, -4.5], tagH: 2.4 }, { re: /keth jars/i, p: [-1.05, -5.0], tagH: 1.9 }, { re: /ration cask/i, p: [-5.3, -2.3], tagH: 1.7 },
    ];
    set.exitAt = [{ re: /gate yard/i, p: [0, -7.6] }];
  },

  yard(set) {
    // packed sand inside the gate, a ring scratched in it by old law, guards drilling in the wall's shade
    Object.assign(set.terr, { t0: [0.5, 20, 0, MAT.SAND], t4: [4.6, 0, 0, 0] });
    set.cam = { target: [0, 1.5, -3], dist: 19, pitch: 0.3, yaw: 0.15, maxDist: 30 };
    set.lines = false; set.dust = 0.8;
    set.obj().add(PR.wall([0, 1.6, -13], [13, 1.6, 0.5], 1.2, 0.5, MAT.STONE), PR.sub(PR.box([0, 1.4, -13], [1.4, 1.4, 0.8], 0)));
    for (const sx of [-1, 1]) set.obj().add(PR.wall([sx * 13, 1.6, -3], [10.5, 1.6, 0.5], 1.2, 0.5, MAT.STONE, Math.PI / 2));
    set.obj().add(PR.wall([-10.5, 1.6, 7.4], [2.5, 1.6, 0.5], 1.2, 0.5, MAT.STONE), PR.sub(PR.box([-10, 1.2, 7.4], [0.8, 1.2, 0.8], 0)));
    set.obj();
    for (const sx of [-1, 1]) set.add(PR.cyl([sx * 2.6, 2.7, -13], 1.3, 2.7, MAT.STONE), PR.box([sx * 1.1, 1.4, -12.5], [0.85, 1.35, 0.08], MAT.WOOD, sx * 0.5, 0.02));
    set.add(PR.box([0, 3.35, -13], [2.4, 0.55, 0.6], MAT.STONE, 0, 0.04));
    for (const sx of [-1, 1]) bannerPole(set, [sx * 2.6, 0, -13.9], 7.2);
    set.obj();
    for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2; set.add(PR.sphere([Math.cos(a) * 4.85, 0.05, Math.sin(a) * 4.85], 0.12, MAT.STONE)); }
    set.obj().add(PR.sail([-10.8, 2.9, -4], 2.0, 5.2, 0.3, 0.08, MAT.CLOTH));
    for (const z of [-9, 1]) set.add(PR.seg([-8.8, 0, z], [-8.8, 2.9, z], 0.05, MAT.WOOD));
    set.obj().add(PR.box([-11.3, 0.22, -5.5], [0.35, 0.22, 1.4], MAT.WOOD, 0, 0.03));
    set.obj().add(PR.seg([10.6, 0, -7.2], [10.6, 1.4, -7.2], 0.06, MAT.WOOD), PR.seg([10.6, 0, -4.8], [10.6, 1.4, -4.8], 0.06, MAT.WOOD), PR.seg([10.6, 1.3, -7.3], [10.6, 1.3, -4.7], 0.05, MAT.WOOD));
    for (let i = 0; i < 6; i++) set.add(PR.seg([10.45, 0.05, -7 + i * 0.42], [10.75, 1.35, -6.9 + i * 0.42], 0.035, MAT.WOOD));
    set.obj();
    for (const x of [6, 8.2]) set.add(PR.cyl([x, 1.0, -9.6], 0.13, 1.0, MAT.WOOD), PR.seg([x - 0.5, 1.5, -9.6], [x + 0.5, 1.45, -9.6], 0.05, MAT.WOOD));
    set.obj().add(PR.box([-11.2, 0.4, 3.2], [0.6, 0.4, 1.6], MAT.STONE, 0, 0.05), PR.box([-11.2, 0.72, 3.2], [0.45, 0.05, 1.45], MAT.WATER, 0, 0.01));
    set.obj(); cask(set, [11, 0, 3.8]); cask(set, [11.2, 0, 2.8]); set.add(PR.box([10.2, 0.4, 4.6], [0.4, 0.4, 0.4], MAT.WOOD, 0.3, 0.03));
    set.obj();
    for (let i = 0; i < 5; i++) set.add(PR.box([12.0 - i * 0.0, 0.32 + i * 0.64, 4.5 - i * 0.9], [0.45, 0.32 + i * 0.32, 0.45], MAT.STONE, 0, 0.02));
    brazier(set, [-3.2, 0, -12]); brazier(set, [3.2, 0, -12]);
    cliffLine(set, [-19, -30], [-19, 14], 16, 6); cliffLine(set, [19, -30], [19, 14], 16, 6);
    set.spots.you = { p: [0, 5.6], y: 0 };
    set.spots.drill = [[-2.4, -1.4], [2.4, -1.4], [0, -3.6], [-2.8, 1.6], [2.8, 1.6]].map((p) => ({ p, y: 0, face: [0, 0] }));
    set.spots.patrol = [[-11, -11], [11, -11], [11, 5], [-11, 5]];
    set.spots.overlook = [{ p: [5.8, 1.6], y: 0, face: [0, 0] }];
    set.spots.shade = [[-10.4, -2.6], [-10.4, -6.4]].map((p) => ({ p, y: 0, face: [0, 0] }));
    set.spots.sit = [{ p: [-11.3, -5.1], y: 0.44, face: [0, -1] }];
    set.spots.stand = [[-5.2, 3.4], [4.2, 4.6], [7.4, -2.2], [-6.4, -8.4], [6.4, -10.2]].map((p) => ({ p, y: 0 }));
    set.spots.items = [[8.6, -6], [-7.6, 2.8]].map((p) => ({ p, y: 0 }));
    set.anchors = [{ re: /rack/i, p: [10.6, -6], tagH: 1.9 }];
    set.exitAt = [{ re: /salt road/i, p: [0, -14.6] }, { re: /hold/i, p: [-10, 8.2] }];
  },

  road(set) {
    // white with salt, running north between the Scar and the glass; convoy ruts, a dead crawler, wind
    Object.assign(set.terr, { t0: [1.6, 7, 14, MAT.SAND], t1: [0, 0, 2.2, 0.06], t3: [0, 0, 1, 0], t4: [0, 1, 1, 0] });
    set.cam = { target: [0, 1.5, -3], dist: 20, pitch: 0.23, yaw: 0.28, maxDist: 36 };
    set.dust = 1.2; set.shimmer = 0.7;
    cliffLine(set, [17, -70], [17, -20], 20, 7); cliffLine(set, [17, -22], [16, 30], 18, 7);
    set.obj(); for (let i = 0; i < 6; i++) boulder(set, [14 + set.r(-1, 1.5), 0, -40 + i * 12 + set.r(-3, 3)], set.r(0.8, 1.8));
    crawler(set, [-7.5, 0, -7], 0.38, 'dead');
    for (const z of [-26, -9, 9, 26]) waystone(set, [(z % 2 ? 1 : -1) * 3.4 + z * 0.06, 0, z], 2.3);
    set.obj();
    for (const [x, z] of [[4.2, -15], [-4.6, 15], [4.8, 3.5]]) for (let k = 0; k < 3; k++) set.add(PR.sphere([x, 0.22 + k * 0.32, z], 0.36 - k * 0.09, MAT.SALT));
    set.obj().add(PR.torus([-3.4, 0.3, 2.4], 0.62, 0.07, 1, MAT.WOOD, 0.9), PR.capsule([-4.8, 0.36, 4.2], 0.36, 0.5, MAT.WOOD, true, 1.2));
    set.obj().add(PR.flock([-7.5, 11, -7], 5, 4, 0.35, 0.55));
    set.shafts.push({ a: [-34, 0, -28], b: [-34, 16, -28], r: 1.6, power: -0.5, wander: 0.04 });
    set.spots.you = { p: [0.2, 5.2], y: 0 };
    set.spots.stand = [[2.2, -1.2], [-2.4, -3.4], [1.4, -6.4], [-1.0, 2.0], [3.0, 2.6]].map((p) => ({ p, y: 0 }));
    set.spots.lookout = [{ p: [3.2, -10.5], y: 0 }];
    set.spots.sit = [{ p: [-4.8, 4.2], y: 0.62 }];
    set.spots.items = [[-2.0, -1.5], [2.6, 0.6]].map((p) => ({ p, y: 0 }));
  },

  landing(set) {
    // hard pan where the Guild's crawlers put down: casks under tarps, a tally post, a woman with a ledger
    Object.assign(set.terr, { t0: [0.8, 16, 12, MAT.PAN], t4: [0, 0, 1, 0] });
    set.cam = { target: [0, 1.5, -4], dist: 20, pitch: 0.26, yaw: 0.22, maxDist: 36 };
    set.dust = 0.9; set.shimmer = 0.6;
    crawler(set, [6.5, 0, -12], -0.32, 'parked');
    set.obj().add(PR.sail([-5, 1.62, -5], 2.3, 1.7, 0.38, 0.05, MAT.TARP));
    for (const [x, z] of [[-7.2, -6.6], [-2.8, -6.6], [-7.2, -3.4], [-2.8, -3.4]]) set.add(PR.seg([x, 0, z], [x, 1.55, z], 0.04, MAT.WOOD));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) cask(set, [-6.2 + i * 1.0, 0, -5.6 + j * 1.15]);
    set.obj(); cask(set, [-1.8, 0, -3.0]); cask(set, [-1.2, 0, -2.2]);
    set.obj().add(PR.cyl([-1.5, 1.65, -7.6], 0.11, 1.65, MAT.WOOD), PR.seg([-2.2, 2.9, -7.6], [-0.8, 2.9, -7.6], 0.05, MAT.WOOD));
    for (let i = 0; i < 5; i++) set.add(PR.box([-2.0 + i * 0.25, 2.62 - (i % 2) * 0.12, -7.55], [0.07, 0.14, 0.01], MAT.BONE, 0, 0.004));
    set.add(PR.box([-1.5, 1.4, -7.48], [0.32, 0.42, 0.02], MAT.DARK, 0, 0.01));
    tent(set, [-11, 0, -12], 0.5, 1.1); tent(set, [-14, 0, -5.5], 1.4); tent(set, [12, 0, 1.5], -0.8, 0.95);
    set.obj().add(PR.box([2.2, 0.26, -2.8], [1.4, 0.16, 0.6], MAT.WOOD, 0.2, 0.03), PR.seg([0.7, 0.06, -2.1], [3.7, 0.06, -2.5], 0.05, MAT.WOOD), PR.seg([0.6, 0.06, -3.3], [3.6, 0.06, -3.7], 0.05, MAT.WOOD));
    bannerPole(set, [0.5, 0, -14], 6.2);
    if (isDim()) fire(set, [-7, 0, 2.4]); else set.obj().add(PR.cyl([-7, 0.04, 2.4], 0.6, 0.04, MAT.DARK));
    set.obj().add(PR.seg([-8.3, 0.18, 3.4], [-6.5, 0.18, 3.6], 0.16, MAT.WOOD));
    set.spots.you = { p: [0, 5], y: 0 };
    set.spots.work = [[-3.6, -3.4], [-1.5, -6.7], [3.0, -8.6], [-6.8, -2.9]].map((p) => ({ p, y: 0 }));
    set.spots.stand = [[2.0, 0.4], [-3.0, 1.2], [4.2, -4.2], [-8.4, -8.4], [6.0, 3.0]].map((p) => ({ p, y: 0 }));
    set.spots.sit = [{ p: [-7.4, 3.5], y: 0.34, face: [-7, 2.4] }];
    set.spots.lookout = [{ p: [8.4, -2.4], y: 0 }];
    set.spots.items = [[1.0, -1.0], [-2.6, -0.6]].map((p) => ({ p, y: 0 }));
    set.anchors = [{ re: /water casks/i, p: [-5, -5], tagH: 2.3, pickR: 2 }, { re: /tally post/i, p: [-1.5, -7.6], tagH: 3.5 }];
  },

  flats(set, st) {
    // black glass underfoot, red dunes walking across it, veins of dull red where the dunes have pulled back
    const tremor = Number(set.here.state?.tremor || 0);
    Object.assign(set.terr, { t0: [2.3, 8, 10, MAT.GLASS], t1: [1, 0, 0, 0], t2: [0.5 + tremor * 0.35, 0, 0, 0], t4: [0, 0, 1, 0] });
    set.cam = { target: [0, 1.2, -3], dist: 18, pitch: 0.18, yaw: 0, maxDist: 36 };
    set.shimmer = 1.0; set.dust = 0.9;
    set.obj().add(PR.shards([-3, 0, -4], 2.0, 0.9, 0.3, 0.7, MAT.EMBER, false, 0.4));
    set.lights.push({ pos: [-3, 0.5, -4], radius: 3.6, power: 0.8, flicker: 0.25 });
    set.obj().add(PR.shards([5, 0, -9], 1.2, 0.5, 0.32, 0.45, MAT.EMBER, false, -0.3));
    set.lights.push({ pos: [5, 0.5, -9], radius: 3, power: 0.6, flicker: 0.25 });
    for (let i = 0; i < 7; i++) { const a = set.r(0, Math.PI * 2), r = set.r(10, 26); set.obj().add(PR.cone([Math.cos(a) * r, 0, Math.sin(a) * r], set.r(0.25, 0.5), 0.02, set.r(1.4, 4.2), MAT.GLASS)); }
    // red dunes walking across the glass: crescents, horns downwind, the slip face carved out of the lee
    const wa = Math.atan2(0.38, 0.92), wc = Math.cos(wa), ws = Math.sin(wa);
    for (const [x, z, l, w, h] of [[-12, -13, 4.2, 4.6, 1.6], [9, -19, 5, 5.4, 2.0], [-2, -27, 6, 6.5, 2.5], [16, -6, 3.4, 3.6, 1.2]]) {
      set.obj().add(PR.rock([x, 0, z], [l, h, w], MAT.SAND, wa, { noise: 0.04, freq: 0.6, strata: 0, sfreq: 1, blocky: 0 }));
      set.add(PR.sub(PR.ellipsoid([x + wc * l * 0.95, 0, z + ws * l * 0.95], [l * 0.9, h * 1.7, w * 0.72], 0, wa)));
    }
    farRidge(set, [0, 0, -78]);
    set.shafts.push({ a: [-22, 0, -30], b: [-22, 14, -30], r: 1.4, power: -0.55, wander: 0.05 });
    set.shafts.push({ a: [28, 0, -14], b: [28, 10, -14], r: 1.0, power: -0.4, wander: 0.07 });
    set.spots.you = { p: [0, 5], y: 0 };
    set.spots.stand = [[2.0, 0.2], [-2.6, -1.2], [4.0, -5.0], [-5.2, -7.0], [1.0, -8.0]].map((p) => ({ p, y: 0 }));
    set.spots.work = [[-3.0, -2.9], [5.0, -8.1]].map((p) => ({ p, y: 0, kneel: true }));
    set.spots.lookout = [{ p: [7.2, -3.2], y: 0 }];
    set.spots.items = [[-1.2, -2.2], [3.0, -2.4]].map((p) => ({ p, y: 0 }));
    set.anchors = [{ re: /red vein/i, p: [-3, -4], tagH: 1.2, pickR: 1.6 }, { re: /second vein/i, p: [5, -9], tagH: 1.2, pickR: 1.4 }];
  },

  ridge(set) {
    // a spine of red rock standing out of the glass: shade, a view of everything, goat sign on the stone
    Object.assign(set.terr, { t0: [2.0, 30, 12, MAT.ROCK], t1: [0, 0, 0, 0], t2: [0, 18, 11.5, 0] });
    set.cam = { target: [0, 1.2, 6.5], dist: 11.5, pitch: 0.3, yaw: Math.PI, maxDist: 24 };
    set.exitR = 10; set.shimmer = 0.6; set.dust = 0.7; set.lines = false;
    set.landmark = [0, -12, 95];
    set.obj();
    for (let i = 0; i < 5; i++) set.add(PR.rock([-8.6 - set.r(0, 2), set.r(1.2, 2.8), -6 + i * 3.4], [2.2, set.r(1.8, 3.4), 1.9], MAT.ROCK, set.r(-0.3, 0.3), { noise: 0.3, freq: 0.6, strata: 0.3, sfreq: 3.0, blocky: 0.75 }));
    set.obj();
    for (let i = 0; i < 4; i++) set.add(PR.rock([8.6 + set.r(0, 2), set.r(1.4, 3.0), -5 + i * 3.4], [2.2, set.r(2.0, 3.6), 1.9], MAT.ROCK, set.r(-0.3, 0.3), { noise: 0.3, freq: 0.6, strata: 0.3, sfreq: 3.0, blocky: 0.75 }));
    set.obj().add(PR.arch([8.0, 0, 3.4], 2.6, 0.7, 1.4, MAT.ROCK, Math.PI / 2));
    set.obj().add(PR.box([0.6, 1.15, 6.2], [1.4, 1.15, 1.0], MAT.ROCK, 0.15, 0.4), PR.rock([0.6, 0.9, 6.2], [1.9, 1.2, 1.4], MAT.ROCK, 0.2, { noise: 0.2, freq: 0.9, strata: 0.2, sfreq: 4, blocky: 0.7 }));
    hoodoo(set, [-6.0, 0, 8.2], 4.6); hoodoo(set, [5.4, 0, 9.0], 3.4);
    ketCloths(set, [-4.4, 0, 3.4], [-1.4, 0, 5.2]);
    if (isDim()) fire(set, [-1.4, 0, 1.6]); else set.obj().add(PR.cyl([-1.4, 0.04, 1.6], 0.6, 0.04, MAT.DARK));
    // the cleft that goes down to the Deepwell
    set.obj().add(PR.rock([-7.0, 1.4, 5.0], [1.4, 1.6, 1.0], MAT.ROCK, 0.4, { noise: 0.2, freq: 0.8, strata: 0.16, sfreq: 3.5 }), PR.rock([-5.0, 1.2, 6.0], [1.3, 1.4, 1.1], MAT.ROCK, -0.3, { noise: 0.2, freq: 0.8, strata: 0.16, sfreq: 3.5 }), PR.box([-6.0, 1.0, 5.5], [0.35, 1.0, 0.7], MAT.DARK, 0.4, 0.1));
    set.obj().add(PR.sphere([5.9, 2.15, -1.1], 0.16, MAT.BONE), PR.seg([5.85, 2.25, -1.1], [5.7, 2.55, -1.35], 0.035, MAT.BONE, 0.015), PR.seg([5.95, 2.25, -1.1], [6.1, 2.55, -1.35], 0.035, MAT.BONE, 0.015), PR.box([5.9, 1.0, -1.1], [0.6, 1.0, 0.6], MAT.ROCK, 0.3, 0.25));
    farHold(set, [0, -18, 150], 0.8);
    set.spots.you = { p: [1.0, 1.4], y: 0, face: [0, 95] };
    set.spots.sit = [{ p: [0.6, 6.2], y: 2.3, face: [0, 95] }, { p: [-2.9, 2.2], y: 0, face: [-1.4, 1.6] }];
    set.spots.lookout = [{ p: [-2.6, 7.0], y: 0, face: [0, 95] }, { p: [3.6, 7.6], y: 0, face: [0, 95] }];
    set.spots.stand = [[-3.8, 0.2], [2.8, 0.6], [4.6, 3.0], [2.8, 4.4], [-5.8, 2.4]].map((p) => ({ p, y: 0 }));
    set.spots.shade = [{ p: [7.6, 3.4], y: 0 }];
    set.spots.items = [[-0.6, 4.0], [3.4, 2.0]].map((p) => ({ p, y: 0 }));
    set.exitAt = [{ re: /deepwell/i, p: [-5.4, 4.2] }, { re: /glass flats/i, p: [6.4, 6.8] }];
  },

  deepwell(set) {
    // a cavern under the ridge where the rock sweats water into a black pool; cups on cords, a cookfire
    Object.assign(set.terr, { t0: [0, 30, 0, MAT.CAVE], t3: [1, 6.6, 0, 12.5] });
    set.cam = { target: [0, 1.5, 0], dist: 8.8, pitch: 0.2, yaw: 0.35, maxDist: 9.5 };
    set.cave = true; set.indoor = true; set.lines = false; set.dust = 1.2; set.shimmer = 0; set.exitR = 10;
    set.shafts.push({ a: [2.0, 6.7, -1.2], b: [2.5, 0, -0.6], r: 0.9, power: 0.7, hole: true });
    set.obj().add(PR.cyl([2.3, 0.03, -0.7], 3.0, 0.035, MAT.WATER));
    for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; set.add(PR.sphere([2.3 + Math.cos(a) * 3.1, 0.06, -0.7 + Math.sin(a) * 3.1], set.r(0.16, 0.3), MAT.CAVE)); }
    set.obj().add(PR.cyl([-3.5, 0.32, -2.4], 0.2, 0.32, MAT.STONE), PR.well([-3.5, 0.62, -2.4], 0.14, 0.1, 0.08, MAT.STONE), PR.box([-3.5, 0.22, -3.1], [0.45, 0.22, 0.4], MAT.STONE, 0.2, 0.08));
    set.dyn.push((t) => { const k = (t * 0.45) % 1; return [PR.sphere([-3.5, 6.4 - k * k * 5.7, -2.4], 0.04, MAT.WATER)]; });
    set.obj();
    for (let i = 0; i < 16; i++) {
      const a = -2.1 + i * 0.16, r = 10.6, x = Math.cos(a) * r, z = Math.sin(a) * r, y = 2.2 + set.r(0, 1.3);
      set.add(PR.seg([x, 6.6, z], [x, y + 0.14, z], 0.01, MAT.ROPE), PR.cyl([x, y, z], 0.09, 0.1, MAT.STONE));
    }
    fire(set, [3.6, 0, 4.0], true);
    set.obj();
    for (let i = 0; i < 9; i++) { const a = set.r(0, Math.PI * 2), r = set.r(2, 11); set.add(PR.cone([Math.cos(a) * r, 6.6 - set.r(0.8, 1.8), Math.sin(a) * r], 0.02, set.r(0.15, 0.35), set.r(0.8, 1.8), MAT.CAVE)); }
    set.obj();
    for (let i = 0; i < 5; i++) set.add(PR.box([-8.2 - i * 0.45, 0.2 + i * 0.4, 4.0 + i * 0.5], [0.8, 0.2 + i * 0.2, 0.6], MAT.CAVE, 0.6, 0.06));
    set.obj().add(PR.ellipsoid([6.2, 0.5, -3.4], [0.34, 0.5, 0.34], MAT.STONE), PR.ellipsoid([6.9, 0.42, -2.7], [0.3, 0.42, 0.3], MAT.STONE), PR.box([-1.6, 0.06, 5.2], [1.0, 0.06, 0.5], MAT.CLOTH, 0.3, 0.03));
    set.spots.you = { p: [0.4, 4.6], y: 0 };
    set.spots.elder = [{ p: [-3.5, -3.1], y: 0.44, face: [0.4, 4.6] }];
    set.spots.sit = [{ p: [2.8, 5.4], y: 0, face: [3.6, 4.0] }, { p: [4.8, 3.0], y: 0, face: [3.6, 4.0] }];
    set.spots.stand = [[-1.0, 2.0], [1.4, -3.9], [5.2, -1.6], [-5.2, 1.2]].map((p) => ({ p, y: 0 }));
    set.spots.work = [[-7.6, 3.8], [2.6, -3.9]].map((p) => ({ p, y: 0 }));
    set.spots.items = [[-1.4, 1.0], [1.0, 2.0]].map((p) => ({ p, y: 0 }));
    set.anchors = [{ re: /stone cups/i, p: [-4.4, -9.6], tagH: 3.4 }];
    set.exitAt = [{ re: /red ridge/i, p: [-9.2, 6.4] }];
  },

  bones(set) {
    // a Dreyer crawler on its side, half sunk, ribs of it showing; things glint; the sand is soft and deep
    const tremor = Number(set.here.state?.tremor || 0);
    Object.assign(set.terr, { t0: [2.8, 7, 8, MAT.SAND], t2: [0.6 + tremor * 0.3, 0, 0, 0] });
    set.cam = { target: [0, 1.5, -4], dist: 19, pitch: 0.24, yaw: -0.35, maxDist: 34 };
    set.dust = 1.1; set.shimmer = 0.5;
    crawler(set, [-2, 0, -7.5], 0.6, 'side');
    set.obj().add(PR.ribs([13, 0, -15], 4, 2.2, 5.2, 0.26, 0.6, 0, MAT.BONE, 1.1), PR.seg([7, 0.4, -17.5], [19, 0.6, -12.5], 0.32, MAT.BONE, 0.22));
    set.obj().add(PR.flock([-2, 12, -7.5], 6, 5, 0.3, 0.6));
    set.shafts.push({ a: [30, 0, -26], b: [30, 14, -26], r: 1.5, power: -0.5, wander: 0.04 });
    set.spots.you = { p: [0, 5], y: 0 };
    set.spots.stand = [[2.2, 0.2], [-2.4, -0.8], [3.4, -3.2], [-4.6, -2.0], [5.6, 1.6]].map((p) => ({ p, y: 0 }));
    set.spots.lookout = [{ p: [6.4, -4.4], y: 0 }];
    set.spots.work = [[0.8, -3.6], [-4.0, -3.4]].map((p) => ({ p, y: 0, kneel: true }));
    set.spots.items = [[1.5, -3.3], [-4.2, -2.8], [2.8, -5.0], [-1.0, -2.6]].map((p) => ({ p, y: 0 }));
  },

  deep(set) {
    // under the dunes; nothing lives here but the one thing that does
    Object.assign(set.terr, { t0: [0.7, 13, 0, MAT.SAND], t3: [1, 13, 0, 22] });
    set.cam = { target: [0, 2.2, -4.5], dist: 13, pitch: 0.16, yaw: 0, maxDist: 15 };
    set.cave = true; set.indoor = true; set.lines = false; set.dust = 1.5; set.shimmer = 0; set.exitR = 12;
    // a crack in the roof where the sand pours through: the only light there is
    set.shafts.push({ a: [3.4, 13, -7.9], b: [2.6, 0, -7], r: 0.75, power: 0.85, hole: true });
    set.obj().add(PR.seg([3.35, 12.6, -7.85], [2.62, 0.7, -7.02], 0.05, MAT.SAND, 0.02), PR.cone([2.6, 0, -7], 1.7, 0.08, 1.0, MAT.SAND));
    // the coils, far back, ridged, sliding against each other
    const CZ = -18, CR = 7.5;
    set.obj().add(PR.coils([0, 1.2, CZ], CR, 1.6, 3, MAT.CAVE));
    // pale pits along the body, riding the coils as they turn
    set.dyn.push((t) => {
      const out = [];
      for (let i = 0; i < 3; i++) {
        const R = CR * (1 - 0.12 * i) + 1.6 * (1 - 0.15 * i) * 1.03, y = 1.2 + i * 2.56 - 1.0, dir = i % 2 ? -1 : 1;
        for (let k = 0; k < 4; k++) {
          const a = Math.PI / 2 + (k - 1.5) * 0.32 + i * 0.5 + t * 0.04 * dir;
          out.push(PR.sphere([Math.cos(a) * R, y, CZ + Math.sin(a) * R], 0.2, MAT.EMBER));
        }
      }
      return out;
    });
    // the head, risen out of the floor: a ringed neck, a round mouth, teeth turned inward
    const H = [-5.0, 0, -9.6];
    set.obj().add(PR.seg([H[0] - 0.6, -0.6, H[2] - 1.2], [H[0], 3.6, H[2]], 1.55, MAT.CAVE, 1.3));
    for (let i = 0; i < 4; i++) set.add(PR.torus([H[0] - 0.5 + i * 0.13, 0.35 + i * 0.95, H[2] - 1.0 + i * 0.27], 1.52 - i * 0.05, 0.13, 0, MAT.CAVE));
    set.add(PR.ellipsoid([H[0], 4.1, H[2] - 0.2], [1.5, 1.45, 1.1], MAT.CAVE));
    set.add(PR.torus([H[0], 4.1, H[2] + 0.78], 1.15, 0.2, 2, MAT.CAVE), PR.sphere([H[0], 4.1, H[2] + 0.45], 1.02, MAT.DARK));
    for (let i = 0; i < 11; i++) {
      const a = i / 11 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      set.add(PR.seg([H[0] + c * 1.05, 4.1 + s * 1.05, H[2] + 0.85], [H[0] + c * 0.45, 4.1 + s * 0.45, H[2] + 0.6], 0.13, MAT.BONE, 0.01));
    }
    // what it ate: the ribs of something big, a crawler's wheel, a lamp gone cold
    set.obj().add(PR.ribs([7.4, 0, -3.8], 5, 1.3, 3.0, 0.15, 0.5, 0, MAT.BONE, 0.9), PR.seg([4.6, 0.2, -6.4], [10.4, 0.25, -1.4], 0.22, MAT.BONE, 0.12));
    set.obj().add(PR.torus([-8.2, 0.55, -1.6], 1.0, 0.17, 1, MAT.METAL, 0.5), PR.box([-7.0, 0.12, -0.4], [0.9, 0.06, 0.5], MAT.METAL, 0.8, 0.02));
    set.obj();
    for (let i = 0; i < 9; i++) { const a = set.r(0, Math.PI * 2), r = set.r(12, 19); set.add(PR.cone([Math.cos(a) * r, 0, Math.sin(a) * r], set.r(0.6, 1.2), 0.05, set.r(2.5, 6), MAT.CAVE)); }
    set.obj();
    for (let i = 0; i < 7; i++) { const a = set.r(0, Math.PI * 2), r = set.r(4, 16); set.add(PR.cone([Math.cos(a) * r, 13 - set.r(1, 3.5), Math.sin(a) * r], 0.02, set.r(0.3, 0.7), set.r(1, 3.4), MAT.CAVE)); }
    set.obj().add(PR.shards([-1.5, 0, -10.5], 3.2, 1.4, 0.5, 0.35, MAT.EMBER, true, 0.2));
    set.lights.push({ pos: [-1.5, 0.8, -10.5], radius: 4.5, power: 0.6, flicker: 0.35 });
    set.lights.push({ pos: [H[0], 4.2, H[2] + 1.6], radius: 2.2, power: 0.35, flicker: 0.1 });
    set.lights.push({ pos: [1.5, 6, CZ + CR + 3], radius: 7, power: 0.5, flicker: 0.05 });
    set.landmark = [H[0], 4, H[2]];
    set.spots.you = { p: [0.6, 1.4], y: 0, face: [H[0], H[2]] };
    set.spots.stand = [[2.4, 1.0], [-2.2, 0.4], [3.6, -2.6]].map((p) => ({ p, y: 0, face: [H[0], H[2]] }));
    set.spots.items = [[1.2, -1.0], [-1.4, -2.0]].map((p) => ({ p, y: 0 }));
  },

  dunes(set) {
    Object.assign(set.terr, { t0: [1.6, 6, 10, MAT.SAND] });
    set.obj(); for (let i = 0; i < 4; i++) { const a = set.r(0, Math.PI * 2), r = set.r(7, 14); boulder(set, [Math.cos(a) * r, 0, Math.sin(a) * r], set.r(0.8, 2.0)); }
    hoodoo(set, [-9, 0, -9], 5); hoodoo(set, [11, 0, -6], 3.6);
    set.obj().add(PR.arch([3, 0, -14], 4, 0.9, 1.6, MAT.ROCK, 0.3));
    set.spots.you = { p: [0, 5], y: 0 };
    set.spots.stand = [[2, 0], [-2.5, -1], [4, -4], [-4, -5]].map((p) => ({ p, y: 0 }));
  },
};

function buildSet(st) {
  const kind = setKind(st.here);
  const set = newSet(kind, st.here);
  SETS[kind](set, st);
  if (set.groups.length > MAXG - 14) mergeGroups(set, MAXG - 14);
  return set;
}
// keep the static groups under budget by merging the closest pairs (never ones that carve)
function mergeGroups(set, limit) {
  const gs = set.groups.filter((g) => g.length);
  const carves = (g) => g.some((p) => p.m < 0);
  while (gs.length > limit) {
    let best = null, bd = Infinity;
    for (let i = 0; i < gs.length; i++) {
      if (carves(gs[i])) continue;
      const bi = groupBound(gs[i]);
      for (let j = i + 1; j < gs.length; j++) {
        if (carves(gs[j])) continue;
        const bj = groupBound(gs[j]);
        const d = Math.hypot(bi[0] - bj[0], bi[1] - bj[1], bi[2] - bj[2]) + bi[3] + bj[3];
        if (d < bd) { bd = d; best = [i, j]; }
      }
    }
    if (!best) break;
    gs[best[0]] = gs[best[0]].concat(gs[best[1]]);
    gs.splice(best[1], 1);
  }
  set.groups = gs;
}

let staticRows = 0, staticG = [];
function uploadStatic(set) {
  let row = 0;
  staticG = [];
  for (const prims of set.groups) {
    if (!prims.length) continue;
    const start = row;
    for (const p of prims) { if (row >= PRIM_ROWS - 200) break; putPrim(row++, p); }
    staticG.push({ b: groupBound(prims), s: start, n: row - start });
  }
  staticRows = row;
  gl.bindTexture(gl.TEXTURE_2D, primTex);
  if (row) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, row, gl.RGBA, gl.FLOAT, primData, 0);
}

// ---------------------------------------------------------------------
//  The director: who stands where, doing what
// ---------------------------------------------------------------------
function isPerson(e) {
  const s = e.state || {};
  return 'hp' in s || 'max_hp' in s || ['person', 'fighter', 'carrier'].includes(e.type);
}
// Silhouette style from what the world says about someone (never from hidden state).
function bodyStyle(e) {
  const s = e.state || {};
  const text = [e.name, s.template, s.role, s.faction, s.description].filter(Boolean).join(' ').toLowerCase();
  if (/elder|very old/.test(text)) return 5;
  if (/keth|scout|nomad|hood/.test(text)) return 2;
  if (/captain/.test(text)) return 6;
  if (/reeve|lord|lady|noble|dreyer|clerk|priest|scribe|agent/.test(text)) return 4;
  if (/carrier|guild|porter|trader|merchant/.test(text)) return 3;
  if (/guard|soldier|sergeant|warden/.test(text)) return 1;
  return 0;
}
function thingKind(e) {
  const s = e.state || {};
  if (s.water_source) return 'well';
  if (e.type === 'letter' || typeof s.text === 'string') return 'letter';
  if (e.type === 'vein' || 'ember' in s) return 'vein';
  if (s.weapon) return 'blade';
  if (e.type === 'waterskin' || 'capacity' in s) return 'skin';
  if (s.ward) return 'ward';
  if (s.portable === false) return 'block';
  return 'item';
}
// What someone is doing, read from their description and state.
function activityOf(e, you) {
  const s = e.state || {};
  const text = [e.name, s.description, s.role, s.template].filter(Boolean).join(' ').toLowerCase();
  const props = (/(long glass|spyglass|glass in one hand)/.test(text) ? 1 : 0) | (/(ledger|tally)/.test(text) ? 2 : 0) | (/(yoke|jars|water-bearer)/.test(text) ? 4 : 0);
  const h = hashStr(e.id || e.name || 'x');
  if (s.dead || s.down || s.asleep) return { kind: 'lie', pose: 0, arms: 0, props: 0, spot: 'stand' };
  if (s.follows) return { kind: 'follow', leader: s.follows, pose: 0, arms: 0, props, spot: 'stand' };
  if (/(cross-legged|sitting|sits|seated)/.test(text)) {
    return { kind: 'sit', pose: 1, arms: props & 1 ? 1 : 0, props, spot: /(drip|stone cup|elder)/.test(text) ? 'elder' : 'sit', face: /(watching|eyes on|watch)/.test(text) ? 'landmark' : null };
  }
  if (props & 4) return { kind: 'carry', pose: 0, arms: 5, props, spot: 'work' };
  if (/(watching|eyes on|lookout)/.test(text)) return { kind: 'watch', pose: 0, arms: props & 1 ? 1 : 0, props, spot: 'lookout', face: 'landmark' };
  if (props & 2) return { kind: 'work', pose: 0, arms: 4, props, spot: 'work' };
  if (/captain/.test(text)) return { kind: 'stand', pose: 0, arms: 2, props, spot: 'overlook' };
  if (/clerk/.test(text)) return { kind: 'stand', pose: 0, arms: 2, props, spot: 'shade' };
  if (/guard/.test(text) || s.template === 'guard') {
    if (you) return { kind: 'stand', pose: 0, arms: 3, props, spot: 'stand' };
    return S.set?.kind === 'yard' ? (h % 2 ? { kind: 'patrol', pose: 0, arms: 0, props, spot: 'drill' } : { kind: 'drill', pose: 0, arms: 7, props, spot: 'drill' }) : { kind: 'stand', pose: 0, arms: 3, props, spot: 'stand' };
  }
  if (/carrier/.test(text) || s.template === 'carrier') return { kind: 'work', pose: 0, arms: 0, props, spot: 'work' };
  if (/scout/.test(text)) return { kind: 'watch', pose: 0, arms: 0, props, spot: 'lookout', face: 'landmark' };
  if (/reeve/.test(text)) return { kind: 'pace', pose: 0, arms: 0, props, spot: 'stand' };
  return { kind: 'stand', pose: 0, arms: 0, props, spot: 'stand' };
}
function claimSpot(set, kind, id, taken) {
  const mem = slotMem(set.here.id);
  const key = mem.get(id);
  if (key && !taken.has(key)) { taken.add(key); return spotByKey(set, key); }
  for (const k of [kind, 'stand']) {
    const list = set.spots[k] || [];
    if (!list.length) continue;
    const start = hashStr(id) % list.length;
    for (let i = 0; i < list.length; i++) {
      const j = (start + i) % list.length, kk = `${k}:${j}`;
      if (!taken.has(kk)) { taken.add(kk); mem.set(id, kk); return list[j]; }
    }
  }
  // everyone has a place: a ring around the middle for the overflow
  const n = taken.size, a = n * 2.39;
  return { p: [Math.cos(a) * (4 + n * 0.3), Math.sin(a) * (4 + n * 0.3) - 1], y: 0 };
}
function spotByKey(set, key) {
  const [k, j] = key.split(':');
  return (set.spots[k] || [])[+j] || set.spots.you;
}
function slotMem(placeId) {
  if (!S.slots.has(placeId)) S.slots.set(placeId, new Map());
  return S.slots.get(placeId);
}
function upsertEnt(id, props, target, fresh) {
  let e = S.ents.get(id);
  if (!e) {
    const out = [target[0] * 1.8, target[1], target[2] * 1.8];
    e = { id, phase: (hashStr(id) % 628) / 100, pos: fresh ? target.slice() : out };
    S.ents.set(id, e);
  }
  Object.assign(e, props);
  e.home = target.slice();
  e.target = e.target && !fresh && e.kind === 'person' && e.act && ['patrol', 'work', 'pace', 'carry'].includes(e.act.kind) ? e.target : target.slice();
  return e;
}

function layoutEntities(st, fresh) {
  const set = S.set;
  if (!set) return;
  const keep = new Set();
  const taken = new Set();
  const present = (st.present || []).filter((e) => !(e.state && e.state.hidden));
  const people = [st.you, ...present.filter(isPerson)];
  const things = present.filter((e) => !isPerson(e));

  for (const e of people) {
    const you = e.id === st.you.id;
    const act = activityOf(e, you);
    let spot;
    if (you) spot = S.youSpot && S.youSpot.placeId === st.here.id ? { p: [S.youSpot.x, S.youSpot.z], y: 0 } : set.spots.you;
    else if (act.kind === 'lie' && S.ents.get(e.id)) { const o = S.ents.get(e.id); spot = { p: [o.pos[0], o.pos[2]], y: 0 }; }
    else spot = claimSpot(set, act.spot, e.id, taken);
    const s = e.state || {};
    const style = bodyStyle(e);
    const kneel = spot.kneel && act.kind === 'work';
    const pose = act.kind === 'sit' ? 1 : kneel ? 3 : 0;
    const seat = act.kind === 'sit' ? (spot.y || 0) : 0;
    const ent = upsertEnt(e.id, {
      kind: 'person', name: e.name, you, data: e, sel: S.sel === e.id,
      down: !!(s.down || s.dead || s.asleep), dead: !!s.dead, style, act, pose, arms: act.arms, props: act.props,
      armed: you ? (st.holding || []).some((h) => h.state?.weapon) : style === 1 || style === 6,
      scale: (style === 5 ? 0.86 : 0.95) + (hashStr(e.id) % 9) / 100,
      faceTo: act.face === 'landmark' ? [set.landmark[0], set.landmark[2]] : spot.face || null,
      tagH: s.down || s.dead || s.asleep ? 0.95 : pose === 1 ? 1.55 : pose === 3 ? 1.75 : 2.2,
      pickH: s.down || s.dead || s.asleep ? 0.3 : pose === 1 ? 0.6 : 1.0,
    }, [spot.p[0], seat, spot.p[1]], fresh);
    if (fresh) ent.pos[1] = seat;
    keep.add(e.id);
  }

  let li = 0;
  for (const e of things) {
    const a = set.anchors.find((x) => x.re.test(e.name || ''));
    const tk = thingKind(e);
    if (a) {
      upsertEnt(e.id, { kind: 'thing', tk, name: e.name, data: e, anchored: true, tagH: a.tagH ?? 1.2, pickH: (a.tagH ?? 1.2) * 0.5, pickR: a.pickR ?? 0.8 }, [a.p[0], 0, a.p[1]], true);
    } else {
      const spots = set.spots.items.length ? set.spots.items : [{ p: [0, 0] }];
      const sp = spots[li % spots.length]; const ring = Math.floor(li / spots.length);
      li++;
      upsertEnt(e.id, { kind: 'thing', tk, name: e.name, data: e, anchored: false, tagH: 1.05, pickH: 0.4, pickR: 0.55 }, [sp.p[0] + ring * 0.7, 0, sp.p[1] + ring * 0.5], fresh);
    }
    keep.add(e.id);
  }

  const here = mapPos(st.here.name);
  (st.exits || []).forEach((x, k) => {
    const id = 'exit:' + x.to;
    let p = null;
    const over = set.exitAt.find((o) => o.re.test(x.name || ''));
    if (over) p = over.p;
    else {
      const there = mapPos(x.name);
      let a;
      if (here && there && (there[0] !== here[0] || there[1] !== here[1])) a = Math.atan2(there[1] - here[1], there[0] - here[0]);
      else a = -Math.PI / 2 + (k - ((st.exits.length - 1) / 2)) * 0.9;
      p = [Math.cos(a) * set.exitR, Math.sin(a) * set.exitR];
    }
    upsertEnt(id, { kind: 'exit', name: x.name, placeId: x.to, idx: k + 1, tagH: 2.95, pickH: 1.3, pickR: 0.9 }, [p[0], 0, p[1]], true);
    keep.add(id);
  });

  for (const id of [...S.ents.keys()]) if (!keep.has(id)) { S.ents.delete(id); removeTag(id); }
}

function buildPlace(st) {
  S.spot = null;
  S.youSpot = null;
  S.set = null;
  setAmbient(st.ambient);   // so the set knows whether its fires are lit
  S.set = buildSet(st);
  uploadStatic(S.set);
  const c = S.set.cam;
  Object.assign(cam, { target: c.target.slice(), dist: c.dist, pitch: c.pitch, yaw: c.yaw });
  for (const id of [...S.ents.keys()]) removeTag(id);
  S.ents.clear();
  layoutEntities(st, true);
  setAmbient(st.ambient);
  Story.arrive(st);
}

// ---------------------------------------------------------------------
//  Motion: walking, patrols, work loops, conversations
// ---------------------------------------------------------------------
function moveEnts(dt, now) {
  const k = 1 - Math.exp(-dt * 3.2);
  const ents = S.ents;
  for (const e of ents.values()) {
    if (e.kind !== 'person' || e.down) {
      for (let i = 0; i < 3; i++) e.pos[i] += (e.target[i] - e.pos[i]) * k;
      e.walk = 0;
      continue;
    }
    const act = e.act || { kind: 'stand' };
    const fa = S.faceAt.get(e.id);
    const partner = fa && fa.until > now && fa.id ? ents.get(fa.id) : null;
    e.talking = !!(S.speech.get(e.id) && S.speech.get(e.id).until > now);
    let speed = 1.5;
    // where they mean to be
    if (e.you) {
      // you go where the commands send you
    } else if (act.kind === 'follow' && ents.get(act.leader)) {
      const L = ents.get(act.leader);
      const fx = -Math.sin(L.yaw || 0), fz = Math.cos(L.yaw || 0);
      e.target = [L.pos[0] - fx * 1.3, 0, L.pos[2] - fz * 1.3];
    } else if (partner && partner.kind === 'person' && ['stand', 'watch', 'pace', 'work'].includes(act.kind)) {
      const dx = e.pos[0] - partner.pos[0], dz = e.pos[2] - partner.pos[2], dd = Math.hypot(dx, dz) || 1;
      if (dd > 2.2) e.target = [partner.pos[0] + dx / dd * 1.3, 0, partner.pos[2] + dz / dd * 1.3];
    } else if (act.kind === 'patrol' || act.kind === 'work' || act.kind === 'carry' || act.kind === 'pace') {
      route(e, act, now);
      speed = act.kind === 'patrol' ? 1.1 : act.kind === 'carry' ? 0.8 : 1.2;
    } else {
      e.target = e.home.slice();
    }
    const dx = e.target[0] - e.pos[0], dz = e.target[2] - e.pos[2];
    const dist = Math.hypot(dx, dz);
    const step = Math.min(dist, speed * dt);
    if (dist > 1e-4) { e.pos[0] += (dx / dist) * step; e.pos[2] += (dz / dist) * step; }
    e.pos[1] += ((e.target[1] || 0) - e.pos[1]) * k;
    const moving = dist > 0.03;
    e.walk = (e.walk || 0) + ((moving ? 1 : 0) - (e.walk || 0)) * Math.min(1, dt * 6);
    e.stride = ((e.stride || 0) + step * 5.4) % 6283.18;
    // which way they look
    let fx = -e.pos[0], fz = 0.4 - e.pos[2];
    if (moving) { fx = dx; fz = dz; }
    else if (partner) { fx = partner.pos[0] - e.pos[0]; fz = partner.pos[2] - e.pos[2]; }
    else if (fa && fa.until > now && fa.pt) { fx = fa.pt[0] - e.pos[0]; fz = fa.pt[1] - e.pos[2]; }
    else if (e.faceTo) { fx = e.faceTo[0] - e.pos[0]; fz = e.faceTo[1] - e.pos[2]; }
    else if (e.you) { fx = -Math.sin(cam.yaw); fz = -Math.cos(cam.yaw); }
    if (act.kind === 'watch' && !moving) {
      // a watcher's gaze drifts a little and comes back
      const a = Math.atan2(fz, fx) + Math.sin(now / 1000 * 0.21 + e.phase) * 0.25;
      fx = Math.cos(a); fz = Math.sin(a);
    }
    if (Math.hypot(fx, fz) > 0.01) {
      const want = Math.atan2(-fx, fz);
      if (e.yaw == null) e.yaw = want;
      e.yaw += Math.atan2(Math.sin(want - e.yaw), Math.cos(want - e.yaw)) * Math.min(1, dt * 5);
    }
  }
}
// patrols walk a loop, workers go from job to job, the restless pace
function route(e, act, now) {
  const set = S.set;
  if (!e.route) {
    if (act.kind === 'patrol' && set.spots.patrol.length) e.route = set.spots.patrol.map((p) => [p[0], p[1]]);
    else if ((act.kind === 'work' || act.kind === 'carry') && set.spots.work.length > 1) e.route = set.spots.work.map((s) => s.p.slice());
    else { const a = (hashStr(e.id) % 628) / 100; e.route = [[e.home[0], e.home[2]], [e.home[0] + Math.cos(a) * 2.6, e.home[2] + Math.sin(a) * 2.6]]; }
    e.ri = hashStr(e.id) % e.route.length;
    e.waitUntil = 0;
  }
  const p = e.route[e.ri];
  const d = Math.hypot(p[0] - e.pos[0], p[1] - e.pos[2]);
  if (d < 0.15) {
    if (!e.waitUntil) {
      const pause = act.kind === 'patrol' ? 1.6 : act.kind === 'pace' ? 5 + (e.phase % 4) : 3.5 + (e.phase % 3);
      e.waitUntil = now + pause * 1000;
    } else if (now > e.waitUntil) {
      e.ri = (e.ri + 1) % e.route.length;
      e.waitUntil = 0;
    }
  }
  const q = e.route[e.ri];
  e.target = [q[0], 0, q[1]];
}

// ---------------------------------------------------------------------
//  Per-frame primitives: people, exits, markers, little moving things
// ---------------------------------------------------------------------
function personPrim(e) {
  const m = e.sel ? MAT.SEL : e.you ? MAT.YOU : e.down ? MAT.DOWN : MAT.PERSON;
  const flags = (e.down ? 1 : 0) + (e.armed && !e.down ? 2 : 0);
  let arms = e.talking ? 6 : e.arms || 0;
  if ((e.walk || 0) > 0.5 && arms !== 5) arms = 0;
  return {
    t: SH.HUMAN, m, pos: [e.pos[0], e.pos[1] || 0, e.pos[2]], r: e.scale || 1, rot: e.down ? e.phase : e.yaw || 0,
    c: [e.down ? 0 : e.walk || 0, e.style || 0, e.stride || 0, flags],
    d: [e.down ? 0 : e.pose || 0, arms, e.phase * 10, e.props || 0],
  };
}
function thingPrims(e) {
  if (e.anchored) return [];
  const [x, , z] = e.pos;
  const rot = e.phase;
  switch (e.tk) {
    case 'well': return [PR.well([x, 0, z], 1.0, 0.75, 0.5, MAT.STONE), PR.cyl([x, 0.3, z], 0.75, 0.05, MAT.WATER)];
    case 'letter': return [PR.box([x, 0.45, z], [0.3, 0.45, 0.22], MAT.STONE, rot, 0.03), PR.box([x, 0.92, z], [0.24, 0.015, 0.17], MAT.BONE, rot + 0.2, 0.005)];
    case 'blade': return [PR.box([x, 0.05, z], [0.55, 0.03, 0.05], MAT.METAL, rot, 0.01)];
    case 'skin': return [PR.ellipsoid([x, 0.18, z], [0.24, 0.17, 0.18], MAT.CLOTH, rot)];
    case 'ward': return [PR.box([x, 0.06, z], [0.16, 0.06, 0.12], MAT.EXIT, rot, 0.02)];
    case 'vein': return [PR.shards([x, 0, z], 1.0, 0.6, 0.3, 0.5, MAT.EMBER)];
    case 'block': return [PR.box([x, 0.5, z], [0.5, 0.5, 0.5], MAT.STONE, rot, 0.06)];
    default: return [PR.box([x, 0.22, z], [0.22, 0.22, 0.22], MAT.WOOD, rot, 0.03)];
  }
}
function pylonPrims(e) {
  const [x, , z] = e.pos;
  const sel = S.sel === e.placeId;
  return [
    PR.cyl([x, 0.1, z], 0.55, 0.1, MAT.STONE),
    PR.box([x, 1.35, z], [0.2, 1.25, 0.2], MAT.STONE, 0.6, 0.05),
    PR.box([x, 2.1, z], [0.23, 0.08, 0.23], sel ? MAT.LAMP : MAT.EXIT, 0.6, 0.02),
    PR.box([x, 1.2, z], [0.23, 0.05, 0.23], sel ? MAT.LAMP : MAT.EXIT, 0.6, 0.02),
  ];
}
let dynG = [];
function uploadDynamic(now) {
  let row = staticRows;
  dynG = [];
  const push = (prims) => {
    if (!prims.length || staticG.length + dynG.length >= MAXG || row + prims.length > PRIM_ROWS) return;
    const start = row;
    for (const p of prims) putPrim(row++, p);
    dynG.push({ b: groupBound(prims), s: start, n: prims.length });
  };
  for (const e of S.ents.values()) {
    if (e.kind === 'person') push([personPrim(e)]);
    else if (e.kind === 'exit') push(pylonPrims(e));
    else push(thingPrims(e));
    if (e.kind === 'thing' && S.sel === e.id) push([PR.torus([e.pos[0], 0.03, e.pos[2]], e.pickR || 0.7, 0.04, 0, MAT.LAMP)]);
  }
  if (S.spot && S.spot.placeId === S.placeId) push([PR.torus([S.spot.x, 0.03, S.spot.z], 0.35, 0.035, 0, MAT.EXIT)]);
  for (const f of S.set?.dyn || []) push(f(now / 1000));
  if (row > staticRows) {
    gl.bindTexture(gl.TEXTURE_2D, primTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, staticRows, 4, row - staticRows, gl.RGBA, gl.FLOAT, primData, staticRows * 16);
  }
}
const G0 = new Float32Array(MAXG * 4), G1 = new Float32Array(MAXG * 4);
function packGroups() {
  const all = staticG.concat(dynG).slice(0, MAXG);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  all.forEach((g, i) => {
    G0.set(g.b, i * 4);
    G1[i * 4] = g.s; G1[i * 4 + 1] = g.n; G1[i * 4 + 2] = 0; G1[i * 4 + 3] = 0;
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], g.b[k] - g.b[3]); mx[k] = Math.max(mx[k], g.b[k] + g.b[3]); }
  });
  const sb = all.length ? [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2] : [0, -100, 0, 0.001];
  return { n: all.length, sb };
}

// ---------------------------------------------------------------------
//  Camera
// ---------------------------------------------------------------------
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
let C = null;
function computeCamera() {
  const sway = cam.spin ? 0 : 0.22 * Math.sin(time * 0.07);
  const yaw = cam.yaw + sway;
  cam.dist = Math.min(cam.dist, S.set?.cam.maxDist ?? 34);
  const cp = Math.cos(cam.pitch);
  const pos = [
    cam.target[0] + cam.dist * cp * Math.sin(yaw),
    cam.target[1] + cam.dist * Math.sin(cam.pitch) + Math.sin(time * 0.31) * 0.06,
    cam.target[2] + cam.dist * cp * Math.cos(yaw),
  ];
  const F = V.norm(V.sub(cam.target, pos));
  const R = V.norm(V.cross(F, [0, 1, 0]));
  const U = V.cross(R, F);
  C = { pos, F, R, U, tan: Math.tan(cam.fov / 2), yaw };
}
function project(p, w, h) {
  const rel = V.sub(p, C.pos);
  const z = V.dot(rel, C.F);
  if (z < 0.2) return null;
  const asp = w / h;
  const x = V.dot(rel, C.R) / (z * C.tan * asp);
  const y = V.dot(rel, C.U) / (z * C.tan);
  return [(x + 1) / 2 * w, (1 - y) / 2 * h, z];
}

// ---------------------------------------------------------------------
//  Light: the world's own words for the hour and the weather
// ---------------------------------------------------------------------
const TOD = {
  dawn: { elev: 0.11, az: 0.75, sun: 0.8, night: 0.15, fog: 0.022, fogH: 0.12, rays: 1.0, shimmer: 0.2, dust: 0.5, sky: 'dawn', vig: 0.3, contrast: 0.7 },
  morning: { elev: 0.28, az: 0.45, sun: 1.05, night: 0, fog: 0.012, fogH: 0.08, rays: 0.6, shimmer: 0.5, dust: 0.6, sky: 'day', vig: 0.22, contrast: 0.6 },
  noon: { elev: 1.05, az: 0.15, sun: 1.15, night: 0, fog: 0.008, fogH: 0.06, rays: 0.3, shimmer: 1.0, dust: 0.5, sky: 'day', vig: 0.2, contrast: 0.55 },
  afternoon: { elev: 0.45, az: -0.35, sun: 1.05, night: 0, fog: 0.01, fogH: 0.07, rays: 0.5, shimmer: 0.6, dust: 0.6, sky: 'day', vig: 0.24, contrast: 0.6 },
  dusk: { elev: 0.07, az: -0.62, sun: 0.75, night: 0.32, fog: 0.016, fogH: 0.1, rays: 1.15, shimmer: 0.15, dust: 0.7, sky: 'dusk', vig: 0.36, contrast: 0.8 },
  night: { elev: 0.5, az: 0.25, sun: 0, night: 1, fog: 0.01, fogH: 0.08, rays: 0.15, shimmer: 0, dust: 0.25, sky: 'night', vig: 0.45, contrast: 0.75 },
};
function todKey(amb) {
  const t = `${amb?.time_of_day || ''} ${amb?.light || ''}`.toLowerCase();
  if (/dawn|sunrise|first light/.test(t)) return 'dawn';
  if (/dusk|evening|sunset|twilight/.test(t)) return 'dusk';
  if (/night|midnight|dark/.test(t)) return 'night';
  if (/noon|midday|heat|blinding/.test(t)) return 'noon';
  if (/afternoon/.test(t)) return 'afternoon';
  return 'morning';
}
function setAmbient(amb) {
  const set = S.set;
  const key = todKey(amb);
  const T = { ...TOD[key] };
  const weather = `${amb?.weather || ''}`.toLowerCase();
  if (/dust|storm|wind|haze|sand/.test(weather)) { T.fog *= 2.2; T.dust *= 2; T.rays *= 0.7; }
  const prevNight = S.amb ? S.amb.night > 0.25 : null;
  const wind = [0.92, 0.38];
  S.amb = {
    key, T, night: T.night, sunI: T.sun, fogK: T.fog, fogH: T.fogH, rays: T.rays * (set?.rays ?? 1),
    shimmer: T.shimmer * (set?.shimmer ?? 0.4), dust: T.dust * (set?.dust ?? 0.6), vig: T.vig, wind,
    contrast: Math.min(1, (T.contrast ?? 0.6) + (set?.indoor ? 0.2 : 0)),
    moon: V.norm([-0.3, 0.55, -0.78]), sunElev: set?.sunElev ?? T.elev, sunAz: set?.sunAz ?? T.az,
  };
  if (set?.cave) { S.amb.fogK = 0.02; S.amb.fogH = 0.02; S.amb.sunI = set.kind === 'deep' ? 0.8 : 0.95; S.amb.night = Math.max(T.night, 0.55); S.amb.rays = 0.35; S.amb.sky = 'cave'; }
  else S.amb.sky = T.sky;
  // fires and lamps come and go with the dark: rebuild the set when that changes
  if (set && prevNight != null && prevNight !== (S.amb.night > 0.25) && S.state) {
    S.set = buildSet(S.state); uploadStatic(S.set);
  }
}
function sunDir() {
  const a = S.amb;
  if (!a) return [0, 0.5, -0.8];
  const set = S.set;
  if (set?.cave && set.shafts[0]?.hole) {
    const s = set.shafts[0];
    return V.norm(V.sub(s.a, s.b));
  }
  // the sun sits in front of the set's own camera, so figures are lit from behind
  const look = Math.atan2(-Math.cos(set?.cam.yaw ?? 0), -Math.sin(set?.cam.yaw ?? 0));
  const az = look + a.sunAz;
  const ce = Math.cos(a.sunElev);
  return V.norm([Math.cos(az) * ce, Math.sin(a.sunElev), Math.sin(az) * ce]);
}
function skyColors(pal) {
  const k = S.amb?.sky || 'day';
  return pal.sky[k] || pal.sky.day;
}

// ---------------------------------------------------------------------
//  Render loop
// ---------------------------------------------------------------------
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
  if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
  W = innerWidth; H = innerHeight;
}
addEventListener('resize', resize);
resize();

const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const inflight = [];
let gpuMs = null, qualityAt = 0;
function gpuBegin() { if (!tq || inflight.length > 2) return null; const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); return q; }
function gpuEnd(q) { if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); inflight.push(q); } }
function gpuPoll() {
  while (inflight.length && gl.getQueryParameter(inflight[0], gl.QUERY_RESULT_AVAILABLE)) {
    const q = inflight.shift();
    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) { const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; gpuMs = gpuMs == null ? ms : gpuMs * 0.85 + ms * 0.15; }
    gl.deleteQuery(q);
  }
}
const palCache = new Map();
function palFlat(pal) {
  if (!palCache.has(pal)) palCache.set(pal, new Float32Array(pal.mats.flatMap(hex)));
  return palCache.get(pal);
}
const LP = new Float32Array(16), LC = new Float32Array(16), SA = new Float32Array(16), SB = new Float32Array(16);

let last = performance.now(), perfAcc = 0, perfN = 0, perfAt = 0, vsync = 1;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  resize();
  if (S.fadeDir > 0) {
    S.fade = Math.min(1, S.fade + dt / 0.16);
    if (S.fade >= 1) {
      if (S.pendingPlace) { const st = S.pendingPlace; S.pendingPlace = null; S.placeId = st.here.id; buildPlace(st); }
      S.fadeDir = -1;
    }
  } else if (S.fadeDir < 0) {
    S.fade = Math.max(0, S.fade - dt / 0.36);
    if (S.fade <= 0) S.fadeDir = 0;
  }
  if (!S.set) { gl.clearColor(0.07, 0.04, 0.2, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
  if (cam.spin) cam.yaw += dt * 0.1;
  computeCamera();
  moveEnts(dt, now);
  uploadDynamic(now);
  const G = packGroups();

  const set = S.set, amb = S.amb;
  const pal = PALETTES[S.pal];
  const sky = skyColors(pal);
  const sun = sunDir();
  const cellCss = S.mode === 0 ? [5, 5] : [7.2, 12];
  const cell = [cellCss[0] * dpr, cellCss[1] * dpr];
  sizeScene(Math.max(8, Math.ceil(canvas.width / cell[1] * S.q)), Math.max(8, Math.ceil(canvas.height / cell[1] * S.q)));

  // lights and shafts for this frame
  const lights = set.lights.slice(0, 4);
  LP.fill(0); LC.fill(0);
  lights.forEach((l, i) => { LP.set([l.pos[0], l.pos[1], l.pos[2], l.radius], i * 4); LC.set([l.power, l.flicker, 0, 0], i * 4); });
  const shafts = [];
  for (const s of set.shafts) {
    if (s.wander) {
      const ox = Math.sin(time * s.wander * 3 + s.a[0]) * 8, oz = Math.cos(time * s.wander * 2.3 + s.a[2]) * 6;
      shafts.push([[s.a[0] + ox, s.a[1], s.a[2] + oz], [s.b[0] + ox + Math.sin(time * 0.9) * 0.8, s.b[1], s.b[2] + oz], s.r, s.power]);
    } else shafts.push([s.a, s.b, s.r, s.power]);
  }
  if (set.windows.length && amb.sunI > 0) {
    for (const w of set.windows) {
      const k = (w[1] - 0.05) / Math.max(sun[1], 0.12);
      shafts.push([w, [w[0] - sun[0] * k, 0.05, w[2] - sun[2] * k], 0.5, 0.65]);
    }
  }
  SA.fill(0); SB.fill(0);
  shafts.slice(0, 4).forEach((s, i) => { SA.set([s[0][0], s[0][1], s[0][2], s[2]], i * 4); SB.set([s[1][0], s[1][1], s[1][2], s[3]], i * 4); });

  // pass 1: the set
  const gq = gpuBegin();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
  gl.viewport(0, 0, sceneW, sceneH);
  gl.useProgram(progScene);
  const u1 = progScene.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, primTex);
  gl.uniform1i(u1('uPrims'), 0);
  gl.uniform2f(u1('uRes'), sceneW, sceneH);
  gl.uniform3fv(u1('uCamPos'), C.pos); gl.uniform3fv(u1('uCamR'), C.R); gl.uniform3fv(u1('uCamU'), C.U); gl.uniform3fv(u1('uCamF'), C.F);
  gl.uniform1f(u1('uTan'), C.tan);
  gl.uniform1f(u1('uTime'), time);
  gl.uniform1i(u1('uZero'), 0);
  gl.uniform3fv(u1('uSun'), sun);
  gl.uniform1f(u1('uSunI'), amb.sunI);
  gl.uniform3fv(u1('uMoon'), amb.moon);
  gl.uniform1f(u1('uNight'), amb.night);
  gl.uniform1f(u1('uFogK'), amb.fogK);
  gl.uniform1f(u1('uFogH'), amb.fogH);
  gl.uniform2fv(u1('uWind'), amb.wind);
  gl.uniform1f(u1('uStripes'), pal.stripes);
  gl.uniform1f(u1('uLinesOn'), set.lines && S.pal === 'neon' ? 1 : 0);
  gl.uniform1f(u1('uIndoor'), set.indoor ? 0.8 : 1.0);
  const T = set.terr;
  gl.uniform4fv(u1('uT0'), T.t0); gl.uniform4fv(u1('uT1'), T.t1); gl.uniform4fv(u1('uT2'), T.t2); gl.uniform4fv(u1('uT3'), T.t3); gl.uniform4fv(u1('uT4'), T.t4);
  gl.uniform1i(u1('uGroups'), G.n);
  gl.uniform4fv(u1('uSceneB'), G.sb);
  gl.uniform4fv(u1('uG0'), G0); gl.uniform4fv(u1('uG1'), G1);
  gl.uniform1i(u1('uLights'), lights.length);
  gl.uniform4fv(u1('uLightP'), LP); gl.uniform4fv(u1('uLightC'), LC);
  gl.uniform1i(u1('uShafts'), Math.min(4, shafts.length));
  gl.uniform4fv(u1('uShaftA'), SA); gl.uniform4fv(u1('uShaftB'), SB);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // pass 2: compose
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboCompose);
  gl.viewport(0, 0, sceneW, sceneH);
  gl.useProgram(progCompose);
  const u2 = progCompose.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex1);
  gl.uniform1i(u2('uS0'), 0); gl.uniform1i(u2('uS1'), 1);
  gl.uniform2f(u2('uRes'), sceneW, sceneH);
  const sp = project([C.pos[0] + sun[0] * 1000, C.pos[1] + sun[1] * 1000, C.pos[2] + sun[2] * 1000], 1, 1);
  let rays = 0, suv = [0.5, 1.2];
  if (sp) {
    suv = [sp[0], 1 - sp[1]];
    const off = Math.max(0, Math.abs(suv[0] - 0.5) - 0.5, Math.abs(suv[1] - 0.5) - 0.5);
    rays = amb.rays * Math.max(0, 1 - off * 1.6);
  }
  if (amb.night > 0.6 && !set.cave) rays *= 0.3;
  gl.uniform2f(u2('uSunUV'), suv[0], suv[1]);
  gl.uniform1f(u2('uRays'), rays);
  gl.uniform1f(u2('uTime'), time);
  gl.uniform1f(u2('uShimmer'), amb.shimmer);
  gl.uniform1f(u2('uDust'), amb.dust);
  gl.uniform1f(u2('uContrast'), amb.contrast ?? 0.6);
  gl.uniform2f(u2('uWind2'), V.dot([amb.wind[0], 0, amb.wind[1]], C.R) * -0.4, 0.05);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // pass 3: dots or glyphs
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(progPresent);
  const u3 = progPresent.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texC);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glyphTex);
  gl.uniform1i(u3('uScene'), 0); gl.uniform1i(u3('uGlyph'), 1);
  gl.uniform2f(u3('uRes'), canvas.width, canvas.height);
  gl.uniform2f(u3('uSceneRes'), sceneW, sceneH);
  gl.uniform2f(u3('uCell'), cell[0], cell[1]);
  gl.uniform1i(u3('uMode'), S.mode);
  gl.uniform1f(u3('uGlyphN'), RAMP.length);
  gl.uniform1f(u3('uFade'), S.fade);
  gl.uniform1f(u3('uVig'), amb.vig);
  gl.uniform3fv(u3('uPal'), palFlat(pal));
  gl.uniform3fv(u3('uInk'), hex(pal.ink));
  gl.uniform3fv(u3('uLine'), hex(pal.line));
  gl.uniform3fv(u3('uSkyTop'), hex(sky[0]));
  gl.uniform3fv(u3('uSkyBot'), hex(sky[1]));
  gl.uniform3fv(u3('uSunA'), hex(sky[2]));
  gl.uniform3fv(u3('uSunB'), hex(sky[3]));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gpuEnd(gq);

  updateTags();

  if (tq) {
    gpuPoll();
    if (gpuMs != null && now - qualityAt > 700) {
      if (gpuMs > 10 && S.q > 0.6) S.q = Math.max(0.6, S.q * 0.88);
      else if (gpuMs < 5 && S.q < 2) S.q = Math.min(2, S.q * 1.06);
      qualityAt = now;
    }
  } else {
    perfAcc += dt; perfN++;
    if (now - perfAt > 1500 && perfN > 20) {
      const avg = perfAcc / perfN;
      vsync = Math.min(vsync, avg);
      if (avg > vsync * 1.3 && S.q > 0.6) S.q = Math.max(0.6, S.q * 0.85);
      else if (avg < vsync * 1.08 && S.q < 1.8) S.q = Math.min(1.8, S.q * 1.05);
      perfAcc = 0; perfN = 0; perfAt = now;
      vsync *= 1.02;
    }
  }
}
