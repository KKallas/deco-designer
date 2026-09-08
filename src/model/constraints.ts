/**
 * Vertex constraint solver: iterative projection. The vertices in `fixed`
 * (e.g. the one being dragged, and pinned ones) never move; the partner
 * follows. Pure, no three.js. Horizontal / vertical are plane relations
 * (same y / same x); distance and pin work in 3D (z = 0 on planar curves,
 * docs/12-3d-curves.md).
 */
import type { Curve, Id, VertexConstraint } from './types';

const TOL = 0.05;

export function isPinned(constraints: VertexConstraint[], vertexId: Id): boolean {
  return constraints.some((c) => c.type === 'pin' && c.a === vertexId);
}

export function solveConstraints(curve: Curve, constraints: VertexConstraint[], fixed: Iterable<Id> = [], iterations = 30): void {
  const byId = new Map(curve.points.map((v) => [v.id, v]));
  const locked = new Set(fixed);
  for (const c of constraints) if (c.type === 'pin') locked.add(c.a);

  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (const c of constraints) {
      const a = byId.get(c.a), b = c.b ? byId.get(c.b) : undefined;
      if (!a) continue;
      if (c.type === 'pin') {
        const z = c.at?.z ?? 0;
        if (c.at && (a.x !== c.at.x || a.y !== c.at.y || a.z !== z)) { a.x = c.at.x; a.y = c.at.y; a.z = z; moved = true; }
        continue;
      }
      if (!b) continue;
      const fa = locked.has(a.id), fb = locked.has(b.id);
      if (fa && fb) continue;
      if (c.type === 'horizontal' || c.type === 'vertical') {
        const k = c.type === 'horizontal' ? 'y' : 'x';
        const d = a[k] - b[k];
        if (Math.abs(d) < TOL) continue;
        if (fa) b[k] = a[k]; else if (fb) a[k] = b[k]; else { const m = (a[k] + b[k]) / 2; a[k] = m; b[k] = m; }
        moved = true;
      } else if (c.type === 'distance') {
        const target = Math.max(0, c.value ?? 0);
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) { dx = 1; dy = 0; dz = 0; d = 1; }
        const diff = target - d;
        if (Math.abs(diff) < TOL) continue;
        const ux = dx / d, uy = dy / d, uz = dz / d;
        if (fa) { b.x = a.x + ux * target; b.y = a.y + uy * target; b.z = a.z + uz * target; }
        else if (fb) { a.x = b.x - ux * target; a.y = b.y - uy * target; a.z = b.z - uz * target; }
        else { a.x -= ux * diff / 2; a.y -= uy * diff / 2; a.z -= uz * diff / 2; b.x += ux * diff / 2; b.y += uy * diff / 2; b.z += uz * diff / 2; }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** Which constraints currently hold (after solving, only over-constrained ones fail). */
export function checkConstraints(curve: Curve, constraints: VertexConstraint[]): Map<Id, boolean> {
  const byId = new Map(curve.points.map((v) => [v.id, v]));
  const out = new Map<Id, boolean>();
  for (const c of constraints) {
    const a = byId.get(c.a), b = c.b ? byId.get(c.b) : undefined;
    let ok = !!a;
    if (a) {
      if (c.type === 'pin') ok = !c.at || (Math.abs(a.x - c.at.x) < TOL && Math.abs(a.y - c.at.y) < TOL && Math.abs(a.z - (c.at.z ?? 0)) < TOL);
      else if (!b) ok = false;
      else if (c.type === 'horizontal') ok = Math.abs(a.y - b.y) < TOL;
      else if (c.type === 'vertical') ok = Math.abs(a.x - b.x) < TOL;
      else ok = Math.abs(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) - (c.value ?? 0)) < TOL;
    }
    out.set(c.id, ok);
  }
  return out;
}
