/**
 * Offset, trim and fillet between curves on one plane (docs/29-offset-trim-fillet.md).
 * Pure functions over the plane-local 2D drawing (`z` is left at 0 — these are planar
 * tools). Nothing here touches the store: every function returns a new `Curve` (or the
 * pieces of one) and the caller decides what becomes a curve object.
 */
import type * as THREE from 'three/webgpu';
import { vertex, type Curve, type Id, type Vec2, type Vec3, type Vertex } from '../model/types';
import { segmentControls, type Bezier } from '../model/handles';
import { sampleCurve, splitCurveAt, type CurveSampling } from './curve';

const EPS = 1e-9;
/** Two arc lengths closer than this are one cut; a cut this close to a vertex reuses it. */
export const CUT_TOL = 0.01;
/** Twice the mitre limit of an offset corner (the panel's rule, docs/28 §3). */
const MITRE = 4;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const unit = (a: Vec2): Vec2 | null => { const l = len(a); return l < EPS ? null : { x: a.x / l, y: a.y / l }; };
const v3 = (p: Vec2): Vec3 => ({ x: p.x, y: p.y, z: 0 });
const cloneCurve = (c: Curve): Curve => ({ closed: c.closed, points: c.points.map((v) => ({ ...v, in: { ...v.in }, out: { ...v.out } })) });

/** Twice the signed area of the sampled outline: > 0 anticlockwise. */
export function windingOf(sampling: CurveSampling): number {
  const s = sampling.samples;
  let a = 0;
  for (let i = 0; i < s.length; i++) { const p = s[i], q = s[(i + 1) % s.length]; a += p.x * q.y - q.x * p.y; }
  return a;
}

/** Arc length at every vertex (vertex 0 at 0; on a closed curve the loop comes back at `length`). */
export function vertexArcLengths(curve: Curve, sampling: CurveSampling): number[] {
  const path = sampling.path;
  if (!path) return curve.points.map(() => 0);
  const lengths = path.getCurveLengths();
  return curve.points.map((_, i) => (i === 0 ? 0 : lengths[i - 1] ?? 0));
}

/** Is this segment a straight line (both control points on the chord)? */
export function isStraight([p0, c1, c2, p3]: Bezier): boolean {
  const chord = sub(p3, p0), l = len(chord);
  if (l < EPS) return true;
  const off = (p: Vec2) => Math.abs(cross(chord, sub(p, p0))) / l;
  return off(c1) < 1e-6 * l && off(c2) < 1e-6 * l;
}

/**
 * Unit directions of travel arriving at (`in`) and leaving (`out`) vertex i, read off the
 * control polygon: the last / first leg that has a length. Null at an open end.
 */
export function tangentsAt(points: Vertex[], closed: boolean, i: number): { in: Vec2 | null; out: Vec2 | null } {
  const segs = segmentControls(points, closed);
  const n = points.length;
  const wrap = closed && n > 2;
  const prev = i > 0 ? segs[i - 1] : wrap ? segs[n - 1] : null;
  const next = i < segs.length && (i < n - 1 || wrap) ? segs[i] : null;
  const last = (b: Bezier) => unit(sub(b[3], b[2])) ?? unit(sub(b[3], b[1])) ?? unit(sub(b[3], b[0]));
  const first = (b: Bezier) => unit(sub(b[1], b[0])) ?? unit(sub(b[2], b[0])) ?? unit(sub(b[3], b[0]));
  return { in: prev ? last(prev) : null, out: next ? first(next) : null };
}

/** Turning angle at vertex i in radians (0 on a smooth or straight-through vertex, null at an open end). */
export function turnAt(points: Vertex[], closed: boolean, i: number): number | null {
  const t = tangentsAt(points, closed, i);
  if (!t.in || !t.out) return null;
  return Math.atan2(Math.abs(cross(t.in, t.out)), dot(t.in, t.out));
}

// -- offset ---------------------------------------------------------------------

/** How far an offset cubic may stray from the true parallel before its source segment is split. */
export const OFFSET_TOL = 0.2;

