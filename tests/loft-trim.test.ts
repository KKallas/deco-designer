/** Loft trims and offsets (docs/24-loft-trim.md). */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, loftEdge, migrateProject } from '../src/model/types';
import { buildLoft } from '../src/geometry/loft';
import { planeWorld } from '../src/geometry/placement';

/** Two straight 1000 mm lines 500 mm apart on the front plane, lofted. */
function fixture() {
  const store = new Store(emptyProject('t', DEFAULT_PROFILES));
  const plane = cmd.addPlane(store, 'front');
  const line = (y: number, x0 = 0, x1 = 1000) => {
    const id = cmd.addCurve(store, plane);
    cmd.addVertex(store, id, { x: x0, y }); cmd.addVertex(store, id, { x: x1, y });
    cmd.exitEdit(store);
    return id;
  };
  const a = line(0), b = line(500);
  const loft = cmd.addLoft(store, a, b)!;
  return { store, a, b, loft };
}

function build(store: Store) {
  const l = store.project.lofts[0];
  const ca = store.project.curves.find((c) => c.id === l.a)!, cb = store.project.curves.find((c) => c.id === l.b)!;
  return buildLoft(l, ca, cb, planeWorld(store.project, store.planeOf(ca)).matrix, planeWorld(store.project, store.planeOf(cb)).matrix);
}

