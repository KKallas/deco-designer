/**
 * Profile presets as code (docs/14-shapes.md): the stock shapes a curve can
 * be bent from — flat bar, round tube, box section — and an LED string, each a
 * program `(three, curve, params) => BufferGeometry` (uv in mm) on
 * `three.sweep` / `three.rect` / `three.circle` (src/geometry/sweep.ts).
 * Also the migration of pre-Part-14 profiles (shape / a / b / t / rotate).
 */
import type { Profile } from './types';

const FLAT_BAR = `// Flat bar standing on its edge: width along the plane normal, thickness in the plane.
// rotate turns it around the curve (90 = lying flat on the plane).
(three, curve, params) =>
  three.sweep(curve, three.rect(params.thickness, params.width), { rotate: params.rotate })`;

const ROUND_TUBE = `// Round tube (wall 0 = solid rod); the ends show the wall on open curves.
(three, curve, params) => {
  const r = params.diameter / 2, wall = params.wall;
  return three.sweep(curve, three.circle(r), { holes: wall > 0 && wall < r ? [three.circle(r - wall)] : [] });
}`;

const BOX_SECTION = `// Rectangular hollow section: width in the plane, height along the plane normal.
(three, curve, params) => {
  const { width: w, height: h, wall } = params;
  const holes = wall > 0 && wall < Math.min(w, h) / 2 ? [three.rect(w - 2 * wall, h - 2 * wall)] : [];
  return three.sweep(curve, three.rect(w, h), { holes, rotate: params.rotate });
}`;

const LED_STRIP = `// A braided LED string: \`strands\` wires twisted around the curve (outer diameter wireDiameter), and every
// \`pitch\` mm an LED standing on the wire in a random direction (seeded): ledWidth square, ledHeight long,
// the outer \`lit\` part luminous with \`glow\` intensity (HDR: 6 keeps far, sub-pixel lamps bright enough to bloom).
// Colour and glow are vertex attributes (color / emissive); \`pixel\` numbers the lamps along the curve (-1 = not a lamp),
// which is what a fixture drives and what lights the scene (docs/17-emitters.md).
(three, curve, params) => {
  const steps = Math.min(2400, Math.max(16, Math.round(curve.length / 3)));
  const { points, tangents, normals, binormals } = curve.frames(steps);
  const strands = Math.max(1, Math.round(params.strands));
  const r = params.wireDiameter / (strands > 1 ? 4 : 2);       // strand radius: two strands side by side make the outer diameter
  const orbit = strands > 1 ? r : 0;
  const g = Math.max(0, params.glow);
  const WHITE = [0.92, 0.92, 0.9], NONE = [0, 0, 0], LIT = [1, 0.93, 0.75], GLOW = [1 * g, 0.82 * g, 0.5 * g];
  const tint = (geo, rgb, glow, pixel = -1) => {
    const n = geo.getAttribute('position').count, c = new Float32Array(n * 3), e = new Float32Array(n * 3), p = new Float32Array(n).fill(pixel);
    for (let i = 0; i < n; i++) { c.set(rgb, i * 3); e.set(glow, i * 3); }
    geo.setAttribute('color', new three.BufferAttribute(c, 3));
    geo.setAttribute('emissive', new three.BufferAttribute(e, 3));
    geo.setAttribute('pixel', new three.BufferAttribute(p, 1));
    return geo;
  };
  const parts = [];
  // the wires: helices around the curve, one tube each (uv: u along, v around, mm)
  for (let k = 0; k < strands; k++) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = (2 * Math.PI * (i / steps) * curve.length) / params.twistPitch + (2 * Math.PI * k) / strands;
      pts.push(points[i].clone().addScaledVector(normals[i], Math.cos(a) * orbit).addScaledVector(binormals[i], Math.sin(a) * orbit));
    }
    const tube = new three.TubeGeometry(new three.CatmullRomCurve3(pts), steps, r, 10, false);
    const uv = tube.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * curve.length, uv.getY(i) * 2 * Math.PI * r);
    parts.push(tint(tube, WHITE, NONE));
  }
  // the LEDs: base (plastic) on the wire, lit tip beyond it, each turned by a random angle around the wire
  let seed = ((params.seed | 0) + 1) >>> 0;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const count = Math.floor(curve.length / params.pitch);
  const m = new three.Matrix4(), dir = new three.Vector3(), side = new three.Vector3();
  const w = params.ledWidth, base = params.ledHeight * (1 - params.lit), tip = params.ledHeight * params.lit;
  for (let j = 0; j < count; j++) {
    const i = Math.min(steps, Math.round((((j + 0.5) * params.pitch) / curve.length) * steps));
    const phi = rand() * Math.PI * 2;
    dir.copy(normals[i]).multiplyScalar(Math.cos(phi)).addScaledVector(binormals[i], Math.sin(phi)).normalize();
    side.crossVectors(dir, tangents[i]).normalize();
    for (const [len, from, rgb, glow, px] of [[base, params.wireDiameter / 2, WHITE, NONE, -1], [tip, params.wireDiameter / 2 + base, LIT, GLOW, j]]) {
      if (len <= 0) continue;
      const box = new three.BoxGeometry(w, len, w);
      const uv = box.getAttribute('uv');
      for (let q = 0; q < uv.count; q++) uv.setXY(q, uv.getX(q) * w, uv.getY(q) * len);
      m.makeBasis(side, dir, tangents[i]).setPosition(points[i].clone().addScaledVector(dir, from + len / 2));
      parts.push(tint(box.applyMatrix4(m), rgb, glow, px));
    }
  }
  return three.mergeGeometries(parts);
}`;

