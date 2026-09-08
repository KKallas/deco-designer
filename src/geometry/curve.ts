import * as THREE from 'three/webgpu';
import { vertex, type Curve, type Vec2, type Vec3, type Vertex } from '../model/types';
import { segmentControls, splitBezier, type Bezier } from '../model/handles';

/** Cubic Bézier path through the vertices, in plane-local XYZ (z = 0 on planar curves). */
export function curvePath(points: Vertex[], closed: boolean): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
  for (const [p0, c1, c2, p3] of segmentControls(points, closed)) {
    const seg = new THREE.CubicBezierCurve3(v3(p0), v3(c1), v3(c2), v3(p3));
    seg.arcLengthDivisions = 1000;   // arc length ↔ t to a few µm, so cuts and crossings (docs/29) land where they should
    path.add(seg);
  }
  path.arcLengthDivisions = Math.max(200, points.length * 40);
  return path;
}

/** One point along a curve, with local bend information. */
export interface Sample {
  x: number;
  y: number;
  /** Offset along the plane normal (0 on planar curves). */
  z: number;
  /** Arc-length parameter 0..1. */
  t: number;
  /** Arc length from the start, mm. */
  s: number;
  /** Curvature, 1/mm — signed (left turn > 0) on planar curves, unsigned on 3D ones. */
  curvature: number;
  /** Bend radius, mm (Infinity on straight parts). */
  radius: number;
}

export interface CurveSampling {
  path: THREE.CurvePath<THREE.Vector3> | null;
  length: number;
  samples: Sample[];
}

export const EMPTY_SAMPLING: CurveSampling = { path: null, length: 0, samples: [] };

/**
 * Sample a curve roughly every `spacing` mm and estimate its bend radius from
 * the angle between the neighbouring tangents (3D; exactly the planar value
 * when every z is 0).
 */
export function sampleCurve(curve: Curve, spacing = 5): CurveSampling {
  if (curve.points.length < 2) return EMPTY_SAMPLING;
  const path = curvePath(curve.points, curve.closed);
  const length = path.getLength();
  if (!(length > 0)) return { path, length: 0, samples: [] };
  const n = Math.min(2000, Math.max(8, Math.ceil(length / spacing)));

  const tangents: THREE.Vector3[] = [];
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push(path.getPointAt(u));
    tangents.push(path.getTangentAt(u).normalize());
  }
  const planar = curve.points.every((v) => v.z === 0 && v.in.z === 0 && v.out.z === 0);

  const samples: Sample[] = [];
  const closed = curve.closed && curve.points.length > 2;
  const cross = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    let ip = i - 1, inx = i + 1;
    if (closed) { ip = (ip + n) % n; inx = inx % n; }
    else { ip = Math.max(0, ip); inx = Math.min(n, inx); }
    const a = tangents[ip], b = tangents[inx];
    cross.crossVectors(a, b);
    let d = Math.atan2(cross.length(), a.dot(b));           // unsigned turning angle, 0..π
    if (planar && cross.z < 0) d = -d;                      // planar: keep the Part 1 sign (left turn > 0)
    const steps = inx - ip + (inx < ip ? n : 0);
    const ds = (steps / n) * length;
    const k = ds > 0 ? d / ds : 0;
    samples.push({ x: pts[i].x, y: pts[i].y, z: pts[i].z, t: i / n, s: (i / n) * length, curvature: k, radius: Math.abs(k) > 1e-9 ? 1 / Math.abs(k) : Infinity });
  }
  return { path, length, samples };
}

/** Sample points whose arc length lies in [s0, s1] (at least two points). */
export function samplesBetween(sampling: CurveSampling, s0: number, s1: number): Sample[] {
  const all = sampling.samples;
  if (all.length < 2) return all;
  let i0 = all.findIndex((s) => s.s >= s0);
  if (i0 < 0) i0 = all.length - 1;
  let i1 = i0;
  while (i1 + 1 < all.length && all[i1 + 1].s <= s1) i1++;
  if (i1 === i0) { if (i1 + 1 < all.length) i1++; else if (i0 > 0) i0--; }
  return all.slice(i0, i1 + 1);
}

/**
 * Split the curve at arc length `s`: returns the new vertex (equal, or polygon on a straight segment, with
 * handles from a de Casteljau split so the shape is unchanged), the index to
 * insert it at, and the neighbours' adjusted handles.
 */
export function splitCurveAt(curve: Curve, sampling: CurveSampling, s: number): { index: number; vertex: Vertex; prevOut: Vec3; nextIn: Vec3 } | null {
  const path = sampling.path;
  if (!path || curve.points.length < 2) return null;
  const lengths = path.getCurveLengths();
  let seg = lengths.findIndex((l) => l >= s);
  if (seg < 0) seg = lengths.length - 1;
  const start = seg > 0 ? lengths[seg - 1] : 0;
  const segLen = lengths[seg] - start;
  const u = segLen > 0 ? Math.min(1, Math.max(0, (s - start) / segLen)) : 0;
  const t = path.curves[seg].getUtoTmapping(u, 0);
  const bez: Bezier = segmentControls(curve.points, curve.closed)[seg];
  const { left, right } = splitBezier(bez, t);
  const m = left[3];
  const v = vertex(m.x, m.y, 'equal', m.z);
  v.in = { x: left[2].x - m.x, y: left[2].y - m.y, z: left[2].z - m.z };
  v.out = { x: right[1].x - m.x, y: right[1].y - m.y, z: right[1].z - m.z };
  if (Math.hypot(v.in.x, v.in.y, v.in.z) < 1e-6 && Math.hypot(v.out.x, v.out.y, v.out.z) < 1e-6) v.type = 'polygon';
  return {
    index: seg + 1,
    vertex: v,
    prevOut: { x: left[1].x - bez[0].x, y: left[1].y - bez[0].y, z: left[1].z - bez[0].z },
    nextIn: { x: right[2].x - bez[3].x, y: right[2].y - bez[3].y, z: right[2].z - bez[3].z },
  };
}

export function curveBounds(points: Vec2[]): { min: Vec2; max: Vec2; center: Vec2 } {
  if (!points.length) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 }, center: { x: 0, y: 0 } };
  const min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
  for (const p of points) { min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); }
  return { min, max, center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 } };
}

/** Range of the normal offsets (both 0 on a planar curve). */
export function zRange(points: Vec3[]): { min: number; max: number } {
  if (!points.length) return { min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (const p of points) { min = Math.min(min, p.z); max = Math.max(max, p.z); }
  return { min, max };
}
