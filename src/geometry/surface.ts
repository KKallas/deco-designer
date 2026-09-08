/**
 * A shape's surface (docs/30-outline-and-shape-layers.md §4): the loops its curves enclose on
 * one plane — an open curve closed by the chord, every loop grown `expand` mm outwards, loops
 * nested even-odd so a curve inside another is a hole — triangulated into the flat sheet, and
 * handed to a **fill program** `(three, surface, params) => BufferGeometry` with `inside`,
 * `heightAt`, `clip` and `random`. Everything is **plane-local mm**; the plane's world matrix
 * is applied by the viewer, so a shape follows the objects its plane sits in as the curves do.
 */
import * as THREE from 'three/webgpu';
import { curvePath } from './curve';
import { THREE_SCOPE } from './shape';
import type { CurveObject, Shape } from '../model/types';

/** Is this Bézier segment a straight line? (both handles on the chord — a polygon side) */
function straight(seg: THREE.Curve<THREE.Vector3>): boolean {
  const b = seg as THREE.CubicBezierCurve3;
  if (!b.v0 || !b.v3) return false;
  const chord = new THREE.Vector3().subVectors(b.v3, b.v0), len = chord.length();
  if (len < 1e-9) return true;
  const off = (p: THREE.Vector3) => new THREE.Vector3().subVectors(p, b.v0).cross(chord).length() / len;
  return off(b.v1) < 1e-6 * len && off(b.v2) < 1e-6 * len;
}

/**
 * One curve's loop in plane-local mm, first point once. Always **closed**: an open curve gets the
 * segment from its last vertex back to its first (docs/28 §2). A straight side contributes only
 * its own vertex — so a polygon comes out exactly as drawn — and a curved one `4 × resolution`
 * points; either way every vertex of the curve is on the boundary.
 */
export function boundaryLoop(c: CurveObject, resolution: number): THREE.Vector3[] {
  const per = Math.max(1, Math.round(resolution * 4));
  const out: THREE.Vector3[] = [];
  if (c.curve.points.length < 3) return out;
  for (const seg of curvePath(c.curve.points, true).curves) {
    if (straight(seg)) { out.push(seg.getPoint(0)); continue; }
    const pts = seg.getPoints(per);
    for (let i = 0; i < per; i++) out.push(pts[i]);   // the last point is the next segment's first
  }
  // a Bézier segment of zero length (two vertices in the same place) leaves duplicates earcut chokes on
  return out.filter((p, i) => { const q = out[(i + 1) % out.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9; });
}

/** Twice the signed area of the loop seen flat: > 0 anticlockwise in plane-local x / y. */
export function signedArea2(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a;
}

/** Twice the mitre limit: a corner sharper than this is cut off rather than sent to infinity. */
const MITRE = 4;

/**
 * Move an anticlockwise loop `mm` outwards in the plane (docs/28 §3): + grows it, − shrinks it.
 * Each **side** slides along its own outward normal and the corners are **mitred** — a point sits
 * where its two offset sides meet, so a rectangle grown by 10 mm is a rectangle. A corner sharper
 * than the mitre limit is cut off instead of shooting away. Nothing is cleaned up afterwards: a
 * shrink deeper than a curved shape's own radius folds it.
 */
export function expandLoop(pts: THREE.Vector3[], mm: number): void {
  const n = pts.length;
  const normals = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : { x: dy / len, y: -dx / len };
  });
  const moved = pts.map((p, i) => {
    const a = normals[(i - 1 + n) % n] ?? normals[i], b = normals[i] ?? normals[(i - 1 + n) % n];
    if (!a || !b) return p;
    const dot = a.x * b.x + a.y * b.y;
    let vx = a.x + b.x, vy = a.y + b.y;
    const k = 1 + dot;
    if (k > 1 / MITRE) { vx /= k; vy /= k; } else { const l = Math.hypot(vx, vy) || 1; vx = (vx / l) * MITRE; vy = (vy / l) * MITRE; }
    return new THREE.Vector3(p.x + vx * mm, p.y + vy * mm, p.z);
  });
  moved.forEach((q, i) => pts[i].copy(q));
}