const bezAt = ([p0, c1, c2, p3]: Bezier, t: number): Vec2 => {
  const u = 1 - t;
  return { x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y };
};
const bezTangent = ([p0, c1, c2, p3]: Bezier, t: number): Vec2 | null => {
  const u = 1 - t;
  const d = { x: 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x), y: 3 * u * u * (c1.y - p0.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y) };
  return unit(d) ?? unit(sub(p3, p0));
};
const leftOf = (t: Vec2): Vec2 => ({ x: -t.y, y: t.x });
const splitAt = (b: Bezier, t: number): { left: Bezier; right: Bezier } => {
  const lerp = (a: Vec3, c: Vec3): Vec3 => ({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: 0 });
  const [p0, c1, c2, p3] = b;
  const a = lerp(p0, c1), m1 = lerp(c1, c2), c = lerp(c2, p3);
  const d = lerp(a, m1), e = lerp(m1, c);
  const m = lerp(d, e);
  return { left: [p0, a, d, m], right: [m, e, c, p3] };
};

/**
 * One cubic moved `d` to its left (Tiller–Hanson): every leg of its control polygon slides
 * along the leg's own normal and the control points land where neighbouring offset legs meet.
 * A straight segment is translated whole (exact). Where the result strays from the true
 * parallel by more than `OFFSET_TOL` the source is split in two and both halves are offset —
 * so a tight arc comes out as a few cubics that are all within tolerance.
 */
function offsetBezier(b: Bezier, d: number, depth = 0): Bezier[] {
  if (isStraight(b)) {
    const t = bezTangent(b, 0.5);
    if (!t) return [b];
    const n = leftOf(t);
    return [b.map((p) => ({ x: p.x + n.x * d, y: p.y + n.y * d, z: 0 })) as Bezier];
  }
  // reduced polygon: coincident control points move together
  const nodes: { p: Vec2; members: number[] }[] = [];
  b.forEach((p, k) => { const last = nodes[nodes.length - 1]; if (last && len(sub(p, last.p)) < 1e-6) last.members.push(k); else nodes.push({ p, members: [k] }); });
  const m = nodes.length;
  const normal = (a: Vec2, c: Vec2): Vec2 | null => { const u = unit(sub(c, a)); return u ? leftOf(u) : null; };
  const moved = nodes.map((node, i) => {
    const a = i > 0 ? normal(nodes[i - 1].p, node.p) : null;
    const c = i < m - 1 ? normal(node.p, nodes[i + 1].p) : null;
    const na = a ?? c, nb = c ?? a;
    if (!na || !nb) return node.p;
    let vx = na.x + nb.x, vy = na.y + nb.y;
    const k = 1 + dot(na, nb);
    if (k > 1 / MITRE) { vx /= k; vy /= k; }
    else { const l = Math.hypot(vx, vy); if (l < EPS) { vx = na.x; vy = na.y; } else { vx = (vx / l) * MITRE; vy = (vy / l) * MITRE; } }
    return { x: node.p.x + vx * d, y: node.p.y + vy * d };
  });
  const out = [...b] as Bezier;
  nodes.forEach((node, i) => { for (const k of node.members) out[k] = { x: moved[i].x, y: moved[i].y, z: 0 }; });
  // good enough? compare against the true parallel at a few parameters
  let worst = 0;
  for (const t of [0.25, 0.5, 0.75]) {
    const tan = bezTangent(b, t);
    if (!tan) continue;
    const want = { x: bezAt(b, t).x + leftOf(tan).x * d, y: bezAt(b, t).y + leftOf(tan).y * d };
    worst = Math.max(worst, len(sub(bezAt(out, t), want)));
  }
  if (worst <= OFFSET_TOL || depth >= 6) return [out];
  const { left, right } = splitAt(b, 0.5);
  return [...offsetBezier(left, d, depth + 1), ...offsetBezier(right, d, depth + 1)];
}

