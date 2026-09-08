/** Objects inside objects: nested frames, grouping, visibility (docs/18-nested-objects.md). */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import {
  emptyProject, findGroup, findPlane, groupVisible, loftsOfGroup, migrateProject, parentOfGroup, planeVisible,
  subtreePlanes, type Id, type Project,
} from '../src/model/types';
import { fromPlane, planeWorld } from '../src/geometry/placement';
import { resolvePick } from '../src/model/pick';
import { buildLoft } from '../src/geometry/loft';

const store = () => new Store(emptyProject('Nested', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));

/** A plane with one two-point curve on it, at `x` mm. */
function plate(s: Store, x: number): { plane: Id; curve: Id } {
  const plane = cmd.addPlane(s, 'front');
  cmd.setPlanePlacement(s, plane, { position: { x, y: 0, z: 0 } });
  const curve = cmd.addCurve(s, plane)!;
  cmd.addVertex(s, curve, { x: 0, y: 0 });
  cmd.addVertex(s, curve, { x: 100, y: 0 });
  cmd.exitEdit(s);
  return { plane, curve };
}

/** World points of a curve's vertices. */
function world(project: Project, curveId: Id): THREE.Vector3[] {
  const c = project.curves.find((x) => x.id === curveId)!;
  const f = planeWorld(project, project.planes.find((p) => p.id === c.planeId)!);
  return c.curve.points.map((v) => fromPlane(f, v));
}

const at = (project: Project, id: Id) => world(project, id).map((p) => [p.x, p.y, p.z].map((n) => Math.round(n * 1e6) / 1e6));

