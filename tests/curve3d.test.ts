/**
 * Part 12 (docs/12-3d-curves.md): a curve object of type 'spatial' keeps x, y on
 * its plane and lifts vertices along the plane normal (z). Checked headlessly
 * through the same store + commands the UI uses: model, migration, 3D length
 * and bend radius, world placement, pipe geometry, constraints, undo, overview.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { describeCurve, overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findCurve, migrateProject, vertex, type Id, type Project } from '../src/model/types';
import { fromPlane, planeFrame } from '../src/geometry/placement';
import { fillHandles } from '../src/model/handles';
import { curveGeometry } from '../src/geometry/shape';
import { sampleCurve } from '../src/geometry/curve';

const profiles = () => DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }));
const fresh = () => new Store(emptyProject('t', profiles()));

/** A 3D curve on a plane of the given preset: `pts` are [x, y, z] in plane coordinates. */
function spatialCurve(store: Store, preset: 'front' | 'top', pts: [number, number, number][], profile = 'round15'): Id {
  const plane = cmd.addPlane(store, preset);
  const id = cmd.addCurve(store, plane);
  cmd.setCurveType(store, id, 'spatial');
  cmd.setCurveProfile(store, id, profile);
  for (const [x, y, z] of pts) cmd.addVertex(store, id, { x, y, z });
  cmd.exitEdit(store);
  return id;
}

const size = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox!.getSize(new THREE.Vector3()); };

