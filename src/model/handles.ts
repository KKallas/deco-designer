/**
 * Bézier handle maths for vertices. Pure, no three.js. Everything is 3D in
 * plane coordinates (x, y in the plane, z along the normal — z is 0 on planar
 * curves, so the planar behaviour is unchanged).
 */
import type { Curve, Vec3, Vertex } from './types';

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const ZERO = (): Vec3 => ({ x: 0, y: 0, z: 0 });

function neighbours(points: Vertex[], closed: boolean, i: number): { prev: Vertex | null; next: Vertex | null } {
  const n = points.length;
  const wrap = closed && n > 2;
  return {
    prev: i > 0 ? points[i - 1] : wrap ? points[n - 1] : null,
    next: i < n - 1 ? points[i + 1] : wrap ? points[0] : null,
  };
}

/** Handles (relative) derived from the neighbours — what a vertex gains when it stops being a polygon one. */
export function autoHandles(points: Vertex[], closed: boolean, i: number): { in: Vec3; out: Vec3 } {
  const v = points[i];
  const { prev, next } = neighbours(points, closed, i);
  if (prev && next) {
    const d = sub(next, prev);
    const l = len(d) || 1;
    const dir = mul(d, 1 / l);
    return { out: mul(dir, len(sub(next, v)) / 3), in: mul(dir, -len(sub(v, prev)) / 3) };
  }
  if (next) return { in: ZERO(), out: mul(sub(next, v), 1 / 3) };
  if (prev) return { in: mul(sub(prev, v), 1 / 3), out: ZERO() };
  return { in: ZERO(), out: ZERO() };
}

/** Effective handles (relative) of vertex i. */
export function handlesOf(points: Vertex[], _closed: boolean, i: number): { in: Vec3; out: Vec3 } {
  const v = points[i];
  return v.type === 'polygon' ? { in: ZERO(), out: ZERO() } : { in: { ...v.in }, out: { ...v.out } };
}

/** Effective handles of vertex i as absolute plane points. */
export function absoluteHandles(points: Vertex[], closed: boolean, i: number): { in: Vec3; out: Vec3 } {
  const h = handlesOf(points, closed, i);
  return { in: add(points[i], h.in), out: add(points[i], h.out) };
}

/** Give vertex i handles from its neighbours when it carries none (polygon → equal / free). */
export function fillHandles(curve: Curve, i: number): void {
  const v = curve.points[i];
  if (len(v.in) > 1e-9 || len(v.out) > 1e-9) return;
  const h = autoHandles(curve.points, curve.closed, i);
  v.in = h.in;
  v.out = h.out;
}

export type Bezier = [Vec3, Vec3, Vec3, Vec3];

/** Cubic Bézier control points of every segment (n-1 open, n closed). */
export function segmentControls(points: Vertex[], closed: boolean): Bezier[] {
  const n = points.length;
  if (n < 2) return [];
  const segs = closed && n > 2 ? n : n - 1;
  const out: Bezier[] = [];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const a = absoluteHandles(points, closed, i);
    const b = absoluteHandles(points, closed, j);
    out.push([{ x: points[i].x, y: points[i].y, z: points[i].z }, a.out, b.in, { x: points[j].x, y: points[j].y, z: points[j].z }]);
  }
  return out;
}

/** De Casteljau split at t. */
export function splitBezier([p0, c1, c2, p3]: Bezier, t: number): { left: Bezier; right: Bezier } {
  const lerp = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  const a = lerp(p0, c1), b = lerp(c1, c2), c = lerp(c2, p3);
  const d = lerp(a, b), e = lerp(b, c);
  const m = lerp(d, e);
  return { left: [p0, a, d, m], right: [m, e, c, p3] };
}

/** Mirror `moved` onto the other side of the vertex keeping the other handle's length. */
export function mirrorHandle(moved: Vec3, otherLength: number): Vec3 {
  const l = len(moved);
  if (l < 1e-9) return ZERO();
  return mul(moved, -otherLength / l);
}

export const vec = { sub, add, mul, len };