/**
 * A parallel copy `d` mm to the side (docs/29 §2): every segment offset with `offsetBezier`,
 * the pieces stitched back at the vertices — a smooth vertex meets itself, a corner is
 * **mitred** (with the panel's limit) so a rectangle stays a rectangle. Vertex types
 * survive; a curved side split for accuracy gains equal vertices at the splits. `+` is
 * outwards on a closed curve, the left-hand side of travel on an open one.
 */
export function offsetCurve(curve: Curve, d: number, sampling: CurveSampling = sampleCurve(curve)): Curve | null {
  const pts = curve.points;
  const n = pts.length;
  if (n < 2 || !d) return null;
  const closed = curve.closed && n > 2;
  const dl = closed && windingOf(sampling) > 0 ? -d : d;      // left of travel is +; on a loop outwards is
  const segs = segmentControls(pts, closed);
  const pieces = segs.map((b) => offsetBezier(b, dl));

  const out: Vertex[] = [];
  const nseg = segs.length;
  for (let i = 0; i < n; i++) {
    const v = pts[i];
    const prev = i > 0 ? pieces[i - 1] : closed ? pieces[nseg - 1] : null;
    const next = i < nseg ? pieces[i] : null;
    const endPrev = prev ? prev[prev.length - 1] : null, startNext = next ? next[0] : null;
    const nv = { ...vertex(v.x, v.y, v.type), in: { ...v.in }, out: { ...v.out } };
    let at: Vec2;
    if (endPrev && startNext && len(sub(endPrev[3], startNext[0])) > 1e-6) {
      // a corner: the two offset sides meet at the mitre (limited), as the panel's expand does
      const ta = bezTangent(segs[i > 0 ? i - 1 : nseg - 1], 1), tb = bezTangent(segs[i], 0);
      const na = ta ? leftOf(ta) : null, nb = tb ? leftOf(tb) : null;
      if (na && nb) {
        let vx = na.x + nb.x, vy = na.y + nb.y;
        const k = 1 + dot(na, nb);
        if (k > 1 / MITRE) { vx /= k; vy /= k; }
        else { const l = Math.hypot(vx, vy); if (l < EPS) { vx = na.x; vy = na.y; } else { vx = (vx / l) * MITRE; vy = (vy / l) * MITRE; } }
        at = { x: v.x + vx * dl, y: v.y + vy * dl };
      } else at = endPrev[3];
    } else at = (startNext ?? endPrev)![startNext ? 0 : 3];
    nv.x = at.x; nv.y = at.y;
    if (v.type !== 'polygon') {
      if (endPrev) nv.in = { ...v3(sub(endPrev[2], at)), z: v.in.z };
      if (startNext) nv.out = { ...v3(sub(startNext[1], at)), z: v.out.z };
    }
    nv.z = v.z;                                   // a spatial curve is offset in the plane, z rides along (docs/30 §3)
    out.push(nv);
    // the splits inside this vertex's outgoing side become equal vertices (z interpolated along the side)
    if (next) for (let k = 0; k + 1 < next.length; k++) {
      const a = next[k], b = next[k + 1];
      const mid = a[3];
      const zNext = pts[(i + 1) % n].z;
      out.push({ ...vertex(mid.x, mid.y, 'equal', v.z + ((zNext - v.z) * (k + 1)) / next.length), in: v3(sub(a[2], mid)), out: v3(sub(b[1], mid)) });
    }
  }
  return { closed: curve.closed, points: out };
}

/** Nearest sampled point of the curve to `q`, with the signed perpendicular distance (left of travel > 0). */
export function signedDistance(sampling: CurveSampling, q: Vec2): { s: number; d: number; p: Vec2 } | null {
  const all = sampling.samples;
  if (all.length < 2) return null;
  let best = 0, bestD = Infinity;
  all.forEach((p, i) => { const dd = (p.x - q.x) ** 2 + (p.y - q.y) ** 2; if (dd < bestD) { bestD = dd; best = i; } });
  const p = all[best];
  const a = all[Math.max(0, best - 1)], b = all[Math.min(all.length - 1, best + 1)];
  const t = unit(sub(b, a));
  const d = t ? cross(t, sub(q, p)) : Math.sqrt(bestD);
  return { s: p.s, d, p: { x: p.x, y: p.y } };
}

