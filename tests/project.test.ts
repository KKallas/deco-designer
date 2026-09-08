/** Project a curve onto another plane (docs/34-project.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findCurve, findGroup, findPlane, placementFor, vertex, type Curve, type Id } from '../src/model/types';
import { curvePath } from '../src/geometry/curve';
import { fromPlane, planeFrame, planeWorld, toPlane } from '../src/geometry/placement';
import { projectCurve } from '../src/geometry/project';

const store = () => new Store(emptyProject('Project', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));

function drawn(s: Store, pts: [number, number][], plane: Id, closed = false): Id {
  const id = cmd.addCurve(s, plane);
  for (const [x, y] of pts) cmd.addVertex(s, id, { x, y });
  if (closed) cmd.toggleClosed(s, id);
  cmd.exitEdit(s);
  return id;
}
const xy = (c: Curve) => c.points.map((v) => [Math.round(v.x * 100) / 100 + 0, Math.round(v.y * 100) / 100 + 0]);

/** A circle of radius r about the origin as four equal vertices. */
function circle(r: number): Curve {
  const k = 0.5522847498 * r;
  const q: [number, number, number, number][] = [[r, 0, 0, k], [0, r, -k, 0], [-r, 0, 0, -k], [0, -r, k, 0]];
  return { closed: true, points: q.map(([x, y, hx, hy]) => ({ ...vertex(x, y, 'equal'), in: { x: -hx, y: -hy, z: 0 }, out: { x: hx, y: hy, z: 0 } })) };
}

const FRONT = planeFrame(placementFor('front'));
const TOP = planeFrame(placementFor('top'));
const TILTED = planeFrame({ ...placementFor('front', { x: 100, y: 200, z: 300 }), rotation: { x: 60, y: 0, z: 0 } });

describe('projectCurve', () => {
  it('casts a front-plane polyline onto the top plane as its shadow along y', () => {
    const c: Curve = { closed: false, points: [vertex(0, 0), vertex(500, 300), vertex(800, -100)] };
    const p = projectCurve(c, FRONT, TOP)!;
    expect(xy(p)).toEqual([[0, 0], [500, 0], [800, 0]]);
    expect(p.points.map((v) => v.type)).toEqual(['polygon', 'polygon', 'polygon']);
    expect(p.points.every((v) => v.z === 0 && v.in.z === 0 && v.out.z === 0)).toBe(true);
    expect(p.points.map((v) => v.id)).not.toEqual(c.points.map((v) => v.id));
  });

  it('is the exact Bézier image: every point of the source, projected, lies on the copy at the same parameter', () => {
    const c = circle(200);
    const p = projectCurve(c, FRONT, TILTED)!;
    expect(p.closed).toBe(true);
    expect(p.points.map((v) => v.type)).toEqual(['equal', 'equal', 'equal', 'equal']);
    const a = curvePath(c.points, c.closed), b = curvePath(p.points, p.closed);
    for (let i = 0; i < a.curves.length; i++) for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      const world = fromPlane(FRONT, a.curves[i].getPoint(t));
      const shadow = toPlane(TILTED, world);
      const got = b.curves[i].getPoint(t);
      expect(got.x).toBeCloseTo(shadow.x, 6);
      expect(got.y).toBeCloseTo(shadow.y, 6);
    }
    // equal vertices keep collinear handles
    for (const v of p.points) {
      const cross = v.in.x * v.out.y - v.in.y * v.out.x;
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
  });

  it('carries a spatial curve\'s normal offsets into the shadow', () => {
    const c: Curve = { closed: false, points: [vertex(0, 0, 'polygon', 0), vertex(500, 0, 'polygon', 250)] };
    const p = projectCurve(c, FRONT, TOP)!;
    // front z = 250 is world z = 250, which is top-local y = −250
    expect(xy(p)).toEqual([[0, 0], [500, -250]]);
  });

  it('refuses a curve that collapses to a point', () => {
    const side = planeFrame(placementFor('side'));
    const c: Curve = { closed: false, points: [vertex(0, 0), vertex(500, 0)] };
    expect(projectCurve(c, FRONT, side)).toBeNull();
    expect(projectCurve(c, FRONT, TOP)).not.toBeNull();
  });
});

describe('cmd.projectCurves', () => {
  it('makes planar copies on the target plane, named after it, with the outline, selected, one undo step', () => {
    const s = store();
    const front = cmd.addPlane(s, 'front');
    const top = cmd.addPlane(s, 'top');
    cmd.setPlanePlacement(s, top, { position: { x: 0, y: 3000, z: 0 } });
    const a = drawn(s, [[0, 0], [500, 300]], front);
    const b = drawn(s, [[0, 0], [0, 400], [300, 400]], front, true);
    cmd.setCurveProfile(s, [a], 'round15');
    const before = s.project.curves.length;
    const ids = cmd.projectCurves(s, [a, b], top);
    expect(ids).toHaveLength(2);
    const ca = findCurve(s.project, ids[0])!, cb = findCurve(s.project, ids[1])!;
    expect(ca.planeId).toBe(top);
    expect(ca.type).toBe('planar');
    expect(ca.name).toBe(`${findCurve(s.project, a)!.name} on ${findPlane(s.project, top)!.name}`);
    expect(ca.outline.map((l) => l.profileId)).toEqual(['round15']);
    expect(ca.constraints).toEqual([]);
    expect(xy(ca.curve)).toEqual([[0, 0], [500, 0]]);
    expect(cb.curve.closed).toBe(true);
    expect(s.selection.curves).toEqual(ids);
    expect(s.selection.planeId).toBe(top);
    // the shadow sits on the raised plane in world
    const w = fromPlane(planeWorld(s.project, findPlane(s.project, top)!), ca.curve.points[1]);
    expect([w.x, w.y, w.z].map((n) => Math.round(n))).toEqual([500, 3000, 0]);
    s.undo();
    expect(s.project.curves).toHaveLength(before);
  });

  it('projects a spatial curve through a nested object\'s frame, and skips what collapses', () => {
    const s = store();
    const front = cmd.addPlane(s, 'front');
    const side = cmd.addPlane(s, 'side');
    const id = drawn(s, [[0, 0], [500, 0]], front);
    // flat along x: nothing to see from the side
    expect(cmd.projectCurves(s, [id], side)).toEqual([]);
    cmd.setCurveType(s, id, 'spatial');
    cmd.moveVertices(s, id, [{ vid: findCurve(s.project, id)!.curve.points[1].id, p: { z: 250 } }], false);
    const g = cmd.addGroup(s, [front])!;
    // the object's origin is the centre of its contents — lift it 1000 mm from wherever it landed
    const at = findGroup(s.project, g)!.placement.position;
    cmd.setGroupPlacement(s, g, { position: { ...at, y: at.y + 1000 } });
    const [pid] = cmd.projectCurves(s, [id], side);
    const p = findCurve(s.project, pid)!;
    // the shadow on the side plane: the 250 mm rise, 1000 mm up, x dropped
    const ws = p.curve.points.map((v) => fromPlane(planeWorld(s.project, findPlane(s.project, side)!), v));
    expect(ws.map((w) => [Math.round(w.x) + 0, Math.round(w.y) + 0, Math.round(w.z) + 0])).toEqual([[0, 1000, 0], [0, 1000, 250]]);
    expect(p.type).toBe('planar');
  });
});
