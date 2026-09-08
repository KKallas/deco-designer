/** Offset, trim and fillet between curves on one plane (docs/29-offset-trim-fillet.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findCurve, vertex, type Curve, type Id } from '../src/model/types';
import { sampleCurve, curveBounds } from '../src/geometry/curve';
import { cornerJoin, filletCorner, intersections, offsetCurve, signedDistance, trimPieces, turnAt } from '../src/geometry/modify';

const store = () => new Store(emptyProject('Modify', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));

/** A polyline through `pts` on the given plane (a fresh front plane when none). */
function drawn(s: Store, pts: [number, number][], plane?: Id, closed = false): Id {
  const pid = plane ?? cmd.addPlane(s, 'front');
  const id = cmd.addCurve(s, pid);
  for (const [x, y] of pts) cmd.addVertex(s, id, { x, y });
  if (closed) cmd.toggleClosed(s, id);
  cmd.exitEdit(s);
  return id;
}

const poly = (pts: [number, number][], closed = false): Curve => ({ closed, points: pts.map(([x, y]) => vertex(x, y)) });
const pts = (s: Store, id: Id) => findCurve(s.project, id)!.curve.points;
const xy = (c: Curve) => c.points.map((v) => [Math.round(v.x * 100) / 100 + 0, Math.round(v.y * 100) / 100 + 0]);
const xs = (s: Store, id: Id) => pts(s, id).map((v) => Math.round(v.x * 100) / 100);

/** A circle of radius r about the origin as four equal vertices (the usual 0.5523 handle). */
function circle(r: number, clockwise = false): Curve {
  const k = 0.5522847498 * r;
  const q: [number, number, number, number][] = [[r, 0, 0, k], [0, r, -k, 0], [-r, 0, 0, -k], [0, -r, k, 0]];
  const points = q.map(([x, y, hx, hy]) => ({ ...vertex(x, y, 'equal'), in: { x: -hx, y: -hy, z: 0 }, out: { x: hx, y: hy, z: 0 } }));
  if (clockwise) points.reverse().forEach((v) => { const t = v.in; v.in = v.out; v.out = t; });
  return { closed: true, points };
}

describe('offset', () => {
  it('grows a rectangle outwards by +d and shrinks it by −d, whichever way it was drawn', () => {
    for (const ccw of [true, false]) {
      const corners: [number, number][] = ccw ? [[0, 0], [400, 0], [400, 200], [0, 200]] : [[0, 0], [0, 200], [400, 200], [400, 0]];
      const rect = poly(corners, true);
      const big = offsetCurve(rect, 10)!;
      const b = curveBounds(big.points);
      expect([b.min.x, b.min.y, b.max.x, b.max.y].map((n) => Math.round(n))).toEqual([-10, -10, 410, 210]);
      expect(big.points.every((v) => v.type === 'polygon')).toBe(true);        // mitred: still a rectangle
      const small = offsetCurve(rect, -10)!;
      const s = curveBounds(small.points);
      expect([s.min.x, s.min.y, s.max.x, s.max.y].map((n) => Math.round(n))).toEqual([10, 10, 390, 190]);
    }
  });

  it('puts an open line on its left for +d and keeps the end handles', () => {
    const line = poly([[0, 0], [1000, 0]]);
    expect(xy(offsetCurve(line, 25)!)).toEqual([[0, 25], [1000, 25]]);
    expect(xy(offsetCurve(line, -25)!)).toEqual([[0, -25], [1000, -25]]);
    const up = poly([[0, 0], [0, 1000]]);
    expect(xy(offsetCurve(up, 25)!)).toEqual([[-25, 0], [-25, 1000]]);
  });

  it('offsets a circle to a circle of r ± d within a fraction of a millimetre', () => {
    for (const cw of [false, true]) {
      const out = offsetCurve(circle(100, cw), 20)!;
      const radii = sampleCurve(out).samples.map((p) => Math.hypot(p.x, p.y));
      expect(Math.min(...radii)).toBeGreaterThan(119.5);
      expect(Math.max(...radii)).toBeLessThan(120.5);
      expect(out.points.every((v) => v.type === 'equal')).toBe(true);
      const inner = offsetCurve(circle(100, cw), -30)!;
      const r2 = sampleCurve(inner).samples.map((p) => Math.hypot(p.x, p.y));
      expect(Math.min(...r2)).toBeGreaterThan(69.5);
      expect(Math.max(...r2)).toBeLessThan(70.5);
    }
  });

  it('measures the pointer side and distance from a curve', () => {
    const sm = sampleCurve(poly([[0, 0], [1000, 0]]));
    expect(signedDistance(sm, { x: 500, y: 40 })!.d).toBeCloseTo(40, 3);
    expect(signedDistance(sm, { x: 500, y: -40 })!.d).toBeCloseTo(-40, 3);
    expect(signedDistance(sm, { x: 502, y: 40 })!.s).toBeCloseTo(500, 0);
  });
});

