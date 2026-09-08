/**
 * Project a curve onto another plane (docs/34-project.md): its shadow cast along the target
 * plane's normal. Vertices and handles go through the source frame to world and into the
 * target frame; the affine image of a cubic Bézier is the Bézier of the mapped control
 * points, so the copy is exact and keeps the source's vertices and types.
 */
import { uid, type Curve, type Vec3, type Vertex } from '../model/types';
import { fromPlane, toPlane, type PlaneFrame } from './placement';

/** A projection whose control points span less than this (mm) has collapsed to a point. */
export const PROJECT_MIN = 0.1;

/** The curve drawn in `from`, as a planar curve on `to` (fresh vertex ids); null when it collapses. */
export function projectCurve(curve: Curve, from: PlaneFrame, to: PlaneFrame): Curve | null {
  const map = (p: Vec3) => toPlane(to, fromPlane(from, p, p.z));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const points: Vertex[] = curve.points.map((v) => {
    const p = map(v);
    const hin = map({ x: v.x + v.in.x, y: v.y + v.in.y, z: v.z + v.in.z });
    const hout = map({ x: v.x + v.out.x, y: v.y + v.out.y, z: v.z + v.out.z });
    for (const q of v.type === 'polygon' ? [p] : [p, hin, hout]) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
    return { id: uid(), type: v.type, x: p.x, y: p.y, z: 0, in: { x: hin.x - p.x, y: hin.y - p.y, z: 0 }, out: { x: hout.x - p.x, y: hout.y - p.y, z: 0 } };
  });
  if (points.length < 2 || Math.max(maxX - minX, maxY - minY) < PROJECT_MIN) return null;
  return { points, closed: curve.closed };
}
