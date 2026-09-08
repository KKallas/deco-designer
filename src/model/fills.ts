/**
 * Fill presets as code (docs/30-outline-and-shape-layers.md §4): programs over the surface a
 * shape's curves enclose — the sheet itself, a PVC net, bubbles — each
 * `(three, surface, params) => BufferGeometry` in plane-local mm (uv in mm). `surface` is built
 * by src/geometry/surface.ts: loops, the flat sheet, inside / heightAt / clip / random.
 */
import type { Fill } from './types';

const SHEET = `// The sheet: the flat fill of the outline as it is (uv = plane millimetres).
(three, surface, params) => surface.sheet.clone()`;

const PVC_NET = `// A net of round strands: two families of parallel lines \`pitch\` mm apart, turned by \`angle\` degrees,
// each strand a tube Ø \`wire\` clipped to the outline and lying on the sheet (a warped sheet gets a warped net).
// uv: u along the strand, v around it, mm.
(three, surface, params) => {
  const pitch = Math.max(5, params.pitch), r = Math.max(0.2, params.wire / 2);
  const { min, max } = surface.bounds;
  const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2;
  const R = Math.hypot(max.x - min.x, max.y - min.y) / 2 + pitch;
  const parts = [];
  for (const deg of [params.angle, params.angle + 90]) {
    const a = (deg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);   // along the strand
    const nx = -dy, ny = dx;                                                // across the strands
    for (let k = Math.ceil(-R / pitch); k * pitch <= R; k++) {
      const ox = cx + nx * k * pitch, oy = cy + ny * k * pitch;
      const p = new three.Vector2(ox - dx * R, oy - dy * R), q = new three.Vector2(ox + dx * R, oy + dy * R);
      for (const [s, e] of surface.clip(p, q)) {
        const len = s.distanceTo(e);
        if (len < r) continue;
        const n = Math.max(1, Math.round(len / 25));
        const pts = [];
        for (let i = 0; i <= n; i++) { const x = s.x + ((e.x - s.x) * i) / n, y = s.y + ((e.y - s.y) * i) / n; pts.push(new three.Vector3(x, y, surface.heightAt(x, y) + r)); }
        const tube = new three.TubeGeometry(n === 1 ? new three.LineCurve3(pts[0], pts[1]) : new three.CatmullRomCurve3(pts), n, r, 6, false);
        const uv = tube.getAttribute('uv');
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * 2 * Math.PI * r);
        parts.push(tube);
      }
    }
  }
  if (!parts.length) throw new Error('no strand fits inside the outline — is the pitch bigger than the shape?');
  return three.mergeGeometries(parts);
}`;

const BUBBLES = `// Baubles: \`count\` spheres over the surface in \`sizes\` different sizes (diameter \`size\` down to half of it, the
// big ones placed first), every one at least \`margin\` mm from the outline and from each other, resting on the sheet.
// Seeded: the same seed places them the same way. The look is the fill's: colour, metalness, roughness (a red bauble by default).
(three, surface, params) => {
  const rand = surface.random(params.seed);
  const count = Math.max(0, Math.round(params.count)), steps = Math.max(1, Math.round(params.sizes));
  const margin = Math.max(0, params.margin);
  const { min, max } = surface.bounds;
  const radii = Array.from({ length: count }, (_, i) => (Math.max(1, params.size) / 2) * (1 - ((i % steps) / steps) * 0.5)).sort((a, b) => b - a);
  const placed = [], parts = [];
  for (const r of radii) {
    for (let t = 0; t < 200; t++) {
      const x = min.x + rand() * (max.x - min.x), y = min.y + rand() * (max.y - min.y);
      if (!surface.inside(x, y) || surface.distanceToEdge(x, y) < r + margin) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + margin)) continue;
      placed.push({ x, y, r });
      const g = new three.SphereGeometry(r, 24, 16);
      const uv = g.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 2 * Math.PI * r, uv.getY(k) * Math.PI * r);
      g.translate(x, y, surface.heightAt(x, y) + r);
      parts.push(g);
      break;
    }
  }
  if (!parts.length) throw new Error('no bubble fits inside the outline — a smaller size or margin?');
  return three.mergeGeometries(parts);
}`;

/** The sheet fill every project has — what a migrated panel's layer runs. */
export const SHEET_FILL = (): Fill => ({ id: 'sheet', label: 'Sheet', code: SHEET, params: {}, color: 'checker', metalness: 0, roughness: 0.5 });

/** Ready-made fills (listed as presets on the programs page; every new project starts with all three). */
export const PRESET_FILLS: Fill[] = [
  SHEET_FILL(),
  { id: 'pvc-net', label: 'PVC net', code: PVC_NET, params: { pitch: 50, wire: 2, angle: 0 }, color: '#e8e8ec', metalness: 0, roughness: 0.5 },
  { id: 'bubbles', label: 'Bubbles', code: BUBBLES, params: { count: 30, size: 60, sizes: 3, margin: 10, seed: 1 }, color: '#b3121e', metalness: 1, roughness: 0.12 },
];

/** The colour a fill shows without a material: `checker` is the loft's 100 mm board (docs/30 §4). */
export const CHECKER_COLOR = 'checker';

export const cloneFill = (f: Fill): Fill => ({ ...f, params: { ...f.params } });

/** `pitch=50 wire=2` — the parameters in one line. */
export function describeFill(f: Fill): string {
  const e = Object.entries(f.params);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(' ') : 'no params';
}