// -- intersections ----------------------------------------------------------------

export interface Crossing { sa: number; sb: number; p: Vec2 }

/** Where segment p→p2 crosses q→q2: the parameters along each, or null (parallel / apart). */
function segmentsCross(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): { u: number; v: number } | null {
  const r = sub(p2, p), s = sub(q2, q);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const qp = sub(q, p);
  const u = cross(qp, s) / den, v = cross(qp, r) / den;
  if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) return null;
  return { u, v };
}

function pointAt(path: THREE.CurvePath<THREE.Vector3>, length: number, s: number): Vec2 {
  const p = path.getPointAt(Math.min(1, Math.max(0, s / length)));
  return { x: p.x, y: p.y };
}
function tangentAt(path: THREE.CurvePath<THREE.Vector3>, length: number, s: number): Vec2 {
  const t = path.getTangentAt(Math.min(1, Math.max(0, s / length)));
  return unit({ x: t.x, y: t.y }) ?? { x: 1, y: 0 };
}

/**
 * Every crossing of curve a with curve b, as arc lengths on both. Found on the sampled
 * polylines and refined on the Bézier paths (a few Newton steps), so a cut lands within
 * a hundredth of a millimetre. Touching ends count once; overlaps do not count.
 */
export function intersections(a: CurveSampling, b: CurveSampling): Crossing[] {
  const A = a.samples, B = b.samples;
  if (A.length < 2 || B.length < 2 || !a.path || !b.path) return [];
  const out: Crossing[] = [];
  // bounding boxes of b's segments, once
  const bb = B.slice(0, -1).map((q, j) => { const q2 = B[j + 1]; return { x0: Math.min(q.x, q2.x), x1: Math.max(q.x, q2.x), y0: Math.min(q.y, q2.y), y1: Math.max(q.y, q2.y) }; });
  for (let i = 0; i + 1 < A.length; i++) {
    const p = A[i], p2 = A[i + 1];
    const x0 = Math.min(p.x, p2.x), x1 = Math.max(p.x, p2.x), y0 = Math.min(p.y, p2.y), y1 = Math.max(p.y, p2.y);
    for (let j = 0; j + 1 < B.length; j++) {
      const box = bb[j];
      if (box.x1 < x0 || box.x0 > x1 || box.y1 < y0 || box.y0 > y1) continue;
      const hit = segmentsCross(p, p2, B[j], B[j + 1]);
      if (!hit) continue;
      let sa = p.s + (p2.s - p.s) * hit.u, sb = B[j].s + (B[j + 1].s - B[j].s) * hit.v;
      // refine: solve A(sa) − B(sb) = 0 with the tangents as the Jacobian
      for (let it = 0; it < 4; it++) {
        const pa = pointAt(a.path, a.length, sa), pb = pointAt(b.path, b.length, sb);
        const f = sub(pa, pb);
        if (len(f) < 1e-6) break;
        const ta = tangentAt(a.path, a.length, sa), tb = tangentAt(b.path, b.length, sb);
        const den = cross(ta, tb);   // solve ta·da − tb·db = −f
        if (Math.abs(den) < 1e-9) break;
        const da = -cross(f, tb) / den, db = -cross(f, ta) / den;
        if (Math.abs(da) > 2 * (p2.s - p.s) + 1 || Math.abs(db) > 2 * (B[j + 1].s - B[j].s) + 1) break;
        sa += da; sb += db;
      }
      sa = Math.min(a.length, Math.max(0, sa)); sb = Math.min(b.length, Math.max(0, sb));
      const pt = pointAt(a.path, a.length, sa);
      if (out.some((c) => Math.abs(c.sa - sa) < CUT_TOL && len(sub(c.p, pt)) < CUT_TOL)) continue;   // the seam of a loop shows the same crossing twice
      out.push({ sa, sb, p: pt });
    }
  }
  return out.sort((x, y) => x.sa - y.sa);
}