/** World bounds of the built surface. */
function box(store: Store) {
  const built = build(store)!;
  return new THREE.Box3().setFromBufferAttribute(built.mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
}

describe('loft trims (docs/24)', () => {
  it('starts untrimmed and spans both whole curves', () => {
    const { store, loft } = fixture();
    expect(loftEdge(store.project.lofts[0], 'a')).toEqual({ start: 0, end: 0, offset: 0, lift: 0 });
    const b = box(store);
    expect([b.min.x, b.max.x, b.min.y, b.max.y]).toEqual([0, 1000, 0, 500]);
    expect(overview(store)).not.toContain('trim');
    expect(loft).toBe('loft-1');
  });

  it('a positive trim stays short of the control curve, on that curve only', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'a', { start: 200, end: 150 });
    const b = box(store);
    // edge A runs 200..850, edge B still 0..1000 — the band is a trapezoid spanning the union
    expect([b.min.x, b.max.x]).toEqual([0, 1000]);
    const built = build(store)!;
    const pos = built.mesh.geometry.getAttribute('position');
    const onA = [...Array(pos.count).keys()].filter((i) => pos.getY(i) === 0).map((i) => pos.getX(i));
    expect(Math.min(...onA)).toBeCloseTo(200, 6);
    expect(Math.max(...onA)).toBeCloseTo(850, 6);
    expect(overview(store)).toContain('A trim 200/150');
  });

  it('a negative trim goes past the control curve, straight along the end tangent', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'b', { start: -300, end: -100 });
    const built = build(store)!;
    const pos = built.mesh.geometry.getAttribute('position');
    const onB = [...Array(pos.count).keys()].filter((i) => Math.abs(pos.getY(i) - 500) < 1e-6).map((i) => pos.getX(i));
    expect(Math.min(...onB)).toBeCloseTo(-300, 4);
    expect(Math.max(...onB)).toBeCloseTo(1100, 4);
    expect(overview(store)).toContain('B trim -300/-100');
  });

  it('trims by arc length along the curve, not along the chord', () => {
    const { store } = fixture();
    const plane = store.project.planes[0].id;
    const id = cmd.addCurve(store, plane);
    cmd.addVertex(store, id, { x: 0, y: 1000 }); cmd.addVertex(store, id, { x: 500, y: 1400 }); cmd.addVertex(store, id, { x: 1000, y: 1000 });
    cmd.exitEdit(store);
    const loft = cmd.addLoft(store, store.project.curves[0].id, id)!;
    cmd.updateLoft(store, loft, { strips: 1, resolution: 20 });         // only the two edges, finely sampled
    // length of the bumped edge B, from the unique built points (monotone in x, so sorting rebuilds the polyline)
    const edgeLength = () => {
      const l = store.project.lofts.find((x) => x.id === loft)!;
      const ca = store.project.curves.find((c) => c.id === l.a)!, cb = store.project.curves.find((c) => c.id === l.b)!;
      const built = buildLoft(l, ca, cb, planeWorld(store.project, store.planeOf(ca)).matrix, planeWorld(store.project, store.planeOf(cb)).matrix)!;
      const pos = built.mesh.geometry.getAttribute('position');
      const seen = new Map<string, THREE.Vector3>();
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < 1000 - 1e-6) continue;                       // edge A sits at y = 0, and strips = 1 leaves no rows between
        const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        seen.set(`${p.x.toFixed(4)},${p.y.toFixed(4)}`, p);
      }
      const pts = [...seen.values()].sort((p, q) => p.x - q.x);
      return pts.reduce((sum, p, i) => (i ? sum + p.distanceTo(pts[i - 1]) : 0), 0);
    };
    const whole = edgeLength();
    expect(whole).toBeGreaterThan(1000);                               // the bump is longer than its 1000 mm chord
    cmd.setLoftEdge(store, loft, 'b', { start: 100, end: 100 });
    expect(edgeLength()).toBeCloseTo(whole - 200, -1);                 // 100 mm of arc off each end (± the chord error)
  });

  it('an offset moves the edge across the ruling: + outwards, − inwards', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'a', { offset: 100 });     // A away from B: y = −100
    cmd.setLoftEdge(store, loft, 'b', { offset: -200 });    // B towards A: y = 300
    const b = box(store);
    expect([b.min.y, b.max.y]).toEqual([-100, 300]);
    expect([b.min.x, b.max.x]).toEqual([0, 1000]);          // an offset never moves an edge along itself
    expect(overview(store)).toContain('A offset 100');
    expect(overview(store)).toContain('B offset -200');
  });

  it('a lift moves the edge out of the surface, along the loft normal', () => {
    const { store, loft } = fixture();                       // both edges in the front plane (XY), z = 0
    cmd.setLoftEdge(store, loft, 'b', { lift: 250 });
    const built = build(store)!;
    const pos = built.mesh.geometry.getAttribute('position');
    const zOf = (y: number) => [...Array(pos.count).keys()].filter((i) => Math.abs(pos.getY(i) - y) < 1e-6).map((i) => pos.getZ(i));
    expect(Math.max(...zOf(0).map(Math.abs))).toBeCloseTo(0, 6);          // edge A stays in the plane
    for (const z of zOf(500)) expect(z).toBeCloseTo(250, 4);              // edge B is 250 mm out of it, all along
    const b = box(store);
    expect([b.min.y, b.max.y]).toEqual([0, 500]);                         // the lift is not the offset: no width change
    expect(overview(store)).toContain('B lift 250');
  });

  it('lifting both edges by the same amount slides the whole flat band off its curves', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'a', { lift: -100 });
    cmd.setLoftEdge(store, loft, 'b', { lift: -100 });
    const b = box(store);
    expect([b.min.z, b.max.z]).toEqual([-100, -100]);                     // still flat, 100 mm behind the plane
    expect([b.min.x, b.max.x, b.min.y, b.max.y]).toEqual([0, 1000, 0, 500]);
  });

  it('the lift direction is the surface normal, not either curve\u2019s plane normal', () => {
    // A on the front plane, B on a parallel plane 600 mm behind it: the band is a horizontal ribbon,
    // its normal is vertical (\u00b1y), so a lift moves the edge up — not along either plane\u2019s +z
    const { store } = fixture();
    const back = cmd.addPlane(store, 'front');
    cmd.setPlanePlacement(store, back, { position: { x: 0, y: 0, z: -600 } });
    const id = cmd.addCurve(store, back);
    cmd.addVertex(store, id, { x: 0, y: 0 }); cmd.addVertex(store, id, { x: 1000, y: 0 });
    cmd.exitEdit(store);
    const loft = cmd.addLoft(store, store.project.curves[0].id, id)!;
    cmd.setLoftEdge(store, loft, 'b', { lift: 100 });
    const l = store.project.lofts.find((x) => x.id === loft)!;
    const ca = store.project.curves.find((c) => c.id === l.a)!, cb = store.project.curves.find((c) => c.id === l.b)!;
    const built = buildLoft(l, ca, cb, planeWorld(store.project, store.planeOf(ca)).matrix, planeWorld(store.project, store.planeOf(cb)).matrix)!;
    const bb = new THREE.Box3().setFromBufferAttribute(built.mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
    expect([bb.min.z, bb.max.z]).toEqual([-600, 0]);                      // the band still spans the two planes
    expect(Math.abs(bb.max.y - 100)).toBeLessThan(1e-4);                  // the lifted edge went up, out of the ribbon
    expect(bb.min.y).toBeCloseTo(0, 6);
  });

  it('uvs stay millimetres of the trimmed, offset surface', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'a', { start: 100, end: 100 });
    cmd.setLoftEdge(store, loft, 'b', { start: 100, end: 100, offset: -100 });
    const built = build(store)!;
    const uv = built.mesh.geometry.getAttribute('uv');
    const us = [...Array(uv.count).keys()].map((i) => uv.getX(i)), vs = [...Array(uv.count).keys()].map((i) => uv.getY(i));
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(800, 4);            // 1000 − 100 − 100 on both edges
    expect(Math.max(...vs)).toBeCloseTo(400, 4);            // 500 − 100 of inward offset
  });

  it('trimming everything away builds no mesh, and it comes back', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'a', { start: 600, end: 600 });
    expect(build(store)).toBeNull();
    cmd.setLoftEdge(store, loft, 'a', { start: 0 });
    expect(build(store)).not.toBeNull();
  });

  it('is a partial patch, survives save / load and is normalized on the way in', () => {
    const { store, loft } = fixture();
    cmd.setLoftEdge(store, loft, 'a', { start: 200 });
    cmd.setLoftEdge(store, loft, 'a', { offset: 50 });
    expect(loftEdge(store.project.lofts[0], 'a')).toEqual({ start: 200, end: 0, offset: 50, lift: 0 });
    const loaded = migrateProject(JSON.parse(JSON.stringify(store.project)))!;
    expect(loaded).toEqual(store.project);
    const old = JSON.parse(JSON.stringify(store.project)) as { lofts: { edgeA?: unknown; edgeB?: unknown }[] };
    for (const l of old.lofts) { delete l.edgeA; delete l.edgeB; }
    const migrated = migrateProject(old)!;
    expect(migrated.lofts[0].edgeA).toEqual({ start: 0, end: 0, offset: 0, lift: 0 });
    store.update((s) => { (s.project.lofts[0].edgeB as unknown) = { start: 'x' }; });
    expect(store.project.lofts[0].edgeB).toEqual({ start: 0, end: 0, offset: 0, lift: 0 });
  });
});