describe('intersections and trim', () => {
  it('finds where two lines cross, as arc lengths on both', () => {
    const a = sampleCurve(poly([[0, 0], [1000, 0]])), b = sampleCurve(poly([[300, -200], [300, 200]]));
    const hits = intersections(a, b);
    expect(hits).toHaveLength(1);
    expect(hits[0].sa).toBeCloseTo(300, 3);
    expect(hits[0].sb).toBeCloseTo(200, 3);
    expect(hits[0].p.x).toBeCloseTo(300, 3);
  });

  it('finds a curved crossing to a hundredth of a millimetre', () => {
    const ring = sampleCurve(circle(100)), line = sampleCurve(poly([[-200, 0], [200, 0]]));
    const hits = intersections(line, ring);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => Math.round(h.sa))).toEqual([100, 300]);
    expect(Math.abs(hits[0].p.x + 100)).toBeLessThan(0.01);
  });

  it('removes the arm under the pointer, or the middle between two cuts', () => {
    const line = poly([[0, 0], [1000, 0]]);
    const sm = sampleCurve(line);
    const arm = trimPieces(line, sm, 900, [300])!;
    expect(arm.pieces).toHaveLength(1);
    expect(xy({ closed: false, points: arm.pieces[0] })).toEqual([[0, 0], [300, 0]]);
    const middle = trimPieces(line, sm, 500, [300, 700])!;
    expect(middle.pieces.map((p) => xy({ closed: false, points: p }))).toEqual([[[0, 0], [300, 0]], [[700, 0], [1000, 0]]]);
    expect(trimPieces(line, sm, 500, [])).toBeNull();                             // nothing to trim against
  });

  it('opens a closed curve between two cuts, wrapping through its start when needed', () => {
    const sq = poly([[0, 0], [400, 0], [400, 400], [0, 400]], true);
    const sm = sampleCurve(sq);
    const r = trimPieces(sq, sm, 200, [100, 300])!;              // the bottom side between x = 100 and 300 goes
    const p = r.pieces[0];
    expect(p[0].x).toBeCloseTo(300, 2); expect(p[p.length - 1].x).toBeCloseTo(100, 2);
    expect(p).toHaveLength(6);
    const w = trimPieces(sq, sm, 1500, [100, 300])!;             // the long way round goes: only the 200 mm bit stays
    expect(xy({ closed: false, points: w.pieces[0] })).toEqual([[100, 0], [300, 0]]);
    expect(trimPieces(sq, sm, 200, [100])).toBeNull();           // one cut on a loop: nothing to bound the piece
  });

  it('trims through the store: the other curves on the plane cut, spatial ones and other planes do not', () => {
    const s = store();
    const plane = cmd.addPlane(s, 'front');
    const line = drawn(s, [[0, 0], [1000, 0]], plane);
    drawn(s, [[300, -200], [300, 200]], plane);
    drawn(s, [[700, -200], [700, 200]], plane);
    drawn(s, [[500, -200], [500, 200]]);                          // another plane: no cut
    const ids = cmd.trimCurve(s, line, 500)!;
    expect(ids).toHaveLength(2);
    expect(xs(s, ids[0])).toEqual([0, 300]);
    expect(xs(s, ids[1])).toEqual([700, 1000]);
    expect(findCurve(s.project, ids[1])!.name).toBe('Curve 1 2');
    // the stub's only crossing is at its own end: nothing to trim against, nothing happens
    expect(cmd.trimCurve(s, ids[0], 100)).toBeNull();
    expect(findCurve(s.project, ids[0])).not.toBeNull();
  });
});