describe('nested objects', () => {
  it('composes the frames: a plane two levels down is placed by both objects', () => {
    const s = store();
    const { plane, curve } = plate(s, 0);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    cmd.setGroupPlacement(s, inner, { position: { x: 10, y: 20, z: 30 } });
    cmd.setGroupPlacement(s, outer, { position: { x: 100, y: 200, z: 300 } });
    // world = outer · inner · the plane's own (rebased) placement
    const local = findPlane(s.project, plane)!.placement.position;
    const p = world(s.project, curve)[0];
    expect([p.x, p.y, p.z]).toEqual([110 + local.x, 220 + local.y, 330 + local.z]);
    expect(parentOfGroup(s.project, inner)?.id).toBe(outer);
    expect(subtreePlanes(s.project, findGroup(s.project, outer)!)).toEqual([plane]);
  });

  it('grouping rebases the members: nothing moves, and the object sits at their centre', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 1000);
    const before = [at(s.project, a.curve), at(s.project, b.curve)];
    const g = cmd.addGroup(s, [a.plane, b.plane])!;
    expect(findGroup(s.project, g)!.placement.position.x).toBe(550);   // centre of 0..100 and 1000..1100
    expect(findPlane(s.project, a.plane)!.placement.position.x).toBe(-550);
    expect([at(s.project, a.curve), at(s.project, b.curve)]).toEqual(before);
  });

  it('⌘G on selected objects nests them, and ungroup bakes the frame back in', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 1000);
    const ga = cmd.addGroup(s, [a.plane])!, gb = cmd.addGroup(s, [b.plane])!;
    cmd.selectGroup(s, ga);
    cmd.selectGroup(s, gb, true);
    expect(s.selection.groups).toEqual([ga, gb]);
    const before = [at(s.project, a.curve), at(s.project, b.curve)];
    const rig = cmd.groupSelection(s)!;
    expect(findGroup(s.project, rig)!.groups.sort()).toEqual([ga, gb].sort());
    expect(parentOfGroup(s.project, ga)?.id).toBe(rig);
    expect([at(s.project, a.curve), at(s.project, b.curve)]).toEqual(before);

    cmd.setGroupPlacement(s, rig, { position: { x: 0, y: 500, z: 0 }, rotation: { x: 0, y: 90, z: 0 } });
    const turned = [at(s.project, a.curve), at(s.project, b.curve)];
    cmd.ungroup(s, rig);
    expect(findGroup(s.project, rig)).toBeNull();
    expect(parentOfGroup(s.project, ga)).toBeNull();
    expect([at(s.project, a.curve), at(s.project, b.curve)]).toEqual(turned);
  });

  it('moving a parent moves the world, not the placements inside it', () => {
    const s = store();
    const { plane, curve } = plate(s, 0);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    const localPlane = JSON.stringify(findPlane(s.project, plane)!.placement);
    const localInner = JSON.stringify(findGroup(s.project, inner)!.placement);
    const points = JSON.stringify(s.project.curves[0].curve.points);
    const before = world(s.project, curve);

    const snap = cmd.snapshotGroups(s, [outer])!;
    cmd.transformGroup(s, snap, { pivot: { x: 0, y: 0, z: 0 }, translation: { x: 300, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 }, false);

    expect(JSON.stringify(findPlane(s.project, plane)!.placement)).toBe(localPlane);
    expect(JSON.stringify(findGroup(s.project, inner)!.placement)).toBe(localInner);
    expect(JSON.stringify(s.project.curves[0].curve.points)).toBe(points);
    for (const [i, p] of world(s.project, curve).entries()) expect(p.x - before[i].x).toBeCloseTo(300, 9);
  });

  it('a selected parent and child are transformed once, not twice', () => {
    const s = store();
    const { plane, curve } = plate(s, 0);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    const before = world(s.project, curve);
    const snap = cmd.snapshotGroups(s, [outer, inner])!;
    expect(snap.roots).toEqual([outer]);
    cmd.transformGroup(s, snap, { pivot: { x: 0, y: 0, z: 0 }, translation: { x: 100, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 }, false);
    expect(world(s.project, curve)[0].x - before[0].x).toBeCloseTo(100, 9);
  });

  it('scale is baked into the contents, so the object frames stay rigid', () => {
    const s = store();
    const { plane, curve } = plate(s, 200);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    const placement = JSON.stringify(findGroup(s.project, outer)!.placement);
    const before = world(s.project, curve);
    const snap = cmd.snapshotGroups(s, [outer])!;
    cmd.transformGroup(s, snap, { pivot: { x: 0, y: 0, z: 0 }, translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: 2 }, false);
    expect(JSON.stringify(findGroup(s.project, outer)!.placement)).toBe(placement);
    for (const [i, p] of world(s.project, curve).entries()) {
      expect(p.x).toBeCloseTo(before[i].x * 2, 6);
      expect(p.y).toBeCloseTo(before[i].y * 2, 6);
    }
  });

  it('refuses cycles and keeps one parent per object', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 1000);
    const ga = cmd.addGroup(s, [a.plane])!, gb = cmd.addGroup(s, [b.plane])!;
    cmd.setGroupParent(s, gb, ga);
    cmd.setGroupParent(s, ga, gb);                       // would be a cycle: refused
    expect(parentOfGroup(s.project, ga)).toBeNull();
    expect(parentOfGroup(s.project, gb)?.id).toBe(ga);
    cmd.setGroupParent(s, ga, ga);
    expect(parentOfGroup(s.project, ga)).toBeNull();
  });

  it('hides a whole subtree, and the children keep their own eye', () => {
    const s = store();
    const { plane } = plate(s, 0);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    cmd.setGroupVisible(s, [outer], false);
    expect(groupVisible(s.project, inner)).toBe(false);
    expect(planeVisible(s.project, plane)).toBe(false);
    expect(findGroup(s.project, inner)!.visible).toBe(true);
    expect(overview(s)).toContain('hidden');
    cmd.setGroupVisible(s, [outer], true);
    expect(planeVisible(s.project, plane)).toBe(true);
  });

  it('duplicates the whole subtree, lofts included, 200 mm along X', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 300);
    cmd.addLoft(s, a.curve, b.curve);
    const inner = cmd.addGroup(s, [a.plane, b.plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    const copy = cmd.duplicateGroup(s, outer)!;
    expect(s.project.groups).toHaveLength(4);
    expect(s.project.planes).toHaveLength(4);
    expect(s.project.lofts).toHaveLength(2);
    expect(loftsOfGroup(s.project, findGroup(s.project, copy)!)).toHaveLength(1);
    const orig = findGroup(s.project, outer)!, dup = findGroup(s.project, copy)!;
    expect(dup.placement.position.x - orig.placement.position.x).toBe(200);
    expect(subtreePlanes(s.project, dup).some((id) => subtreePlanes(s.project, orig).includes(id))).toBe(false);
  });

  it('a loft inside an object is built in world space, so it follows the parent', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 300);
    const loft = cmd.addLoft(s, a.curve, b.curve)!;
    const g = cmd.addGroup(s, [a.plane, b.plane])!;
    const rig = cmd.addGroup(s, { groups: [g] })!;
    const build = () => {
      const l = s.project.lofts.find((x) => x.id === loft)!;
      const ca = s.project.curves.find((c) => c.id === l.a)!, cb = s.project.curves.find((c) => c.id === l.b)!;
      const built = buildLoft(l, ca, cb, planeWorld(s.project, s.project.planes.find((p) => p.id === ca.planeId)!).matrix, planeWorld(s.project, s.project.planes.find((p) => p.id === cb.planeId)!).matrix)!;
      built.mesh.geometry.computeBoundingBox();
      return built.mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
    };
    const before = build();
    const origin = { ...findGroup(s.project, rig)!.placement.position };
    cmd.setGroupPlacement(s, rig, { position: { ...origin, y: origin.y + 700 } });
    const after = build();
    expect(after.y - before.y).toBeCloseTo(700, 6);
    expect(after.x).toBeCloseTo(before.x, 6);
  });

  it('duplicating a plane inside an object keeps the copy in it, in place', () => {
    const s = store();
    const { plane, curve } = plate(s, 0);
    const g = cmd.addGroup(s, [plane])!;
    cmd.setGroupPlacement(s, g, { position: { x: 900, y: 0, z: 0 } });
    const before = at(s.project, curve);
    const copy = cmd.duplicatePlane(s, plane)!;
    expect(findGroup(s.project, g)!.planes).toContain(copy);
    const copied = s.project.curves.filter((c) => c.planeId === copy);
    expect(copied).toHaveLength(1);
    // Part 6 shifts a duplicated plane's curves 200 mm in X; the rest of the world stays put
    expect(at(s.project, copied[0].id)).toEqual(before.map(([x, y, z]) => [x + 200, y, z]));
  });

  it('deleting an object takes its child objects, planes and curves with it', () => {
    const s = store();
    const { plane } = plate(s, 0);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    cmd.removeGroupContents(s, outer);
    expect(s.project.groups).toHaveLength(0);
    expect(s.project.planes).toHaveLength(0);
    expect(s.project.curves).toHaveLength(0);
  });

  it('a click selects the outermost object; a double-click steps in', () => {
    const s = store();
    const { plane, curve } = plate(s, 0);
    const inner = cmd.addGroup(s, [plane])!;
    const outer = cmd.addGroup(s, { groups: [inner] })!;
    const target = resolvePick(s.project, { curve: false, loft: false, plane: false, object: true }, { curveId: curve, loftId: null });
    expect(target).toEqual({ kind: 'object', id: outer, curveId: curve });
  });

  it('migrates a version 9 project: flat objects gain an identity frame, no children, visible', () => {
    const s = store();
    const { plane } = plate(s, 0);
    const g = cmd.addGroup(s, [plane])!;
    const v9 = JSON.parse(JSON.stringify(s.project)) as Record<string, unknown> & { groups: { id: Id; name: string; planes: Id[] }[] };
    v9.version = 9;
    v9.groups = [{ id: g, name: 'Object 1', planes: [plane] }];
    const m = migrateProject(v9)!;
    expect(m.version).toBe(18);
    expect(m.groups[0]).toMatchObject({ groups: [], visible: true, placement: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } });
  });
});