// -- cutting ------------------------------------------------------------------

/**
 * Make sure a vertex sits at arc length `s`: the index of the one already there (within
 * `CUT_TOL`), else the index of a new one from a de Casteljau split — the shape is unchanged,
 * the neighbours' handles adjusted as when a point is inserted in Edit mode. Mutates `curve`.
 */
export function cutAt(curve: Curve, s: number): { index: number; inserted: boolean } | null {
  const sampling = sampleCurve(curve);
  if (!sampling.path) return null;
  const at = vertexArcLengths(curve, sampling);
  const total = sampling.length;
  const closed = curve.closed && curve.points.length > 2;
  for (let i = 0; i < at.length; i++) if (Math.abs(at[i] - s) < CUT_TOL || (i === 0 && closed && Math.abs(total - s) < CUT_TOL)) return { index: i, inserted: false };
  if (!closed && Math.abs(total - s) < CUT_TOL) return { index: at.length - 1, inserted: false };
  const split = splitCurveAt(curve, sampling, s);
  if (!split) return null;
  const pts = curve.points;
  const n = pts.length;
  const prev = pts[(split.index - 1 + n) % n], next = pts[split.index % n];
  if (prev.type !== 'polygon') prev.out = split.prevOut;
  if (next.type !== 'polygon') next.in = split.nextIn;
  pts.splice(split.index, 0, split.vertex);
  return { index: split.index, inserted: true };
}

/** Cut at two arc lengths; the indices come back valid together (the second cut may shift the first). */
function cutTwice(curve: Curve, s1: number, s2: number): [number, number] | null {
  const big = Math.max(s1, s2), small = Math.min(s1, s2);
  const b = cutAt(curve, big);
  if (!b) return null;
  const a = cutAt(curve, small);
  if (!a) return null;
  let ib = b.index;
  if (a.inserted && a.index <= ib) ib++;
  return s1 <= s2 ? [a.index, ib] : [ib, a.index];
}

/**
 * The span Trim removes around arc length `s` (docs/29 §3): from the cut before it to the
 * cut after it. On an open curve a missing side is null (the piece runs to the end); on a
 * loop both are numbers and `lo > hi` means the span wraps through the start. Null when
 * there is nothing to trim against.
 */
export function trimSpan(curve: Curve, sampling: CurveSampling, s: number, cuts: number[]): { lo: number | null; hi: number | null } | null {
  const n = curve.points.length;
  if (n < 2 || !sampling.path) return null;
  const L = sampling.length;
  const closed = curve.closed && n > 2;
  const list = [...cuts]
    .map((c) => (closed ? ((c % L) + L) % L : c))
    .filter((c) => closed || (c > CUT_TOL && c < L - CUT_TOL))
    .sort((x, y) => x - y)
    .filter((c, i, arr) => i === 0 || c - arr[i - 1] > CUT_TOL);
  if (closed && list.length >= 2 && list[0] < CUT_TOL && L - list[list.length - 1] < CUT_TOL) list.pop();
  let lo: number | null = null, hi: number | null = null;
  for (const c of list) { if (c < s) lo = c; else if (c > s && hi === null) hi = c; }
  if (closed) {
    if (list.length < 2) return null;
    lo ??= list[list.length - 1];
    hi ??= list[0];
  } else if (lo === null && hi === null) return null;
  return { lo, hi };
}

/**
 * Trim (docs/29 §3): remove the piece around arc length `s`, bounded by the nearest `cuts`
 * on either side (or the ends). Returns the vertex lists that remain — none, one or two
 * for an open curve, one (open) for a closed one — or null when there is nothing to
 * trim against (no cut on either side; fewer than two on a closed curve).
 */
