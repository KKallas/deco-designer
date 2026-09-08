/** The object archive (docs/33-object-archive.md): an item is a one-object project; assets merge by id; the subtree copies with fresh ids. */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_FILLS, DEFAULT_PROFILES } from '../src/model/defaults';
import { clone, emptyProject, findGroup, findPlane, migrateProject, type Id, type Project } from '../src/model/types';
import { archiveItem, exportProject, insertItem, mergeAssets, readItem, texturesOfMaterial } from '../src/app/archive';
import { planeWorld } from '../src/geometry/placement';

const fresh = () => new Store(emptyProject('Test', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } })), DEFAULT_FILLS.map((f) => ({ ...f, params: { ...f.params } }))));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** An object "Chelsy 250": one plane, two curves (round15, one with a gold material sampling a texture), a loft, a shape. */
function build(s: Store, name = 'Chelsy 250'): { group: Id; plane: Id; a: Id; b: Id; material: Id; texture: Id } {
  const plane = cmd.addPlane(s, 'front');
  cmd.setPlanePlacement(s, plane, { position: { x: 100, y: 200, z: 300 } });
  const a = cmd.addCurve(s, plane);
  cmd.addVertex(s, a, { x: 0, y: 0 }); cmd.addVertex(s, a, { x: 500, y: 0 }); cmd.addVertex(s, a, { x: 500, y: 300 }); cmd.addVertex(s, a, { x: 0, y: 300 });
  cmd.exitEdit(s);
  const b = cmd.addCurve(s, plane);
  cmd.addVertex(s, b, { x: 0, y: 600 }); cmd.addVertex(s, b, { x: 500, y: 600 });
  cmd.exitEdit(s);
  cmd.setCurveProfile(s, [a, b], 'round15');
  const texture = cmd.addTexture(s, { name: 'net', mime: 'image/png', data: PNG, width: 1, height: 1, source: 'net.png' });
  const material = cmd.addMaterial(s, { name: 'Gold', code: `(tsl, host) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.colorNode = tsl.texture(host.texture('${texture}'), host.uv.xy).rgb; return m; }`, source: '', warnings: [] });
  cmd.setCurveMaterial(s, [a], material);
  cmd.addLoft(s, a, b);
  cmd.addShape(s, [a]);
  const group = cmd.addGroup(s, { planes: [plane], name })!;
  return { group, plane, a, b, material, texture };
}

const curveOf = (p: Project, id: Id) => p.curves.find((c) => c.id === id)!;
const pts = (p: Project, id: Id) => curveOf(p, id).curve.points.map((v) => [v.x, v.y]);