describe('fillet', () => {
  it('rounds a right angle with an arc of radius r between straight sides', () => {
    const L = poly([[0, 0], [500, 0], [500, 500]]);
    const sm = sampleCurve(L);
    expect(turnAt(L.points, false, 1)).toBeCloseTo(Math.PI / 2, 6);
    const f = filletCorner(L, sm, 1, 100)!;
    // a right angle is two 45° spans: the cuts, the arc's midpoint, and the sides untouched
    expect(xy(f.curve)).toEqual([[0, 0], [400, 0], [470.71, 29.29], [500, 100], [500, 500]]);
    expect(f.curve.points.map((v) => v.type)).toEqual(['polygon', 'free', 'equal', 'free', 'polygon']);
    expect(f.curve.points[1].in).toEqual({ x: 0, y: 0, z: 0 });                 // a straight side keeps no handle
    const out = sampleCurve(f.curve);
    expect(out.length).toBeCloseTo(400 + 400 + (Math.PI / 2) * 100, 0);
    const bent = out.samples.filter((p) => p.s > 405 && p.s < 400 + (Math.PI / 2) * 100 - 5);
    expect(Math.min(...bent.map((p) => p.radius))).toBeGreaterThan(99.8);
    expect(Math.max(...bent.map((p) => p.radius))).toBeLessThan(100.2);
    expect(filletCorner(L, sm, 1, 600)).toBeNull();               // does not fit the sides
    expect(filletCorner(L, sm, 0, 50)).toBeNull();                // an open end is not a corner
    expect(filletCorner(L, sm, 1, 0)).toBeNull();                 // r = 0: the corner stays
  });

  it('rounds every corner of a closed polygon, the first vertex too', () => {
    let sq = poly([[0, 0], [400, 0], [400, 400], [0, 400]], true);
    const first = filletCorner(sq, sampleCurve(sq), 0, 50)!;
    expect(first.curve.closed).toBe(true);
    expect(first.curve.points).toHaveLength(6);                                  // − the corner + two cuts + the arc's middle
    sq = first.curve;
    for (let i = 0; i < 3; i++) { const at = sq.points.findIndex((v) => v.type === 'polygon'); sq = filletCorner(sq, sampleCurve(sq), at, 50)!.curve; }
    expect(sq.points.every((v) => v.type !== 'polygon')).toBe(true);
    const bent = sampleCurve(sq).samples.filter((p) => p.radius < 1e6);
    expect(Math.min(...bent.map((p) => p.radius))).toBeGreaterThan(49.5);
    expect(sampleCurve(sq).length).toBeCloseTo(4 * 300 + 2 * Math.PI * 50, 0);
  });

  it('makes one curve of two that would meet: extended straight to the corner, sharp or rounded', () => {
    const a = poly([[0, 0], [400, 0]]), b = poly([[500, 100], [500, 500]]);
    const j = cornerJoin(a, b)!;
    expect(xy(j.curve)).toEqual([[0, 0], [500, 0], [500, 500]]);
    expect(j.curve.points[1].type).toBe('polygon');
    expect(j.curve.points[1].id).toBe(j.corner);
    const f = filletCorner(j.curve, sampleCurve(j.curve), 1, 100)!;
    expect(xy(f.curve)).toEqual([[0, 0], [400, 0], [470.71, 29.29], [500, 100], [500, 500]]);
    // one overshoots, the other falls short: the overshoot is trimmed, the short one extended
    expect(xy(cornerJoin(poly([[0, 0], [400, 0]]), poly([[300, 100], [300, 500]]))!.curve)).toEqual([[0, 0], [300, 0], [300, 500]]);
    // parallel ends: nothing
    expect(cornerJoin(poly([[0, 0], [400, 0]]), poly([[0, 100], [400, 100]]))).toBeNull();
  });

  it('trims two crossing curves back to their crossing', () => {
    const a = poly([[0, 0], [600, 0]]), b = poly([[500, -100], [500, 500]]);
    const j = cornerJoin(a, b)!;
    expect(xy(j.curve)).toEqual([[0, 0], [500, 0], [500, 500]]);
  });

  it('runs through the store: the corner join keeps the first curve, a bad radius does nothing', () => {
    const s = store();
    const plane = cmd.addPlane(s, 'front');
    const a = drawn(s, [[0, 0], [400, 0]], plane), b = drawn(s, [[500, 100], [500, 500]], plane);
    expect(cmd.filletCurves(s, a, b, 900)).toBeNull();
    expect(s.project.curves).toHaveLength(2);
    expect(cmd.filletCurves(s, a, b, 100)).toBe(a);
    expect(s.project.curves).toHaveLength(1);
    expect(pts(s, a).map((v) => [Math.round(v.x), Math.round(v.y)])).toEqual([[0, 0], [400, 0], [471, 29], [500, 100], [500, 500]]);
    expect(s.selection.curves).toEqual([a]);
    // a corner of one curve, by vertex id — the bend-radius check goes quiet once it is rounded to the limit
    const L = drawn(s, [[0, 0], [500, 0], [500, 500]], plane);
    const min = s.evals.get(L)!.layers[0].profile.limits.minBendRadius;
    expect(s.evals.get(L)!.violations.length).toBeGreaterThan(0);
    expect(cmd.filletVertex(s, L, pts(s, L)[1].id, min)).toBe(true);
    expect(s.evals.get(L)!.violations.filter((v) => v.check === 'minBendRadius')).toHaveLength(0);
  });

  it('offsets through the store: a new selected curve on the same plane with the same profile', () => {
    const s = store();
    const id = drawn(s, [[0, 0], [400, 0], [400, 200], [0, 200]], undefined, true);
    const copy = cmd.offsetCurve(s, id, 15)!;
    const c = findCurve(s.project, copy)!;
    expect(c.planeId).toBe(findCurve(s.project, id)!.planeId);
    expect(c.name).toBe('Curve 1 offset');
    expect(s.selection.curves).toEqual([copy]);
    const b = curveBounds(c.curve.points);
    expect([b.min.x, b.max.y].map(Math.round)).toEqual([-15, 215]);
    expect(cmd.offsetCurve(s, id, 0)).toBeNull();
  });
});