export function trimPieces(curve: Curve, sampling: CurveSampling, s: number, cuts: number[]): { pieces: Vertex[][]; removed: Id[] } | null {
  const span = trimSpan(curve, sampling, s, cuts);
  if (!span) return null;
  const { lo, hi } = span;
  const closed = curve.closed && curve.points.length > 2;
  const c = cloneCurve(curve);
  const before = new Set(c.points.map((v) => v.id));
  let il: number, ih: number;
  if (lo !== null && hi !== null) {
    const both = cutTwice(c, lo, hi);
    if (!both) return null;
    [il, ih] = both;
  } else if (hi !== null) {
    const cut = cutAt(c, hi); if (!cut) return null;
    il = 0; ih = cut.index;
  } else {
    const cut = cutAt(c, lo!); if (!cut) return null;
    il = cut.index; ih = c.points.length - 1;
  }
  if (il === ih) return null;
  const pts = c.points;
  // what stays: on a loop the run from the cut after the pointer round to the cut before it
  let pieces: Vertex[][] = closed
    ? [il < ih ? [...pts.slice(ih), ...pts.slice(0, il + 1)] : pts.slice(ih, il + 1)]
    : [pts.slice(0, il + 1), pts.slice(ih)];
  pieces = pieces.filter((p) => p.length >= 2);
  const kept = new Set(pieces.flat().map((v) => v.id));
  return { pieces, removed: [...before].filter((id) => !kept.has(id)) };
}

// -- fillet -------------------------------------------------------------------

export interface FilletResult { curve: Curve; removed: Id[]; added: [Id, Id] }

/**
 * Round the corner at vertex `index` with radius `r` (docs/29 §4.1): the sides are cut back
 * `r·tan(φ/2)` and joined by one cubic — a circular arc of radius `r` between straight sides.
 * Null when the vertex is not a corner, is an open end, or `r` does not fit the sides.
 */
export function filletCorner(curve: Curve, sampling: CurveSampling, index: number, r: number): FilletResult | null {
  const pts = curve.points;
  const n = pts.length;
  const closed = curve.closed && n > 2;
  if (n < 3 || r < 0 || !sampling.path) return null;
  if (!closed && (index <= 0 || index >= n - 1)) return null;
  const t = tangentsAt(pts, closed, index);
  if (!t.in || !t.out) return null;
  const phi = Math.atan2(Math.abs(cross(t.in, t.out)), dot(t.in, t.out));
  if (phi < 0.5 * Math.PI / 180 || phi > 179.5 * Math.PI / 180) return null;
  const back = r * Math.tan(phi / 2);
  if (back < CUT_TOL) return null;                          // r = 0: the corner stays sharp
  const lengths = sampling.path.getCurveLengths();
  const segLen = (i: number) => lengths[i] - (i > 0 ? lengths[i - 1] : 0);
  const nseg = lengths.length;
  const prevSeg = (index - 1 + nseg) % nseg, nextSeg = index % nseg;
  if (back > segLen(prevSeg) - CUT_TOL || back > segLen(nextSeg) - CUT_TOL) return null;
  const L = sampling.length;
  const sV = vertexArcLengths(curve, sampling)[index];
  let sA = sV - back, sB = sV + back;
  if (closed) { sA = ((sA % L) + L) % L; sB = sB % L; }

  const c = cloneCurve(curve);
  const vid = c.points[index].id;
  if (!cutTwice(c, sA, sB)) return null;
  const iV = c.points.findIndex((v) => v.id === vid);
  const m = c.points.length;
  const A = c.points[(iV - 1 + m) % m], B = c.points[(iV + 1) % m];
  if (A === B || A.id === vid) return null;
  c.points.splice(iV, 1);

  // the arc: tangent to each side at its cut, through both cuts
  const tA = unit({ x: -A.in.x, y: -A.in.y }) ?? t.in;
  const tB = unit({ x: B.out.x, y: B.out.y }) ?? t.out;
  const iA = c.points.indexOf(A);
  const segsNow = segmentControls(c.points, closed);
  const straightBefore = iA > 0 ? isStraight(segsNow[iA - 1]) : closed ? isStraight(segsNow[segsNow.length - 1]) : true;
  const iB = c.points.indexOf(B);
  const straightAfter = iB < segsNow.length ? isStraight(segsNow[iB]) : true;
  A.type = 'free'; B.type = 'free';
  if (straightBefore) A.in = { x: 0, y: 0, z: 0 };
  if (straightAfter) B.out = { x: 0, y: 0, z: 0 };
  const added = arcBetween(A, B, tA, tB);
  c.points.splice(iA + 1, 0, ...added);
  return { curve: c, removed: [vid], added: [A.id, B.id] };
}