describe('3D curves (plane + offset along the normal)', () => {
  it('new curves are planar and ignore z; switching to 3D keeps it, back to planar flattens (undoable)', () => {
    const store = fresh();
    const id = cmd.addCurve(store, null, 'front');
    expect(findCurve(store.project, id)!.type).toBe('planar');
    cmd.addVertex(store, id, { x: 0, y: 0, z: 100 });
    cmd.addVertex(store, id, { x: 500, y: 0 });
    cmd.exitEdit(store);
    const c = () => findCurve(store.project, id)!;
    expect(c().curve.points.map((v) => v.z)).toEqual([0, 0]);                 // planar: z dropped

    cmd.setCurveType(store, id, 'spatial');
    const [a, b] = c().curve.points.map((v) => v.id);
    cmd.moveVertices(store, id, [{ vid: b, p: { z: 300 } }], false);           // only z changes
    expect(c().curve.points.map((v) => [v.x, v.y, v.z])).toEqual([[0, 0, 0], [500, 0, 300]]);
    cmd.offsetVertices(store, id, new Map([[a, 0], [b, 300]]), 50, false);
    expect(c().curve.points.map((v) => v.z)).toEqual([50, 350]);

    cmd.setCurveType(store, id, 'planar');
    expect(c().type).toBe('planar');
    expect(c().curve.points.map((v) => v.z)).toEqual([0, 0]);
    store.undo();
    expect(c().type).toBe('spatial');
    expect(c().curve.points.map((v) => v.z)).toEqual([50, 350]);

    // the store keeps planar curves flat even when a script writes z directly
    cmd.setCurveType(store, id, 'planar');
    store.update((s) => { findCurve(s.project, id)!.curve.points[1].z = 99; });
    expect(c().curve.points[1].z).toBe(0);
  });

  it('a straight 3D piece has the 3D length, no bend, and renders as a tube of that length', () => {
    const store = fresh();
    const id = spatialCurve(store, 'front', [[0, 0, 0], [300, 0, 400]]);      // 3-4-5
    const ev = store.evals.get(id)!;
    expect(ev.sampling.length).toBeCloseTo(500, 6);
    expect(ev.sampling.samples.every((s) => s.radius === Infinity)).toBe(true);
    expect(ev.sampling.samples.at(-1)!.z).toBeCloseTo(400, 6);
    expect(ev.violations).toEqual([]);
    const c = findCurve(store.project, id)!;
    const geo = curveGeometry(c, store.profileOf(c.outline[0]))!;
    const s = size(geo);
    // the tube runs along (0.6, 0, 0.8): its box is the 300 × 400 span plus the Ø15 cross-section projected on each axis
    expect(s.x).toBeGreaterThan(300 + 15 * 0.8 * 0.98); expect(s.x).toBeLessThanOrEqual(300 + 15 * 0.8 + 1e-6);
    expect(s.z).toBeGreaterThan(400 + 15 * 0.6 * 0.98); expect(s.z).toBeLessThanOrEqual(400 + 15 * 0.6 + 1e-6);
    expect(s.y).toBeGreaterThan(15 * 0.98);
    expect(s.y).toBeLessThanOrEqual(15 + 1e-6);
  });

  it('bend radius is measured in 3D: a circle standing in the x–z plane reads like the same circle drawn flat', () => {
    const R = 200, n = 12;
    const ring = (f: (t: number) => [number, number, number]) => Array.from({ length: n }, (_, i) => f((i / n) * Math.PI * 2));
    const smoothRing = (f: (t: number) => [number, number, number]) => {
      const curve = { points: ring(f).map(([x, y, z]) => vertex(x, y, 'equal', z)), closed: true };
      curve.points.forEach((_, i) => fillHandles(curve, i));
      return curve;
    };
    const flat = smoothRing((t) => [R * Math.cos(t), R * Math.sin(t), 0]);
    const standing = smoothRing((t) => [R * Math.cos(t), 0, R * Math.sin(t)]);
    const tight = (s: ReturnType<typeof sampleCurve>) => Math.min(...s.samples.map((q) => q.radius));
    const sf = sampleCurve(flat), ss = sampleCurve(standing);
    expect(sf.length).toBeCloseTo(ss.length, 3);
    expect(tight(sf)).toBeCloseTo(tight(ss), 3);
    expect(tight(ss)).toBeGreaterThan(R * 0.9);
    expect(tight(ss)).toBeLessThan(R * 1.1);
    // planar samples keep the Part 1 sign (counter-clockwise = left turn > 0); 3D ones are unsigned
    expect(sf.samples.every((q) => q.curvature > 0)).toBe(true);
    expect(ss.samples.every((q) => q.curvature > 0)).toBe(true);
    // and the check fires on a 3D curve exactly like on a planar one
    const store = fresh();
    const id = spatialCurve(store, 'front', ring((t) => [30 * Math.cos(t), 0, 30 * Math.sin(t)]));
    cmd.toggleClosed(store, id);
    cmd.setVertexType(store, id, findCurve(store.project, id)!.curve.points.map((v) => v.id), 'equal');   // a ring, not a polygon

    expect(store.evals.get(id)!.violations.map((v) => v.check)).toEqual(['minBendRadius']);   // R 30 < 45 for round15
  });

  it('z lifts a vertex along the plane normal in world space (Top plane: +Y)', () => {
    const store = fresh();
    const id = spatialCurve(store, 'top', [[0, 0, 0], [100, -200, 250]]);
    const c = findCurve(store.project, id)!;
    const frame = planeFrame(store.planeOf(c).placement);
    const w = fromPlane(frame, c.curve.points[1]);
    expect(w.toArray().map((v) => Math.round(v))).toEqual([100, 250, 200]);   // local y → world −z, z → world +y
  });

  it('distance constraints and pins work in 3D; handles keep their z', () => {
    const store = fresh();
    const id = spatialCurve(store, 'front', [[0, 0, 0], [300, 0, 400]]);
    const c = () => findCurve(store.project, id)!;
    const [a, b] = c().curve.points.map((v) => v.id);
    const k = cmd.addConstraint(store, id, 'distance', a, b)!;
    expect(c().constraints[0].value).toBeCloseTo(500, 6);
    cmd.setConstraintValue(store, id, k, 250);                                  // a stays, b slides along the 3D direction
    expect(c().curve.points[1].x).toBeCloseTo(150, 3);
    expect(c().curve.points[1].z).toBeCloseTo(200, 3);
    expect(store.evals.get(id)!.constraints.get(k)).toBe(true);

    cmd.togglePin(store, id, b);
    expect(c().constraints.find((x) => x.type === 'pin')!.at).toEqual({ x: c().curve.points[1].x, y: 0, z: c().curve.points[1].z });
    cmd.moveVertices(store, id, [{ vid: b, p: { z: 0 } }], false);             // pinned: does not move
    expect(c().curve.points[1].z).toBeCloseTo(200, 3);

    cmd.setVertexType(store, id, [a], 'equal');                                // a polygon vertex has no handles to drag
    cmd.moveHandle(store, id, a, 'out', { x: 50, y: 0, z: 80 }, false);
    const va = c().curve.points[0];
    expect(va.type).toBe('equal');
    expect(va.out).toEqual({ x: 50, y: 0, z: 80 });
    expect(va.in.z).toBeCloseTo(-80 * (Math.hypot(va.in.x, va.in.y, va.in.z) / Math.hypot(50, 0, 80)), 6);   // mirrored in 3D
  });

  it('object-mode transforms leave z alone in the plane, but a uniform object scale scales z too', () => {
    const store = fresh();
    const id = spatialCurve(store, 'front', [[0, 0, 0], [300, 0, 400]]);
    const c = () => findCurve(store.project, id)!;
    cmd.translateCurves(store, [id], { x: 10, y: 20 }, false);
    expect(c().curve.points[1]).toMatchObject({ x: 310, y: 20, z: 400 });
    const g = cmd.addGroup(store, [c().planeId])!;
    const snap = cmd.snapshotGroup(store, g)!;
    cmd.transformGroup(store, snap, { pivot: { x: 0, y: 0, z: 0 }, translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: 2 }, false);
    expect(c().curve.points[1]).toMatchObject({ x: 620, y: 40, z: 800 });
  });

  it('migrates version-4 projects (no z, no type) and round-trips version 5', () => {
    const v4 = {
      version: 4, name: 'old', profiles: profiles(), lofts: [], groups: [], materials: [],
      planes: [{ id: 'front', name: 'Front', placement: { preset: 'front', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, array: null }],
      curves: [{ id: 'c', name: 'c', planeId: 'front', profileId: 'round15', constraints: [{ id: 'p', type: 'pin', a: 'v1', at: { x: 0, y: 0 } }], materialId: null,
        curve: { closed: false, points: [{ id: 'v1', x: 0, y: 0, type: 'auto', in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }, { id: 'v2', x: 100, y: 0, type: 'smooth', in: { x: -30, y: 0 }, out: { x: 30, y: 0 } }] } }],
    };
    const p = migrateProject(JSON.parse(JSON.stringify(v4)))!;
    expect(p.version).toBe(18);
    expect(p.curves[0].type).toBe('planar');
    expect(p.curves[0].curve.points.map((v) => v.type)).toEqual(['equal', 'equal']);   // auto / smooth → equal (docs/27)
    expect(p.curves[0].curve.points.map((v) => [v.z, v.in.z, v.out.z])).toEqual([[0, 0, 0], [0, 0, 0]]);
    expect(p.curves[0].constraints[0].at).toEqual({ x: 0, y: 0, z: 0 });

    const store = fresh();
    spatialCurve(store, 'front', [[0, 0, 0], [300, 0, 400]]);
    const again = migrateProject(JSON.parse(JSON.stringify(store.project)) as Project);
    expect(again).toEqual(store.project);
    expect(again!.curves[0].curve.points[1].z).toBe(400);
  });

  it('reads back in the agent overview and curve dump', () => {
    const store = fresh();
    const id = spatialCurve(store, 'front', [[0, 0, 0], [300, 0, 400]]);
    cmd.renameCurve(store, id, 'Riser');
    expect(overview(store)).toContain(`○ Riser [${id}] · outline: round15 · 3D · 2 pts open · 500 mm · x 0..300 y 0..0 z 0..400 · ok`);
    const dump = describeCurve(store, id);
    expect(dump).toContain('3D: z = offset along the plane normal');
    expect(dump).toContain('(300, 0, 400) polygon');
  });
});