describe('archive item', () => {
  it('is a project of one object carrying only the assets it references', () => {
    const s = fresh();
    const { group, plane } = build(s);
    // a second object with its own profile use: must not travel
    const other = cmd.addPlane(s, 'top'); const oc = cmd.addCurve(s, other); cmd.addVertex(s, oc, { x: 0, y: 0 }); cmd.addVertex(s, oc, { x: 100, y: 0 }); cmd.exitEdit(s);
    cmd.setCurveProfile(s, [oc], 'flat25x2');
    cmd.addGroup(s, { planes: [other], name: 'Other' });

    const item = archiveItem(s.project, group, { thumbnail: PNG, tags: ['decoration'], now: new Date('2026-09-05T09:00:00Z') })!;
    expect(item.version).toBe(18);
    expect(item.name).toBe('Chelsy 250');
    expect(item.item).toMatchObject({ root: group, thumbnail: PNG, tags: ['decoration'], created: '2026-09-05T09:00:00.000Z', app: 'deco-designer' });
    expect(item.groups.map((g) => g.id)).toEqual([group]);
    expect(item.planes).toHaveLength(1);
    expect(item.curves).toHaveLength(2);
    expect(item.lofts).toHaveLength(1);
    expect(item.shapes).toHaveLength(1);
    expect(item.profiles.map((p) => p.id)).toEqual(['round15']);
    expect(item.fills.map((f) => f.id)).toEqual(['sheet']);
    expect(item.materials.map((m) => m.name)).toEqual(['Gold']);
    expect(item.textures.map((t) => t.name)).toEqual(['net']);
    expect(item.cameras.map((c) => c.id)).toEqual(['camera-1']);   // an item is an emptyProject: Camera 1 rides along, never inserted
    // the root lands where it is put: its placement is zeroed, the plane inside keeps its own (local to the object)
    expect(item.groups[0].placement.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(item.planes[0].placement).toEqual(findPlane(s.project, plane)!.placement);
    // and it is a loadable project on its own
    expect(migrateProject(clone(item))).not.toBeNull();
  });

  it('ships one profile even for an object of construction lines', () => {
    const s = fresh();
    const plane = cmd.addPlane(s, 'front'); const c = cmd.addCurve(s, plane); cmd.addVertex(s, c, { x: 0, y: 0 }); cmd.addVertex(s, c, { x: 100, y: 0 }); cmd.exitEdit(s);
    s.update((st) => { st.project.curves[0].outline = []; });
    const g = cmd.addGroup(s, { planes: [plane], name: 'Lines' })!;
    const item = archiveItem(s.project, g)!;
    expect(item.profiles).toHaveLength(1);
    expect(readItem(item)).not.toBeNull();
  });

  it('drops reference images unless asked to keep them', () => {
    const s = fresh();
    const { group, plane } = build(s);
    const tex = cmd.addTexture(s, { name: 'drawing', mime: 'image/png', data: PNG, width: 1, height: 1, source: 'drawing.png' });
    cmd.setPlaneImage(s, plane, { texture: tex });
    const bare = archiveItem(s.project, group)!;
    expect(bare.planes[0].image).toBeNull();
    expect(bare.textures.map((t) => t.name)).toEqual(['net']);
    const full = archiveItem(s.project, group, { images: true })!;
    expect(full.planes[0].image?.texture).toBe(tex);
    expect(full.textures.map((t) => t.name).sort()).toEqual(['drawing', 'net']);
  });

  it('finds the textures a material samples', () => {
    expect(texturesOfMaterial({ code: "tsl.texture(host.texture('net'), uv); host.texture(\"bump\")" })).toEqual(['net', 'bump']);
  });
});

describe('export (docs/33 §13): the whole file as one item', () => {
  it('a file of one object exports that object, with the cameras, post and clock riding along', () => {
    const s = fresh();
    const { group } = build(s);
    cmd.updateCamera(s, 'camera-1', { focalLength: 85 });
    const before = JSON.stringify(s.project);
    const item = exportProject(s.project)!;
    expect(item.item.root).toBe(group);
    expect(item.groups.map((g) => g.id)).toEqual([group]);
    expect(item.name).toBe('Test');
    expect(item.cameras[0].focalLength).toBe(85);
    expect(item.activeCamera).toBe('camera-1');
    expect(JSON.stringify(s.project)).toBe(before);                              // the project is not touched
    expect(migrateProject(clone(item))).not.toBeNull();
  });

  it('loose planes and several objects get one enclosing object named after the project; world positions hold', () => {
    const s = fresh();
    s.update((st) => { st.project.name = 'Shop window'; });
    const { group: g1, plane: p1 } = build(s, 'Chelsy 250');
    const { group: g2 } = build(s, 'Nolita 250');
    cmd.setGroupPlacement(s, g2, { position: { x: 1000, y: 0, z: 0 } });
    const loose = cmd.addPlane(s, 'top');
    cmd.setPlanePlacement(s, loose, { position: { x: 0, y: 2000, z: 0 } });
    const lc = cmd.addCurve(s, loose); cmd.addVertex(s, lc, { x: 0, y: 0 }); cmd.addVertex(s, lc, { x: 100, y: 0 }); cmd.exitEdit(s);
    const item = exportProject(s.project)!;
    const root = findGroup(item, item.item.root)!;
    expect(root.name).toBe('Shop window');
    expect(root.id).toBe('shop-window');
    expect(root.groups.sort()).toEqual([g1, g2].sort());
    expect(root.planes).toEqual([loose]);
    expect(root.placement.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(item.groups).toHaveLength(3);
    expect(item.planes).toHaveLength(3);
    expect(item.curves).toHaveLength(5);
    expect(s.project.groups).toHaveLength(2);                                     // the wrapper lives in the file only
    // brought into the next work: one object, everything where it was
    const dst = fresh();
    const r = insertItem(dst.project, JSON.parse(JSON.stringify(item)))!;
    expect(findGroup(dst.project, r.root)!.name).toBe('Shop window');
    expect(dst.project.groups.filter((g) => !dst.project.groups.some((p) => p.groups.includes(g.id)))).toHaveLength(1);
    expect(planeWorld(dst.project, findPlane(dst.project, r.planes.get(loose)!)!).origin.toArray()).toEqual(planeWorld(s.project, findPlane(s.project, loose)!).origin.toArray());
    expect(planeWorld(dst.project, findPlane(dst.project, r.planes.get(p1)!)!).origin.toArray()).toEqual(planeWorld(s.project, findPlane(s.project, p1)!).origin.toArray());
    expect(dst.project.cameras).toEqual(fresh().project.cameras);                 // the file's cameras stay out of the next work
  });

  it('an empty project has nothing to export', () => {
    expect(exportProject(fresh().project)).toBeNull();
  });
});

describe('insert', () => {
  it('round-trips: the object comes back with its geometry, layers and world frame', () => {
    const src = fresh();
    const { group, plane, a, b, material } = build(src);
    cmd.setGroupPlacement(src, group, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });   // an item's root is zeroed, so compare from a zeroed source
    const item = archiveItem(src.project, group)!;
    const json = JSON.parse(JSON.stringify(item)) as unknown;   // as read from disk

    const dst = fresh();
    const r = insertItem(dst.project, json)!;
    expect(r).not.toBeNull();
    const root = findGroup(dst.project, r.root)!;
    expect(root.name).toBe('Chelsy 250');
    expect(root.planes).toHaveLength(1);
    const newPlane = findPlane(dst.project, r.planes.get(plane)!)!;
    expect(planeWorld(dst.project, newPlane).origin.toArray()).toEqual(planeWorld(src.project, findPlane(src.project, plane)!).origin.toArray());
    expect(pts(dst.project, r.curves.get(a)!)).toEqual(pts(src.project, a));
    expect(pts(dst.project, r.curves.get(b)!)).toEqual(pts(src.project, b));
    const la = curveOf(dst.project, r.curves.get(a)!).outline[0];
    expect(la.profileId).toBe('round15');
    expect(la.materialId).toBe(material);
    expect(dst.project.lofts).toHaveLength(1);
    expect(dst.project.lofts[0].a).toBe(r.curves.get(a));
    expect(dst.project.shapes).toHaveLength(1);
    expect(dst.project.shapes[0].curves).toEqual([r.curves.get(a)]);
    // the material came along and still samples its texture
    expect(dst.project.materials.map((m) => m.name)).toEqual(['Gold']);
    expect(dst.project.textures.map((t) => t.name)).toEqual(['net']);
    // the scene is the target's
    expect(dst.project.cameras).toEqual(fresh().project.cameras);
    expect(dst.project.activeCamera).toBe(fresh().project.activeCamera);
  });

  it('reuses identical assets and renames differing ones, never touching the project\'s own', () => {
    const src = fresh();
    const { group } = build(src);
    const item = archiveItem(src.project, group)!;

    const dst = fresh();
    insertItem(dst.project, item);
    const profiles = dst.project.profiles.length, materials = dst.project.materials.length, textures = dst.project.textures.length;
    insertItem(dst.project, item);
    expect(dst.project.profiles).toHaveLength(profiles);         // a second Chelsy adds no second round15
    expect(dst.project.materials).toHaveLength(materials);
    expect(dst.project.textures).toHaveLength(textures);
    expect(dst.project.groups.map((g) => g.name)).toEqual(['Chelsy 250', 'Chelsy 250 2']);

    // now the project's round15 is different: the item's comes in as round15-2 and the project's is untouched
    const before = clone(dst.project.profiles.find((p) => p.id === 'round15')!);
    dst.update((s) => { s.project.profiles.find((p) => p.id === 'round15')!.params = { ...before.params, diameter: 99 }; });
    const r = insertItem(dst.project, item)!;
    expect(dst.project.profiles.find((p) => p.id === 'round15')).toEqual({ ...before, params: { ...before.params, diameter: 99 } });
    expect(dst.project.profiles.some((p) => p.id === 'round15-2')).toBe(true);
    for (const id of r.curves.values()) expect(curveOf(dst.project, id).outline[0].profileId).toBe('round15-2');
  });

  it('renames a clashing texture and rewrites the material that samples it', () => {
    const src = fresh();
    const { group, texture } = build(src);
    const item = archiveItem(src.project, group)!;
    const dst = fresh();
    cmd.addTexture(dst, { id: texture, name: 'net', mime: 'image/png', data: 'data:image/png;base64,AAAA', width: 2, height: 2, source: 'other.png' });
    insertItem(dst.project, item);
    const renamed = dst.project.textures.find((t) => t.id !== texture)!;
    expect(renamed.id).toBe(`${texture}-2`);
    expect(dst.project.textures.find((t) => t.id === texture)!.data).toBe('data:image/png;base64,AAAA');
    expect(texturesOfMaterial(dst.project.materials[0])).toEqual([renamed.id]);
  });

  it('inserts into the project it came from — every id clashes, nothing existing changes', () => {
    const s = fresh();
    const { group } = build(s);
    const item = archiveItem(s.project, group)!;
    const before = clone(s.project);
    const r = insertItem(s.project, item, { into: group })!;
    // the old entries are byte-identical, the new ones are appended
    expect(s.project.curves.slice(0, before.curves.length)).toEqual(before.curves);
    expect(s.project.planes.slice(0, before.planes.length)).toEqual(before.planes);
    expect(s.project.groups.slice(0, before.groups.length).map((g) => ({ ...g, groups: [] }))).toEqual(before.groups.map((g) => ({ ...g, groups: [] })));
    expect(s.project.curves).toHaveLength(before.curves.length * 2);
    expect(s.project.lofts).toHaveLength(2);
    expect(s.project.shapes).toHaveLength(2);
    expect(r.root).not.toBe(group);
    expect(findGroup(s.project, group)!.groups).toEqual([r.root]);           // parented where asked
    expect(findGroup(s.project, r.root)!.placement.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(new Set(s.project.curves.map((c) => c.id)).size).toBe(s.project.curves.length);
  });

  it('reads an item saved by an earlier version, and refuses what is not one', () => {
    const src = fresh();
    const { group } = build(src);
    const old = JSON.parse(JSON.stringify(archiveItem(src.project, group))) as { version: number; item?: unknown };
    old.version = 16;
    delete old.item;                                                        // a bare one-object project is an item too
    const dst = fresh();
    expect(insertItem(dst.project, old)).not.toBeNull();
    expect(dst.project.groups).toHaveLength(1);
    expect(insertItem(dst.project, { hello: 'world' })).toBeNull();
    expect(insertItem(dst.project, emptyProject('empty', DEFAULT_PROFILES))).toBeNull();   // no object in it
  });

  it('mergeAssets: free → added, identical → reused, differing → fresh id', () => {
    const have = [{ id: 'a', label: 'A', code: '1' }, { id: 'b', label: 'B', code: '2' }];
    const map = mergeAssets(have, [{ id: 'a', label: 'renamed', code: '1' }, { id: 'b', label: 'B', code: 'x' }, { id: 'c', label: 'C', code: '3' }]);
    expect([...map]).toEqual([['a', 'a'], ['b', 'b-2'], ['c', 'c']]);
    expect(have.map((x) => x.id)).toEqual(['a', 'b', 'b-2', 'c']);
    expect(have[0].label).toBe('A');
  });

  it('⌘D still duplicates through the same walk', () => {
    const s = fresh();
    const { group, a } = build(s);
    const x0 = findGroup(s.project, group)!.placement.position.x;
    const copy = cmd.duplicateGroup(s, group)!;
    const g = findGroup(s.project, copy)!;
    expect(g.name).toBe('Chelsy 250 copy');
    expect(g.placement.position.x).toBe(x0 + 200);
    expect(s.project.curves).toHaveLength(4);
    expect(s.project.lofts).toHaveLength(2);
    expect(s.project.shapes).toHaveLength(2);
    expect(s.project.curves.filter((c) => c.name === curveOf(s.project, a).name)).toHaveLength(2);   // curves keep their names
    expect(s.selection.groups).toEqual([copy]);
  });
});
