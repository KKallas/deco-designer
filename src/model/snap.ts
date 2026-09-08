/** Alignment snapping: snap a point to share X and/or Y with candidate points. Pure. */
import type { Vec2 } from './types';

export interface Guide {
  /** 'h' = horizontal guide (same y), 'v' = vertical guide (same x) */
  axis: 'h' | 'v';
  value: number;
  source: Vec2;
}

export function alignSnap(p: Vec2, candidates: Vec2[], tol: number): { point: Vec2; guides: Guide[] } {
  let bx: Vec2 | null = null, by: Vec2 | null = null, dx = tol, dy = tol;
  for (const c of candidates) {
    const ex = Math.abs(c.x - p.x), ey = Math.abs(c.y - p.y);
    if (ex <= dx) { dx = ex; bx = c; }
    if (ey <= dy) { dy = ey; by = c; }
  }
  const guides: Guide[] = [];
  const point = { ...p };
  if (bx) { point.x = bx.x; guides.push({ axis: 'v', value: bx.x, source: bx }); }
  if (by) { point.y = by.y; guides.push({ axis: 'h', value: by.y, source: by }); }
  return { point, guides };
}
