/** The plane's array: an axis anywhere in space, and committing the copies to curves (docs/26-array.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findPlane, migrateProject, type Id, type Vec3 } from '../src/model/types';
import { commitArray, instanceMatrices } from '../src/geometry/array';

const store = () => new Store(emptyProject('Array', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** A plane with one curve through `pts` on it. */
function drawn(s: Store, pts: (Vec3 | { x: number; y: number })[]): { plane: Id; curve: Id } {
  const plane = cmd.addPlane(s, 'front');
  const curve = cmd.addCurve(s, plane);
  cmd.setCurveType(s, curve, 'spatial');
  for (const p of pts) cmd.addVertex(s, curve, p);
  cmd.exitEdit(s);
  return { plane, curve };
}

const points = (s: Store, id: Id) => s.project.curves.find((c) => c.id === id)!.curve.points.map((v) => [round(v.x), round(v.y), round(v.z)]);

describe('array modifier', () => {
  it('turns about the line (centre, axis), not only the plane normal', () => {
    // quarter turn about the plane's Y through the origin: (100, 0, 0) → (0, 0, −100)
    const m = instanceMatrices({ type: 'circular', count: 2, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, angle: 90 })[1];
    const p = [100, 0, 0, 1];
    const e = m.elements;
    const out = [0, 1, 2].map((i) => round(e[i] * p[0] + e[4 + i] * p[1] + e[8 + i] * p[2] + e[12 + i]));
    expect(out).toEqual([0, 0, -100]);
  });

  it('an axis length is only a handle length: it does not scale the copies', () => {
    const a = instanceMatrices({ type: 'circular', count: 4, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 3000, z: 0 }, angle: 360 });
    const b = instanceMatrices({ type: 'circular', count: 4, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, angle: 360 });
    expect(a.map((m) => m.elements.map(round))).toEqual(b.map((m) => m.elements.map(round)));
  });

  it('reads an older project: the circular centre gains z, the axis is the plane normal', () => {
    const old = { ...emptyProject('Old', DEFAULT_PROFILES), version: 12, planes: [{ id: 'front', name: 'Front', placement: { preset: 'front', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, array: { type: 'circular', count: 6, center: { x: 10, y: 20 }, angle: 360 }, image: null }] };
    const p = migrateProject(JSON.parse(JSON.stringify(old)))!;
    expect(p.version).toBe(18);
    expect(p.planes[0].array).toEqual({ type: 'circular', count: 6, center: { x: 10, y: 20, z: 0 }, axis: { x: 0, y: 0, z: 1 }, angle: 360 });
  });
});

describe('commit', () => {
  it('bakes every copy into a curve and drops the modifier', () => {
    const s = store();
    const { plane, curve } = drawn(s, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    cmd.setPlaneModifier(s, plane, { type: 'linear', count: 3, offset: { x: 0, y: 300, z: 0 } });
    const ids = cmd.commitArray(s, plane, { merge: 0.5 });
    expect(ids.length).toBe(3);
    expect(findPlane(s.project, plane)!.array).toBe(null);
    expect(ids[0]).toBe(curve);                       // the first copy is the curve that was drawn
    expect(points(s, ids[1])).toEqual([[0, 300, 0], [100, 300, 0]]);
    expect(points(s, ids[2])).toEqual([[0, 600, 0], [100, 600, 0]]);
    expect(s.project.curves.every((c) => c.planeId === plane)).toBe(true);
  });

  it('a copy that leaves the plane comes out as a 3D curve', () => {
    const s = store();
    const { plane } = drawn(s, [{ x: 0, y: 200 }, { x: 100, y: 200 }]);
    // turning about the plane's X through the origin lifts the copies off the plane
    cmd.setPlaneModifier(s, plane, { type: 'circular', count: 4, center: { x: 0, y: 0, z: 0 }, axis: { x: 1, y: 0, z: 0 }, angle: 360 });
    const ids = cmd.commitArray(s, plane, { merge: 0 });
    expect(ids.length).toBe(4);
    const zs = ids.flatMap((id) => points(s, id).map((p) => p[2]));
    expect(zs.some((z) => Math.abs(z) > 1)).toBe(true);
    expect(s.project.curves.filter((c) => c.type === 'spatial').length).toBeGreaterThan(1);
  });

  it('merge by distance welds the ring shut: six arcs → one closed curve', () => {
    const s = store();
    // a 60° chord of a Ø2000 circle centred on the origin, so six copies close the ring
    const r = 1000, a = Math.PI / 3;
    const { plane } = drawn(s, [
      { x: r, y: 0 },
      { x: r * Math.cos(a / 2), y: r * Math.sin(a / 2) },
      { x: r * Math.cos(a), y: r * Math.sin(a) },
    ]);
    cmd.setPlaneModifier(s, plane, { type: 'circular', count: 6, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, angle: 360 });
    const ids = cmd.commitArray(s, plane, { merge: 0.5 });
    expect(ids.length).toBe(1);
    const c = s.project.curves.find((x) => x.id === ids[0])!;
    expect(c.curve.closed).toBe(true);
    expect(c.curve.points.length).toBe(12);           // 6 × 3 points, the 6 shared ends welded
  });

  it('without a merge distance nothing welds', () => {
    const s = store();
    const r = 1000, a = Math.PI / 3;
    const { plane } = drawn(s, [{ x: r, y: 0 }, { x: r * Math.cos(a / 2), y: r * Math.sin(a / 2) }, { x: r * Math.cos(a), y: r * Math.sin(a) }]);
    const mod = { type: 'circular' as const, count: 6, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, angle: 360 };
    cmd.setPlaneModifier(s, plane, mod);
    const mine = s.project.curves.filter((c) => c.planeId === plane);
    expect(commitArray(mod, mine, 0).length).toBe(6);
    expect(commitArray(mod, mine, 0.5).length).toBe(1);
  });

  it('curves of different profiles never weld into one', () => {
    const s = store();
    const { plane, curve } = drawn(s, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const second = cmd.addCurve(s, plane);
    cmd.addVertex(s, second, { x: 100, y: 0 });
    cmd.addVertex(s, second, { x: 200, y: 0 });
    cmd.exitEdit(s);
    cmd.setCurveProfile(s, second, s.project.profiles[1].id);
    expect(s.project.profiles[1].id).not.toBe(s.project.curves.find((c) => c.id === curve)!.outline[0].profileId);
    expect(cmd.commitArray(s, plane, { merge: 0.5 }).length).toBe(2);
  });

  it('the undo step brings the modifier and the copies back', () => {
    const s = store();
    const { plane } = drawn(s, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    cmd.setPlaneModifier(s, plane, { type: 'linear', count: 4, offset: { x: 200, y: 0, z: 0 } });
    cmd.commitArray(s, plane, { merge: 0 });
    expect(s.project.curves.length).toBe(4);
    s.undo();
    expect(s.project.curves.length).toBe(1);
    expect(findPlane(s.project, plane)!.array).toEqual({ type: 'linear', count: 4, offset: { x: 200, y: 0, z: 0 } });
  });
});
