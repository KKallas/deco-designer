/**
 * Cross-section sweep for shape programs (docs/14-shapes.md §3): an outline
 * (mm, x = sideways in the plane, y = along the plane normal), optionally with
 * holes, swept along the curve. Sections stay perpendicular to the curve;
 * their y follows the plane normal (`up: 'plane'`, the stock orientation, no
 * roll on 3D curves) or the parallel-transport frame (`up: 'frenet'`).
 * uv in mm: u = arc length along the curve, v = distance around the section.
 * Open curves get end caps. Corners sharper than `smoothAngle` are hard edges.
 */
import * as THREE from 'three/webgpu';
import type { ShapeCurve } from './shape';

export type P = [number, number];

export interface SweepOptions {
  holes?: P[][];
  /** degrees around the curve */
  rotate?: number;
  up?: 'plane' | 'frenet';
  /** sections along the curve (default: one every ~6 mm, 8..1200) */
  steps?: number;
  caps?: boolean;
  /** corners with a smaller turn than this (degrees) are smooth (default 40) */
  smoothAngle?: number;
}

export const rect = (w: number, h: number): P[] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];

export function circle(r: number, n = 32): P[] {
  const out: P[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return out;
}

const area = (pts: P[]) => pts.reduce((s, [x, y], i) => { const [nx, ny] = pts[(i + 1) % pts.length]; return s + x * ny - nx * y; }, 0) / 2;
const rotated = (pts: P[], deg: number): P[] => {
  if (!deg) return pts;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
};

/** A ring's vertices with hard corners duplicated: the edges of loop `k` connect ring entries `start..start+count`. */
interface Loop { pts: P[]; ring: { x: number; y: number; v: number }[]; edges: [number, number][] }

function loop(pts: P[], smoothAngle: number, ccw: boolean): Loop {
  let p = area(pts) >= 0 ? pts : [...pts].reverse();
  if (!ccw) p = [...p].reverse();
  const n = p.length;
  const sharp = p.map((_, i) => {
    const [ax, ay] = p[(i - 1 + n) % n], [bx, by] = p[i], [cx, cy] = p[(i + 1) % n];
    const d1 = Math.atan2(by - ay, bx - ax), d2 = Math.atan2(cy - by, cx - bx);
    let turn = Math.abs(d2 - d1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return turn > (smoothAngle * Math.PI) / 180;
  });
  const ring: Loop['ring'] = [];
  const startOf: number[] = [];   // ring index where edge i starts
  let v = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) { const [px, py] = p[i - 1]; v += Math.hypot(p[i][0] - px, p[i][1] - py); }
    if (sharp[i] && i > 0) ring.push({ x: p[i][0], y: p[i][1], v });   // end of the previous edge
    startOf.push(ring.length);
    ring.push({ x: p[i][0], y: p[i][1], v });
  }
  // closing edge back to vertex 0: its own end vertex when the corner is sharp
  const [lx, ly] = p[n - 1];
  v += Math.hypot(p[0][0] - lx, p[0][1] - ly);
  const endIndex = sharp[0] || true ? ring.push({ x: p[0][0], y: p[0][1], v }) - 1 : startOf[0];
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = startOf[i];
    const b = i + 1 < n ? (sharp[i + 1] ? startOf[i + 1] - 1 : startOf[i + 1]) : endIndex;
    edges.push([a, b]);
  }
  return { pts: p, ring, edges };
}

export function sweep(curve: ShapeCurve, outer: P[], opts: SweepOptions = {}): THREE.BufferGeometry {
  if (outer.length < 3) throw new Error('sweep: the outline needs at least 3 points');
  const steps = Math.max(1, Math.round(opts.steps ?? Math.min(1200, Math.max(8, Math.round(curve.length / 6)))));
  const rot = opts.rotate ?? 0;
  const loops = [loop(rotated(outer, rot), opts.smoothAngle ?? 40, true), ...(opts.holes ?? []).map((h) => loop(rotated(h, rot), opts.smoothAngle ?? 40, false))];
  const { points, tangents, normals, binormals } = curve.frames(steps);
  const up = opts.up ?? 'plane';
  const side = new THREE.Vector3(), upv = new THREE.Vector3(), prevSide = new THREE.Vector3(1, 0, 0);
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
  const ringSize = loops.reduce((s, l) => s + l.ring.length, 0);
  const closedCurve = curve.closed;
  for (let i = 0; i <= steps; i++) {
    if (up === 'frenet') { side.copy(normals[i]); upv.copy(binormals[i]); }
    else {
      side.crossVectors(tangents[i], curve.planeNormal);
      if (side.lengthSq() < 1e-8) side.copy(prevSide); else side.normalize();
      prevSide.copy(side);
      upv.crossVectors(side, tangents[i]).normalize();
    }
    const s = (i / steps) * curve.length;
    for (const l of loops) for (const r of l.ring) {
      pos.push(points[i].x + side.x * r.x + upv.x * r.y, points[i].y + side.y * r.x + upv.y * r.y, points[i].z + side.z * r.x + upv.z * r.y);
      uvs.push(s, r.v);
    }
    if (i > 0) {
      let base = 0;
      for (const l of loops) {
        const o = (i - 1) * ringSize + base, n = i * ringSize + base;
        for (const [a, b] of l.edges) idx.push(o + a, n + a, n + b, o + a, n + b, o + b);
        base += l.ring.length;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  if ((opts.caps ?? true) && !closedCurve) {
    const outer2 = loops[0].pts.map(([x, y]) => new THREE.Vector2(x, y));
    const holes2 = loops.slice(1).map((l) => l.pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const tris = THREE.ShapeUtils.triangulateShape(outer2, holes2);
    const all = [...outer2, ...holes2.flat()];
    for (const end of [0, steps]) {
      if (up === 'frenet') { side.copy(normals[end]); upv.copy(binormals[end]); }
      else { side.crossVectors(tangents[end], curve.planeNormal); if (side.lengthSq() < 1e-8) side.copy(prevSide); else side.normalize(); upv.crossVectors(side, tangents[end]).normalize(); }
      const start = pos.length / 3;
      for (const q of all) { pos.push(points[end].x + side.x * q.x + upv.x * q.y, points[end].y + side.y * q.x + upv.y * q.y, points[end].z + side.z * q.x + upv.z * q.y); uvs.push(q.x, q.y); }
      for (const [a, b, c] of tris) { if (end === 0) idx.push(start + a, start + c, start + b); else idx.push(start + a, start + b, start + c); }
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