/** Even-odd point-in-polygon of one loop. */
function inLoop(pts: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** What a fill program receives as `surface` (docs/30 §4). */
export interface SurfaceInput {
  id: string;
  name: string;
  /** the closed loops after expand: outer loops anticlockwise, holes clockwise; every point with its own z */
  loops: THREE.Vector3[][];
  /** the flat fill: position, normal, uv (plane mm) — what the Sheet preset returns */
  sheet: THREE.BufferGeometry;
  /** mm² */
  area: number;
  bounds: { min: THREE.Vector2; max: THREE.Vector2 };
  /** even-odd over all loops */
  inside: (x: number, y: number) => boolean;
  /** z of the sheet at a point (0 everywhere on planar curves) */
  heightAt: (x: number, y: number) => number;
  /** the pieces of the segment a → b that lie inside */
  clip: (a: THREE.Vector2, b: THREE.Vector2) => [THREE.Vector2, THREE.Vector2][];
  /** mm from a point to the nearest edge of any loop (a hole's edge counts) */
  distanceToEdge: (x: number, y: number) => number;
  /** a seeded generator in [0, 1) */
  random: (seed: number) => () => number;
  planeNormal: THREE.Vector3;
}

/** A seeded LCG (the LED preset's), so a fill comes out the same on every build. */
export function seededRandom(seed: number): () => number {
  let s = ((seed | 0) + 1) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * The surface of a shape over its curves (those on the shape's plane, with three or more
 * points). Null when nothing encloses an area: no loop, or zero area. Loops nest even-odd: a
 * loop inside one other loop is a hole of it, inside two an island, and so on.
 */
export function surfaceInput(shape: Pick<Shape, 'id' | 'name' | 'expand' | 'resolution'>, curves: CurveObject[]): SurfaceInput | null {
  const loops = curves.map((c) => boundaryLoop(c, shape.resolution)).filter((l) => l.length >= 3);
  for (const l of loops) {
    if (signedArea2(l) < 0) l.reverse();
    if (shape.expand) expandLoop(l, shape.expand);
  }
  const kept = loops.filter((l) => Math.abs(signedArea2(l)) > 1e-6);
  if (!kept.length) return null;
  // nesting: how many other loops contain this one (its first point)
  const depth = kept.map((l, i) => kept.filter((o, j) => j !== i && inLoop(o, l[0].x, l[0].y)).length);
  const outers = kept.map((_, i) => i).filter((i) => depth[i] % 2 === 0);
  const holesOf = new Map<number, number[]>(outers.map((i) => [i, []]));
  kept.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    // the hole belongs to the smallest outer loop around it
    let best = -1, bestArea = Infinity;
    for (const o of outers) { const a = Math.abs(signedArea2(kept[o])); if (a < bestArea && inLoop(kept[o], l[0].x, l[0].y)) { best = o; bestArea = a; } }
    if (best >= 0) { holesOf.get(best)!.push(i); l.reverse(); }
  });

  // the sheet: each outer loop with its holes triangulated, all in one geometry
  const position: number[] = [], uv: number[] = [], index: number[] = [];
  let area = 0;
  const tri = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
  for (const o of outers) {
    const holes = holesOf.get(o)!.map((h) => kept[h]);
    const contour = kept[o];
    const faces = THREE.ShapeUtils.triangulateShape(contour.map((p) => new THREE.Vector2(p.x, p.y)), holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y))));
    if (!faces.length) continue;
    const base = position.length / 3;
    const all = [contour, ...holes].flat();
    for (const p of all) { position.push(p.x, p.y, p.z); uv.push(p.x, p.y); }
    for (const f of faces) {
      index.push(base + f[0], base + f[1], base + f[2]);
      tri.a.set(all[f[0]].x, all[f[0]].y, 0); tri.b.set(all[f[1]].x, all[f[1]].y, 0); tri.c.set(all[f[2]].x, all[f[2]].y, 0);
      area += tri.b.clone().sub(tri.a).cross(tri.c.clone().sub(tri.a)).length() / 2;
    }
  }
  if (!index.length || area < 1e-6) return null;
  const sheet = new THREE.BufferGeometry();
  sheet.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  sheet.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  sheet.setIndex(index);
  sheet.computeVertexNormals();

  const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
  for (const l of kept) for (const p of l) { min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); }
  const flat = position.every((_, i) => i % 3 !== 2 || position[i] === 0);
  const inside = (x: number, y: number) => { let n = 0; for (const l of kept) if (inLoop(l, x, y)) n++; return n % 2 === 1; };

  // z inside the sheet: the triangle under the point, else the nearest vertex
  const heightAt = (x: number, y: number): number => {
    if (flat) return 0;
    for (let t = 0; t < index.length; t += 3) {
      const i0 = index[t] * 3, i1 = index[t + 1] * 3, i2 = index[t + 2] * 3;
      const x0 = position[i0], y0 = position[i0 + 1], x1 = position[i1], y1 = position[i1 + 1], x2 = position[i2], y2 = position[i2 + 1];
      const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(d) < 1e-12) continue;
      const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d, l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d, l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      return l0 * position[i0 + 2] + l1 * position[i1 + 2] + l2 * position[i2 + 2];
    }
    let best = 0, bestD = Infinity;
    for (let i = 0; i < position.length; i += 3) { const d = (position[i] - x) ** 2 + (position[i + 1] - y) ** 2; if (d < bestD) { bestD = d; best = position[i + 2]; } }
    return best;
  };

  // the pieces of a segment inside the region: cut at every crossing with a loop edge, keep the pieces whose middle is inside
  const clip = (a: THREE.Vector2, b: THREE.Vector2): [THREE.Vector2, THREE.Vector2][] => {
    const ts = [0, 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    for (const l of kept) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const p = l[j], q = l[i];
      const ex = q.x - p.x, ey = q.y - p.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / den, u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((p, q) => p - q);
    const out: [THREE.Vector2, THREE.Vector2][] = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      if (!inside(a.x + dx * tm, a.y + dy * tm)) continue;
      const s = new THREE.Vector2(a.x + dx * t0, a.y + dy * t0), e = new THREE.Vector2(a.x + dx * t1, a.y + dy * t1);
      const last = out[out.length - 1];
      if (last && last[1].distanceTo(s) < 1e-9) last[1] = e; else out.push([s, e]);
    }
    return out;
  };

  const distanceToEdge = (x: number, y: number): number => {
    let best = Infinity;
    for (const l of kept) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const p = l[j], q = l[i];
      const ex = q.x - p.x, ey = q.y - p.y, len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x) * ex + (y - p.y) * ey) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (p.x + ex * t), y - (p.y + ey * t)));
    }
    return best;
  };

  return { id: shape.id, name: shape.name, loops: kept, sheet, area, bounds: { min, max }, inside, heightAt, clip, distanceToEdge, random: seededRandom, planeNormal: new THREE.Vector3(0, 0, 1) };
}

