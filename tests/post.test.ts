/**
 * API test: build a product headlessly through the same store + commands the
 * UI uses (docs/07-headless-api.md), then check the model *and* the geometry
 * three.js would render for it.
 *
 * Fixture: the "Post" example (src/app/examples.ts, also behind the toolbar's
 * ▣ Post button): 400 × 400 mm footprint, 3000 mm tall, all twelve outline
 * edges Ø15 round tubes (straight pieces, welded at the corners), the four
 * side walls lofted between their vertical edges.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import { buildPost, POST_VERTICAL_EDGES, type Post } from '../src/app/examples';
import { overview, describeCurve } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findCurve, findPlane, loftsOfGroup, migrateProject, planeOf, type Id, type Project } from '../src/model/types';
import { fromPlane, planeWorld } from '../src/geometry/placement';
import { curveGeometry } from '../src/geometry/shape';
import { buildLoft } from '../src/geometry/loft';

const W = 400;   // footprint, mm
const H = 3000;  // height, mm
const TUBE = 'round15';

/** World-space end points of a straight edge curve. */
function endpoints(project: Project, id: Id): [THREE.Vector3, THREE.Vector3] {
  const c = findCurve(project, id)!;
  const frame = planeWorld(project, planeOf(project, c));
  const [a, b] = c.curve.points;
  return [fromPlane(frame, a), fromPlane(frame, b)];
}

const round = (v: number) => Math.round(v) + 0; // + 0 folds −0 into 0
const key = (p: THREE.Vector3) => [p.x, p.y, p.z].map(round).join(',');
const edgeLength = (name: string) => (POST_VERTICAL_EDGES.includes(name) ? H : W);
const size = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox!.getSize(new THREE.Vector3()); };

