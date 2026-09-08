/** Affine transforms of curves in plane coordinates. Pure, no three.js. */
import type { CurveObject, Vec2, Vec3, Vertex, VertexConstraint } from './types';

/**
 * In the plane: p' = pivot + R(angle) · S(sx, sy) · (p − pivot) + t.
 * Along the normal (3D curves, docs/12-3d-curves.md): z' = sz · z + tz (default: unchanged).
 */
export interface Affine2 { pivot: Vec2; angle: number; sx: number; sy: number; tx: number; ty: number; tz?: number; sz?: number }

export const IDENTITY: Affine2 = { pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1, tx: 0, ty: 0 };

export function translation(tx: number, ty: number, tz = 0): Affine2 {
  return { ...IDENTITY, tx, ty, tz };
}

function linear(v: Vec3, a: Affine2): Vec3 {
  const x = v.x * a.sx, y = v.y * a.sy;
  const c = Math.cos(a.angle), s = Math.sin(a.angle);
  return { x: x * c - y * s, y: x * s + y * c, z: v.z * (a.sz ?? 1) };
}

export function applyAffine(p: Vec3, a: Affine2): Vec3 {
  const l = linear({ x: p.x - a.pivot.x, y: p.y - a.pivot.y, z: p.z }, a);
  return { x: a.pivot.x + l.x + a.tx, y: a.pivot.y + l.y + a.ty, z: l.z + (a.tz ?? 0) };
}

export interface CurveSnapshot { points: Vertex[]; constraints: VertexConstraint[]; closed: boolean }

export function snapshotCurve(c: CurveObject): CurveSnapshot {
  return JSON.parse(JSON.stringify({ points: c.curve.points, constraints: c.constraints, closed: c.curve.closed })) as CurveSnapshot;
}

/** Rebuild `target` from `original` transformed by `a` (vertices, handles, pins, distances). */
export function transformCurve(target: CurveObject, original: CurveSnapshot, a: Affine2): void {
  target.curve.points = original.points.map((v) => {
    const p = applyAffine(v, a);
    return { ...v, x: p.x, y: p.y, z: p.z, in: linear(v.in, a), out: linear(v.out, a) };
  });
  const k = (Math.abs(a.sx) + Math.abs(a.sy)) / 2;
  target.constraints = original.constraints.map((c) => ({
    ...c,
    at: c.at ? applyAffine(c.at, a) : undefined,
    value: c.type === 'distance' && c.value !== undefined ? c.value * k : c.value,
  }));
}