export interface FillInfo { vertices: number; triangles: number; hasUv: boolean; ms: number }

/** Compile a fill program (comments stripped like material code) — throws on a syntax error. */
export function compileFill(code: string): (three: typeof THREE_SCOPE, surface: SurfaceInput, params: Record<string, number>) => unknown {
  const body = code.replace(/^\s*\/\/.*$/gm, '').trim();
  return new Function('three', 'surface', 'params', `"use strict"; return (${body})(three, surface, params);`) as (t: typeof THREE_SCOPE, s: SurfaceInput, p: Record<string, number>) => unknown;
}

/** Run a fill on a surface. Throws with the JS error if the code is broken or returns no geometry. */
export function buildFillGeometry(code: string, surface: SurfaceInput, params: Record<string, number>): { geometry: THREE.BufferGeometry; info: FillInfo } {
  const t0 = performance.now();
  const out = compileFill(code)(THREE_SCOPE, surface, { ...params });
  if (!(out instanceof THREE.BufferGeometry)) throw new Error('the code must return a three.BufferGeometry');
  const pos = out.getAttribute('position');
  if (!pos || pos.count === 0) throw new Error('the geometry has no vertices');
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  const idx = out.getIndex();
  return { geometry: out, info: { vertices: pos.count, triangles: Math.floor((idx ? idx.count : pos.count) / 3), hasUv: !!out.getAttribute('uv'), ms: performance.now() - t0 } };
}

/** The curves a shape is built on: those of its list that lie on its plane (the first curve's), in order. */
export function shapeCurves(shape: Shape, curves: CurveObject[]): CurveObject[] {
  const list = shape.curves.map((id) => curves.find((c) => c.id === id)).filter((c): c is CurveObject => !!c);
  const plane = list[0]?.planeId;
  return list.filter((c) => c.planeId === plane);
}