describe('post 400 × 400 × 3000 built through the API', () => {
  const store = new Store(emptyProject('Post', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));
  let post!: Post;
  beforeAll(async () => { post = await store.transaction(() => buildPost(store)); });
  const project = store.project;

  it('has 4 planes, 12 straight tube curves, 4 lofts in one object', () => {
    expect(project.planes).toHaveLength(4);
    expect(project.curves).toHaveLength(12);
    expect(project.lofts).toHaveLength(4);
    expect(project.groups).toHaveLength(1);
    expect(store.mode.kind).toBe('object');
    for (const c of project.curves) {
      expect(c.outline.map((l) => l.profileId)).toEqual([TUBE]);
      expect(store.profileOf(c.outline[0]).id).toBe('round15');
      expect(c.curve.points).toHaveLength(2);
      expect(c.curve.closed).toBe(false);
    }
    const g = project.groups[0];
    expect(g.name).toBe('Post');
    expect(g.planes.sort()).toEqual(Object.values(post.planes).sort());
    expect(loftsOfGroup(project, g)).toHaveLength(4);
    // the planes are placed inside the object's frame now (docs/18-nested-objects.md §2): local + object = world
    expect(planeWorld(project, findPlane(project, post.planes.top)!).origin.y).toBeCloseTo(H, 6);
  });

  it('edges outline exactly a 400 × 400 × 3000 box', () => {
    const lengths: number[] = [];
    const corners = new Map<string, number>();
    const box = new THREE.Box3();
    for (const id of Object.values(post.edges)) {
      const [a, b] = endpoints(project, id);
      lengths.push(a.distanceTo(b));
      for (const p of [a, b]) { corners.set(key(p), (corners.get(key(p)) ?? 0) + 1); box.expandByPoint(p); }
    }
    expect(box.min.toArray().map(round)).toEqual([-W / 2, 0, -W / 2]);
    expect(box.max.toArray().map(round)).toEqual([W / 2, H, W / 2]);
    // 8 corners, each shared by exactly 3 edges
    expect(corners.size).toBe(8);
    expect([...corners.values()].every((n) => n === 3)).toBe(true);
    // 8 horizontal edges of 400, 4 vertical of 3000
    expect(lengths.filter((l) => Math.abs(l - W) < 1e-6)).toHaveLength(8);
    expect(lengths.filter((l) => Math.abs(l - H) < 1e-6)).toHaveLength(4);
    expect(lengths.reduce((s, l) => s + l, 0)).toBeCloseTo(8 * W + 4 * H, 6); // 15.2 m of tube
  });

  it('every edge passes the profile limitation checks', () => {
    for (const [name, id] of Object.entries(post.edges)) {
      const ev = store.evals.get(id)!;
      expect(ev.violations, name).toEqual([]);
      expect(ev.sampling.samples.every((s) => s.radius === Infinity), name).toBe(true); // straight
      expect(ev.sampling.length, name).toBeCloseTo(edgeLength(name), 6);
    }
  });

  it('renders each edge as a Ø15 circular tube of the right length', () => {
    for (const [name, id] of Object.entries(post.edges)) {
      const c = findCurve(project, id)!;
      const geo = curveGeometry(c, store.profileOf(c.outline[0]));
      expect(geo, name).toBeInstanceOf(THREE.BufferGeometry);
      const s = size(geo!).toArray().sort((a, b) => b - a);
      expect(s[0], `${name} length`).toBeCloseTo(edgeLength(name), 3);
      // cross-section: Ø15 (20 radial segments → chord flats within 2 %)
      expect(s[1], `${name} diameter`).toBeGreaterThan(15 * 0.98);
      expect(s[1], `${name} diameter`).toBeLessThanOrEqual(15 + 1e-6);
      expect(s[2], `${name} diameter`).toBeGreaterThan(15 * 0.98);
      expect(s[2], `${name} diameter`).toBeLessThanOrEqual(15 + 1e-6);
    }
  });

  it('lofts each side wall as a flat 400 × 3000 surface', () => {
    const expected: Record<string, [number, number, number]> = {
      front: [W, H, 0], back: [W, H, 0],   // in XY, at z = ±200
      left: [0, H, W], right: [0, H, W],   // in YZ, at x = ∓200
    };
    for (const [name, id] of Object.entries(post.walls)) {
      const loft = project.lofts.find((l) => l.id === id)!;
      const a = findCurve(project, loft.a)!, b = findCurve(project, loft.b)!;
      const built = buildLoft(loft, a, b, planeWorld(project, planeOf(project, a)).matrix, planeWorld(project, planeOf(project, b)).matrix);
      expect(built, name).not.toBeNull();
      const s = size(built!.mesh.geometry);
      expect(s.toArray().map((v) => Math.round(v * 1e6) / 1e6), name).toEqual(expected[name]);
      expect(built!.samples).toBe(4);          // resolution 2 × 2 vertices
      expect(built!.flipped).toBe(false);      // both edges drawn bottom → top: rulings never cross
      // 4 samples × 4 strips, two triangles per checkerboard cell
      expect(built!.mesh.geometry.getAttribute('position').count).toBe(4 * 4 * 2 * 3);
      // uv in mm: u runs 0..3000 up the edges, v 0..400 across the wall (docs/05-loft.md §2)
      const uv = built!.mesh.geometry.getAttribute('uv');
      const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i)), vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i));
      expect([Math.min(...us), Math.max(...us)], `${name} u`).toEqual([0, H]);
      expect([Math.min(...vs), Math.max(...vs)], `${name} v`).toEqual([0, W]);
      expect(new Set(vs.map((v) => Math.round(v))), `${name} strip rows`).toEqual(new Set([0, 100, 200, 300, 400]));
    }
  });

  it('loft uv keeps its mm scale on a curved edge (u = mean edge arc length per ruling, v = along the ruling)', () => {
    const p = emptyProject('arc', DEFAULT_PROFILES);
    p.planes.push({ id: 'front', name: 'Front', placement: { preset: 'front', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, array: null, image: null });
    // a: straight 1000 mm base; b: a bump 250 mm above it (sampled by equal arc length, so u > 1000 along b)
    const pts = (xy: [number, number][]) => xy.map(([x, y]) => ({ id: `${x},${y}`, x, y, z: 0, type: 'polygon' as const, in: { x: 0, y: 0, z: 0 }, out: { x: 0, y: 0, z: 0 } }));
    p.curves.push(
      { id: 'a', name: 'a', planeId: 'front', type: 'planar', curve: { points: pts([[0, 0], [1000, 0]]), closed: false }, constraints: [], outline: [] },
      { id: 'b', name: 'b', planeId: 'front', type: 'planar', curve: { points: pts([[0, 250], [500, 450], [1000, 250]]), closed: false }, constraints: [], outline: [] },
    );
    const loft = { id: 'l', name: 'l', a: 'a', b: 'b', resolution: 4, strips: 2, flip: false, materialId: null };
    const built = buildLoft(loft, p.curves[0], p.curves[1], planeWorld(p, p.planes[0]).matrix, planeWorld(p, p.planes[0]).matrix)!;
    const uv = built.mesh.geometry.getAttribute('uv'), pos = built.mesh.geometry.getAttribute('position');
    const onA = (i: number) => pos.getY(i) === 0;
    const endOfB = (i: number) => pos.getX(i) === 1000 && Math.abs(pos.getY(i) - 250) < 1e-6;
    let uMaxOnA = 0, uMaxOnB = 0;
    for (let i = 0; i < uv.count; i++) {
      if (onA(i)) { uMaxOnA = Math.max(uMaxOnA, uv.getX(i)); expect(uv.getY(i)).toBe(0); }   // v = 0 along a
      if (endOfB(i)) { uMaxOnB = Math.max(uMaxOnB, uv.getX(i)); expect(uv.getY(i)).toBeCloseTo(250, 6); } // v = ruling length
    }
    expect(uMaxOnA).toBeCloseTo(uMaxOnB, 6);                       // u is constant along a ruling (sun rays between two arcs)
    expect(uMaxOnA).toBeGreaterThan(1000);                         // mean of a (1000) and the longer b …
    expect(uMaxOnA).toBeLessThanOrEqual((1000 + 2 * Math.hypot(500, 200)) / 2 + 1e-6); // … never beyond the polyline mean
  });

  it('reads back in the agent overview', () => {
    const text = overview(store);
    expect(text).toContain('4 planes · 12 curves · 4 lofts · 0 shapes · 1 objects');
    expect(text).toContain('▣ Post [');
    expect(text).toContain(`○ Front left [${post.edges['front-left']}] · outline: round15 · 2 pts open · 3000 mm · x -200..-200 y 0..3000 · ok`);
    expect(text).toContain('◇ Left wall [');
    expect(describeCurve(store, post.edges['top-back'])).toContain('#1 [');
  });

  it('survives save / load, and one transaction = one undo step', () => {
    const loaded = migrateProject(JSON.parse(JSON.stringify(project)));
    expect(loaded).toEqual(project);
    expect(store.canUndo).toBe(true);
    store.undo();                                  // the whole build was one transaction
    expect(store.project.planes).toHaveLength(0);
    expect(store.project.curves).toHaveLength(0);
    expect(store.canUndo).toBe(false);
    store.redo();
    expect(store.project.curves).toHaveLength(12);
    expect(store.project.groups[0].name).toBe('Post');
  });
});