/**
 * Join A to B with a circular arc tangent to `tA` at A and `tB` at B: sets A.out and B.in and
 * returns the equal vertices to insert between them — one cubic covers up to 50°, wider
 * turns get more spans so the bend radius holds to a tenth of a percent along the arc.
 */
function arcBetween(A: Vertex, B: Vertex, tA: Vec2, tB: Vec2): Vertex[] {
  const chord = len(sub(B, A));
  const ang = Math.atan2(Math.abs(cross(tA, tB)), dot(tA, tB));
  if (ang < EPS) {
    A.out = { x: tA.x * chord / 3, y: tA.y * chord / 3, z: 0 };
    B.in = { x: -tB.x * chord / 3, y: -tB.y * chord / 3, z: 0 };
    return [];
  }
  const R = chord / (2 * Math.sin(ang / 2));
  const spans = Math.max(1, Math.ceil(ang / (50 * Math.PI / 180) - 1e-9));
  const step = ang / spans;
  const k = (4 / 3) * Math.tan(step / 4) * R;
  const turn = Math.sign(cross(tA, tB));                    // which way the arc bends
  const centre = { x: A.x + leftOf(tA).x * R * turn, y: A.y + leftOf(tA).y * R * turn };
  const rot = (v: Vec2, a: number): Vec2 => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
  const added: Vertex[] = [];
  let tan = tA, prev: Vertex = A;
  for (let i = 1; i <= spans; i++) {
    prev.out = { x: tan.x * k, y: tan.y * k, z: 0 };
    const tNext = i === spans ? tB : rot(tA, step * i * turn);
    let next: Vertex;
    if (i === spans) next = B;
    else {
      const radial = rot(sub(A, centre), step * i * turn);
      next = { ...vertex(centre.x + radial.x, centre.y + radial.y, 'equal'), in: { x: 0, y: 0, z: 0 }, out: { x: 0, y: 0, z: 0 } };
      added.push(next);
    }
    next.in = { x: -tNext.x * k, y: -tNext.y * k, z: 0 };
    tan = tNext; prev = next;
  }
  return added;
}

// -- two curves to one corner -----------------------------------------------------

export interface CornerJoin { curve: Curve; corner: Id; removed: Id[] }

/** The curve run the other way (in / out handles swapped), as a new list. */
function reversed(pts: Vertex[]): Vertex[] {
  return [...pts].reverse().map((v) => ({ ...v, in: { ...v.out }, out: { ...v.in } }));
}

/**
 * Bring the nearest ends of two open curves to their corner and make one curve of them
 * (docs/29 §4.2): trimmed back to the crossing when they cross, extended straight along
 * the end tangents to where those meet otherwise (a straight end that overshoots the corner
 * is trimmed back to it). The corner is one vertex — polygon when both sides arrive straight,
 * free otherwise. Null when the ends are parallel, or the corner lies behind a curved end.
 * Fillet the corner afterwards with `filletCorner`.
 */
