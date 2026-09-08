/**
 * Part 19 (docs/19-reference-image.md): the reference image a plane carries so
 * shapes can be traced over a drawing — the command, its clamping, the undo
 * behaviour of a live drag, and what a stored project does with it.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findPlane, migrateProject, type Id, type Project } from '../src/model/types';

// a 1×1 png, enough to be a project texture (the viewer is what decodes it)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function setup(): { store: Store; plane: Id; texture: Id } {
  const store = new Store(emptyProject('ref', DEFAULT_PROFILES));
  const plane = cmd.addPlane(store, 'front');
  const texture = cmd.addTexture(store, { name: 'drawing', mime: 'image/png', data: PNG, width: 1000, height: 500, source: 'sheet.png' });
  return { store, plane, texture };
}
const imageOf = (store: Store, plane: Id) => findPlane(store.project, plane)!.image;

describe('reference image on a plane', () => {
  it('starts with the defaults: 2000 mm wide on the plane origin, faded, visible, unlocked to be placed', () => {
    const { store, plane, texture } = setup();
    expect(imageOf(store, plane)).toBeNull();
    cmd.setPlaneImage(store, plane, { texture });
    expect(imageOf(store, plane)).toEqual({ texture, center: { x: 0, y: 0 }, width: 2000, rotation: 0, opacity: 0.35, visible: true, locked: false });
  });

  it('needs a texture to start one, and a texture that is really in the project', () => {
    const { store, plane } = setup();
    cmd.setPlaneImage(store, plane, { width: 500 });                 // no texture yet: nothing to patch
    expect(imageOf(store, plane)).toBeNull();
    cmd.setPlaneImage(store, plane, { texture: 'nope' });
    expect(imageOf(store, plane)).toBeNull();
  });

  it('patches, clamps and removes', () => {
    const { store, plane, texture } = setup();
    cmd.setPlaneImage(store, plane, { texture });
    cmd.setPlaneImage(store, plane, { center: { x: 120, y: -80 }, width: 1160, rotation: 4, locked: true });
    expect(imageOf(store, plane)).toMatchObject({ center: { x: 120, y: -80 }, width: 1160, rotation: 4, locked: true });
    cmd.setPlaneImage(store, plane, { opacity: 5, width: -3 });      // out of range: clamped, never broken
    expect(imageOf(store, plane)).toMatchObject({ opacity: 1, width: 1 });
    cmd.setPlaneImage(store, plane, { opacity: -1 });
    expect(imageOf(store, plane)!.opacity).toBe(0);
    cmd.setPlaneImage(store, plane, null);
    expect(imageOf(store, plane)).toBeNull();
  });

  it('a live drag is one undo step, not one per frame', () => {
    const { store, plane, texture } = setup();
    cmd.setPlaneImage(store, plane, { texture });
    for (let x = 10; x <= 100; x += 10) cmd.setPlaneImage(store, plane, { center: { x, y: 0 } }, true);
    expect(imageOf(store, plane)!.center.x).toBe(100);
    cmd.setPlaneImage(store, plane, { center: { x: 100, y: 0 } });     // the drag ends: one step
    store.undo();
    expect(imageOf(store, plane)!.center).toEqual({ x: 0, y: 0 });     // the whole drag, not one frame of it
    store.redo();
    expect(imageOf(store, plane)!.center.x).toBe(100);
  });

  it('survives save → load, and an older project simply has none', () => {
    const { store, plane, texture } = setup();
    cmd.setPlaneImage(store, plane, { texture, center: { x: 50, y: 20 }, width: 1160, locked: true });
    const saved = JSON.parse(JSON.stringify(store.project)) as Project;
    expect(saved.version).toBe(18);
    const back = migrateProject(saved)!;
    expect(findPlane(back, plane)!.image).toMatchObject({ texture, width: 1160, locked: true });

    const old = JSON.parse(JSON.stringify(store.project)) as Record<string, unknown> & { version: number; planes: { image?: unknown }[] };
    old.version = 10;
    for (const p of old.planes) delete p.image;
    const up = migrateProject(old)!;
    expect(up.version).toBe(18);
    expect(findPlane(up, plane)!.image).toBeNull();
  });

  it('drops an image whose texture went away, rather than pointing at nothing', () => {
    const { store, plane, texture } = setup();
    cmd.setPlaneImage(store, plane, { texture });
    const saved = JSON.parse(JSON.stringify(store.project)) as Project;
    saved.textures = [];
    expect(findPlane(migrateProject(saved)!, plane)!.image).toBeNull();
  });
});
