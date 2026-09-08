/** Materials on curves and lofts (docs/10-materials.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, migrateProject, texturesInCode } from '../src/model/types';
import { buildShapeGeometry, shapeInput } from '../src/geometry/shape';
import { buildLoft, checkerMaterial } from '../src/geometry/loft';
import { planeWorld } from '../src/geometry/placement';
import { buildMaterial, hostForObjects } from '../src/materials/runtime';
import { vertex } from '../src/model/types';

const GOLD = '(tsl, host) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.colorNode = tsl.color(0.8, 0.6, 0.1); return m; }';

function fixture() {
  const store = new Store(emptyProject('m', DEFAULT_PROFILES));
  const plane = cmd.addPlane(store, 'front');
  const line = (y: number) => { const id = cmd.addCurve(store, plane); cmd.addVertex(store, id, { x: 0, y }); cmd.addVertex(store, id, { x: 1000, y }); cmd.exitEdit(store); return id; };
  const a = line(0), b = line(500);
  const loft = cmd.addLoft(store, a, b)!;
  return { store, a, b, loft };
}

describe('materials', () => {
  it('are added to the project with a unique slug id and assigned to curves and lofts', () => {
    const { store, a, b, loft } = fixture();
    const id = cmd.addMaterial(store, { name: 'Golden Net', code: GOLD, source: 'x.blend', warnings: ['w'] });
    const id2 = cmd.addMaterial(store, { name: 'Golden Net', code: GOLD, source: '', warnings: [] });
    expect([id, id2]).toEqual(['golden-net', 'golden-net-2']);
    cmd.setCurveMaterial(store, [a, b], id);
    cmd.setLoftMaterial(store, loft, id2);
    expect(store.project.curves.map((c) => c.outline[0].materialId)).toEqual([id, id]);
    expect(store.project.lofts[0].materialId).toBe(id2);
    const text = overview(store);
    expect(text).toContain(`material ${id}`);
    expect(text).toContain('Materials: golden-net "Golden Net" (1 ⚠) · golden-net-2 "Golden Net"');
  });

  it('removing a material unassigns it; a dangling id never survives validation', () => {
    const { store, a } = fixture();
    const id = cmd.addMaterial(store, { name: 'G', code: GOLD, source: '', warnings: [] });
    cmd.setCurveMaterial(store, [a], id);
    cmd.removeMaterial(store, id);
    expect(store.project.curves[0].outline[0].materialId).toBeNull();
    store.update((s) => { s.project.curves[0].outline[0].materialId = 'ghost'; });
    expect(store.project.curves[0].outline[0].materialId).toBeNull();
  });

  it('survives save / load and migrates older files', () => {
    const { store, a } = fixture();
    const id = cmd.addMaterial(store, { name: 'G', code: GOLD, source: '', warnings: [] });
    cmd.setCurveMaterial(store, [a], id);
    const loaded = migrateProject(JSON.parse(JSON.stringify(store.project)))!;
    expect(loaded).toEqual(store.project);
    const old = JSON.parse(JSON.stringify(store.project)) as { materials?: unknown; curves: { outline: { materialId?: unknown }[] }[]; lofts: { materialId?: unknown }[] };
    delete old.materials; for (const c of old.curves) for (const l of c.outline) delete l.materialId; for (const l of old.lofts) delete l.materialId;
    const migrated = migrateProject(old)!;
    expect(migrated.materials).toEqual([]);
    expect(migrated.curves.every((c) => c.outline[0].materialId === null)).toBe(true);
    expect(migrated.lofts.every((l) => l.materialId === null)).toBe(true);
  });

  it('builds material code with the shared per-object host', () => {
    const m = buildMaterial(GOLD, hostForObjects());
    expect(m.colorNode).toBeTruthy();
  });

  it('gives tubes uv in mm (u along the tube, v around it) and lofts a shared checker material', () => {
    const round15 = DEFAULT_PROFILES.find((p) => p.id === 'round15')!;
    const geo = buildShapeGeometry(round15.code, shapeInput({ id: 't', name: 't', curve: { points: [vertex(0, 0), vertex(1000, 0)], closed: false } })!, round15.params).geometry;
    const uv = geo.getAttribute('uv');
    let uMax = 0, vMax = 0;
    for (let i = 0; i < uv.count; i++) { uMax = Math.max(uMax, uv.getX(i)); vMax = Math.max(vMax, uv.getY(i)); }
    expect(uMax).toBeCloseTo(1000, 3);
    expect(Math.abs(vMax - Math.PI * 15)).toBeLessThan(0.2);   // the perimeter of the 32-gon
    const { store, a, b } = fixture();
    const ca = store.project.curves.find((c) => c.id === a)!, cb = store.project.curves.find((c) => c.id === b)!;
    const built = buildLoft(store.project.lofts[0], ca, cb, planeWorld(store.project, store.planeOf(ca)).matrix, planeWorld(store.project, store.planeOf(cb)).matrix)!;
    expect(built.mesh.material).toBe(checkerMaterial(false));
    expect(built.mesh.geometry.getAttribute('color')).toBeUndefined();
  });

  // -- textures (docs/13-material-editor.md) ------------------------------------------------

  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const NET = "(tsl, host) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.colorNode = tsl.texture(host.texture('net'), host.uv.xy).rgb; return m; }";

  it('keeps textures in the project with unique ids; code references them by id', () => {
    const { store } = fixture();
    const a = cmd.addTexture(store, { name: 'Net', mime: 'image/png', data: PNG, width: 1, height: 1, source: 'net.png' });
    const b = cmd.addTexture(store, { name: 'Net', mime: 'image/png', data: PNG, width: 1, height: 1, source: '' });
    expect([a, b]).toEqual(['net', 'net-2']);
    cmd.updateTexture(store, a, { name: 'Golden net' });
    expect(store.project.textures[0]).toMatchObject({ id: 'net', name: 'Golden net', width: 1 });
    expect(texturesInCode(NET)).toEqual(['net']);
    expect(texturesInCode('host.texture("a"); host.texture( `b` ); host.texture(\'a\')')).toEqual(['a', 'b']);
    expect(overview(store)).toContain('Textures: net "Golden net" 1×1 · net-2 "Net" 1×1');
    cmd.removeTexture(store, b);
    expect(store.project.textures.map((t) => t.id)).toEqual(['net']);
    const m = buildMaterial(NET, hostForObjects());   // unknown ids fall back to the grey placeholder
    expect(m.colorNode).toBeTruthy();
  });

  it('reorders materials and textures (the dropdown order) and duplicates next to the original', () => {
    const { store } = fixture();
    const ids = ['A', 'B', 'C'].map((n) => cmd.addMaterial(store, { name: n, code: GOLD, source: '', warnings: [] }));
    cmd.moveMaterial(store, ids[2], 0);
    expect(store.project.materials.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    cmd.moveMaterial(store, 'c', 99);
    expect(store.project.materials.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(cmd.duplicateMaterial(store, 'a')).toBe('a-copy');
    expect(store.project.materials.map((m) => m.id)).toEqual(['a', 'a-copy', 'b', 'c']);
    for (const n of ['x', 'y']) cmd.addTexture(store, { name: n, mime: 'image/png', data: PNG, width: 1, height: 1, source: '' });
    cmd.moveTexture(store, 'y', 0);
    expect(store.project.textures.map((t) => t.id)).toEqual(['y', 'x']);
  });

  it('adds a library material together with the textures it carries (existing ids are kept)', () => {
    const { store, a } = fixture();
    cmd.addTexture(store, { name: 'net', mime: 'image/png', data: 'data:old', width: 2, height: 2, source: '' });
    const id = cmd.addLibraryMaterial(store, { name: 'Net', code: NET, source: 'lib.blend', warnings: [], textures: [
      { id: 'net', name: 'net', mime: 'image/png', data: PNG, width: 1, height: 1, source: 'lib.blend' },
      { id: 'mask', name: 'mask', mime: 'image/png', data: PNG, width: 1, height: 1, source: 'lib.blend' },
    ] });
    cmd.setCurveMaterial(store, [a], id);
    expect(store.project.textures.map((t) => [t.id, t.data])).toEqual([['net', 'data:old'], ['mask', PNG]]);
    const old = JSON.parse(JSON.stringify(store.project)) as { textures?: unknown };
    delete old.textures;
    expect(migrateProject(old)!.textures).toEqual([]);
    expect(migrateProject(JSON.parse(JSON.stringify(store.project)))).toEqual(store.project);
  });
});