export function cornerJoin(a: Curve, b: Curve): CornerJoin | null {
  if (a.closed || b.closed || a.points.length < 2 || b.points.length < 2) return null;
  const pa = a.points, pb = b.points;
  const d = (p: Vec2, q: Vec2) => len(sub(p, q));
  const best = [
    { dist: d(pa[pa.length - 1], pb[0]), ra: false, rb: false },
    { dist: d(pa[pa.length - 1], pb[pb.length - 1]), ra: false, rb: true },
    { dist: d(pa[0], pb[0]), ra: true, rb: false },
    { dist: d(pa[0], pb[pb.length - 1]), ra: true, rb: true },
  ].sort((x, y) => x.dist - y.dist)[0];
  const A: Curve = { closed: false, points: best.ra ? reversed(cloneCurve(a).points) : cloneCurve(a).points };
  const B: Curve = { closed: false, points: best.rb ? reversed(cloneCurve(b).points) : cloneCurve(b).points };
  const before = [...A.points, ...B.points].map((v) => v.id);

  const sa = sampleCurve(A), sb = sampleCurve(B);
  const hits = intersections(sa, sb);
  if (hits.length) {
    // the crossing nearest the ends: short overshoots go, the rest stays
    const hit = [...hits].sort((x, y) => (sa.length - x.sa + x.sb) - (sa.length - y.sa + y.sb))[0];
    const ca = cutAt(A, hit.sa), cb = cutAt(B, hit.sb);
    if (!ca || !cb) return null;
    A.points = A.points.slice(0, ca.index + 1);
    B.points = B.points.slice(cb.index);
  } else {
    const ea = A.points[A.points.length - 1], eb = B.points[0];
    const ta = tangentsAt(A.points, false, A.points.length - 1).in;
    const tbIn = tangentsAt(B.points, false, 0).out;
    if (!ta || !tbIn) return null;
    const tb = { x: -tbIn.x, y: -tbIn.y };                 // back along b, away from its start
    const den = cross(ta, tb);
    if (Math.abs(den) < 1e-6) return null;                  // parallel ends
    const w = sub(eb, ea);
    const u = cross(w, tb) / den, v = cross(w, ta) / den;   // ea + ta·u = eb + tb·v
    const P = { x: ea.x + ta.x * u, y: ea.y + ta.y * u };
    const segsA = segmentControls(A.points, false), segsB = segmentControls(B.points, false);
    const lastA = segsA[segsA.length - 1], firstB = segsB[0];
    // behind an end: the corner is on the end segment itself when that is straight — trim back to it
    if (u < -CUT_TOL && !(isStraight(lastA) && -u <= len(sub(lastA[3], lastA[0])) + CUT_TOL)) return null;
    if (v < -CUT_TOL && !(isStraight(firstB) && -v <= len(sub(firstB[3], firstB[0])) + CUT_TOL)) return null;
    if (Math.abs(u) > CUT_TOL) {
      if (isStraight(lastA)) { ea.x = P.x; ea.y = P.y; }
      else { if (ea.type === 'equal') ea.type = 'free'; ea.out = { x: 0, y: 0, z: 0 }; A.points.push(vertex(P.x, P.y, 'polygon')); }
    }
    if (Math.abs(v) > CUT_TOL) {
      if (isStraight(firstB)) { eb.x = P.x; eb.y = P.y; }
      else { if (eb.type === 'equal') eb.type = 'free'; eb.in = { x: 0, y: 0, z: 0 }; B.points.unshift(vertex(P.x, P.y, 'polygon')); }
    }
  }
  if (A.points.length < 2 || B.points.length < 2) return null;
  // merge the two corner vertices into a's
  const corner = A.points[A.points.length - 1], other = B.points[0];
  corner.x = (corner.x + other.x) / 2; corner.y = (corner.y + other.y) / 2;
  corner.out = { ...other.out };
  const straightIn = corner.type === 'polygon' || len(corner.in) < EPS;
  const straightOut = other.type === 'polygon' || len(other.out) < EPS;
  if (straightIn) corner.in = { x: 0, y: 0, z: 0 };
  if (straightOut) corner.out = { x: 0, y: 0, z: 0 };
  corner.type = straightIn && straightOut ? 'polygon' : 'free';
  const points = [...A.points, ...B.points.slice(1)];
  const kept = new Set(points.map((v) => v.id));
  return { curve: { closed: false, points }, corner: corner.id, removed: before.filter((id) => !kept.has(id)) };
}