/** Ready-made shapes (listed as presets on the shapes page; two of them are the project defaults). */
export const PRESET_PROFILES: Profile[] = [
  { id: 'flat-bar', label: 'Flat bar', code: FLAT_BAR, params: { width: 25, thickness: 2, rotate: 0 }, color: '#c9c9cf', limits: { minBendRadius: 15, maxLength: 6000 } },
  { id: 'round-tube', label: 'Round tube', code: ROUND_TUBE, params: { diameter: 15, wall: 1.5 }, color: '#b9bcc4', limits: { minBendRadius: 45, maxLength: 6000 } },
  { id: 'box-section', label: 'Box section', code: BOX_SECTION, params: { width: 20, height: 20, wall: 1.5, rotate: 0 }, color: '#c0c4cc', limits: { minBendRadius: 60, maxLength: 6000 } },
  { id: 'led-strip', label: 'LED string', code: LED_STRIP, params: { wireDiameter: 4, strands: 2, twistPitch: 40, pitch: 25, ledWidth: 5, ledHeight: 20, lit: 0.34, glow: 6, seed: 1 }, color: '#f2e6b0', limits: { minBendRadius: 30, maxLength: 5000 } },
];

/**
 * A stored LED string from before Part 17 upgraded to the one that numbers its lamps (docs/17-emitters.md):
 * without the `pixel` attribute nothing can drive or light from them. Params and limits are kept.
 */
export function upgradeLedCode(code: string): string | null {
  return code.includes('the LEDs: base (plastic) on the wire') && !code.includes("'pixel'") ? LED_STRIP : null;
}

export const cloneProfile = (p: Profile): Profile => ({ ...p, params: { ...p.params }, limits: { ...p.limits } });

/** `width=25 thickness=2` — the parameters in one line. */
export function describeProfile(p: Profile): string {
  const e = Object.entries(p.params);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(' ') : 'no params';
}

/** A pre-Part-14 profile (`shape` + a / b / t / rotate) as code with the same look. */
export function profileFromLegacy(raw: Record<string, unknown>): Profile {
  const num = (k: string, d = 0) => (typeof raw[k] === 'number' && Number.isFinite(raw[k] as number) ? (raw[k] as number) : d);
  const shape = String(raw.shape ?? 'round');
  const limits = (raw.limits ?? {}) as Partial<Profile['limits']>;
  const base = { id: String(raw.id), label: String(raw.label ?? raw.id), color: String(raw.color ?? '#c9c9cf'), limits: { minBendRadius: limits.minBendRadius ?? 0, maxLength: limits.maxLength ?? 6000 } };
  if (shape === 'flat') return { ...base, code: FLAT_BAR, params: { width: num('a', 25), thickness: num('b', 2), rotate: num('rotate') } };
  if (shape === 'square') return { ...base, code: BOX_SECTION, params: { width: num('a', 20), height: num('a', 20), wall: num('t'), rotate: num('rotate') } };
  if (shape === 'rect') return { ...base, code: BOX_SECTION, params: { width: num('a', 20), height: num('b', 20), wall: num('t'), rotate: num('rotate') } };
  return { ...base, code: ROUND_TUBE, params: { diameter: num('a', 15), wall: num('t') } };
}
