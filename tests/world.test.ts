/** The world: background, environment, sun, exposure — every camera carries one (docs/16-world.md, docs/36-camera-world.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, migrateProject } from '../src/model/types';
import { activeCameraOf } from '../src/model/camera';
import { defaultWorld, describeWorld, isHdrMime, mergeWorld, normalizeWorld, sunDirection, worldTextures } from '../src/model/world';
import { sniffMime } from '../src/materials/textures';
import { decodeHdr } from '../src/materials/hdr';

/** A flat (non-RLE) Radiance .hdr: `w × h` pixels of one RGBE value. */
function radianceFile(w: number, h: number, rgbe: [number, number, number, number]): Uint8Array {
  const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
  const out = new Uint8Array(head.length + w * h * 4);
  out.set(head);
  for (let i = 0; i < w * h; i++) out.set(rgbe, head.length + i * 4);
  return out;
}

describe('world', () => {
  it('the default reproduces the old fixed rig: dark grey, studio room, a sun from the front right', () => {
    const w = defaultWorld();
    expect(w).toMatchObject({ background: { kind: 'color', color: '#141416' }, environment: { kind: 'room' }, strength: 1, exposure: 1, sun: { enabled: true, strength: 2, shadows: false } });
    const d = sunDirection(w.sun);
    expect(d.y).toBeGreaterThan(0.7); expect(d.x).toBeGreaterThan(0); expect(d.z).toBeGreaterThan(0);   // ≈ the old (2000, 3000, 1500)
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1);
  });

  it('normalizes anything: missing fields, bad colours, an unknown kind', () => {
    expect(normalizeWorld(undefined)).toEqual(defaultWorld());
    expect(normalizeWorld({ background: { kind: 'hdr' }, environment: { kind: 'weird' }, sun: { strength: -3, color: 'red' }, exposure: 'x' }))
      .toMatchObject({ background: { kind: 'hdr', texture: '', blur: 0 }, environment: { kind: 'room' }, sun: { strength: 0, color: '#ffffff' }, exposure: 1 });
    expect(normalizeWorld({ background: { kind: 'hdr', texture: 'sky', blur: 3 } }).background).toEqual({ kind: 'hdr', texture: 'sky', blur: 1 });
  });

  it('patches merge one level down; a kind change keeps what the new kind can use', () => {
    const w = mergeWorld(defaultWorld(), { sun: { enabled: false }, environment: { kind: 'color', color: '#ffffff' } });
    expect(w.sun).toMatchObject({ enabled: false, strength: 2 });
    expect(w.environment).toEqual({ kind: 'color', color: '#ffffff' });
    const h = mergeWorld(w, { background: { kind: 'hdr', texture: 'sky' } });
    expect(h.background).toEqual({ kind: 'hdr', texture: 'sky', blur: 0 });
    expect(mergeWorld(h, { background: { kind: 'color' } }).background).toEqual({ kind: 'color', color: '#141416' });
    expect(worldTextures(mergeWorld(h, { environment: { kind: 'hdr', texture: 'sky' } }))).toEqual(['sky']);
  });

  it('is the camera\'s (docs/36): every camera carries one, setWorld patches the active camera\'s, a new camera may copy one', () => {
    const store = new Store(emptyProject('t', DEFAULT_PROFILES));
    expect(store.project.cameras.map((c) => c.id)).toEqual(['camera-1']);
    expect(store.project.cameras[0].world).toEqual(defaultWorld());
    cmd.setWorld(store, { background: { kind: 'color', color: '#ffffff' }, sun: { enabled: false } });
    expect(activeCameraOf(store.project).world).toMatchObject({ background: { kind: 'color', color: '#ffffff' }, sun: { enabled: false } });
    const id = cmd.addCamera(store, { name: 'Hero' });
    expect(store.project.cameras[1].world).toEqual(defaultWorld());                  // a bare addCamera: the default world
    cmd.updateCamera(store, id, { world: { environment: { kind: 'none' } } });      // merges onto the camera's own
    expect(store.project.cameras[1].world).toMatchObject({ background: { color: '#141416' }, environment: { kind: 'none' }, sun: { enabled: true } });
    cmd.updateCamera(store, id, { world: { exposure: 2 } });
    expect(store.project.cameras[1].world).toMatchObject({ environment: { kind: 'none' }, exposure: 2 });
    cmd.updateCamera(store, id, { world: null });                                    // means nothing any more
    expect(store.project.cameras[1].world).toMatchObject({ environment: { kind: 'none' }, exposure: 2 });
    // the UI's "new camera from this view" hands the world of the camera being left along
    const copy = cmd.addCamera(store, { name: 'Look around', world: activeCameraOf(store.project).world });
    expect(store.project.cameras.find((c) => c.id === copy)!.world).toEqual(store.project.cameras[0].world);
    cmd.setActiveCamera(store, id);
    expect(activeCameraOf(store.project).world.exposure).toBe(2);
    store.undo();
    expect(store.project.activeCamera).toBe('camera-1');
    expect(store.project.cameras[0].world.background).toEqual({ kind: 'color', color: '#ffffff' });
    expect((store.selection as { world?: unknown }).world).toBeUndefined();          // no world row to select
  });

  it('migrates: a version 7 project gets the default world on its cameras; a version 17 project world lands on every camera without its own', () => {
    const p = emptyProject('old', DEFAULT_PROFILES) as unknown as Record<string, unknown>;
    p.version = 7; delete p.world;
    p.cameras = [{ id: 'cam', name: 'Cam', pose: { position: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 } } }];
    p.activeCamera = null;
    const m = migrateProject(JSON.parse(JSON.stringify(p)))!;
    expect(m.version).toBe(18);
    expect((m as { world?: unknown }).world).toBeUndefined();
    expect(m.cameras[0].world).toEqual(defaultWorld());
    expect(m.activeCamera).toBe('cam');                                              // the free view becomes the first camera
    const own = migrateProject({ ...JSON.parse(JSON.stringify(p)), cameras: [{ id: 'c', name: 'c', world: { environment: { kind: 'none' } } }] })!;
    expect(own.cameras[0].world).toMatchObject({ environment: { kind: 'none' }, sun: { enabled: true } });
    // version 17: the project's world goes to the cameras without their own; none → Camera 1 carries it
    const v17 = { ...JSON.parse(JSON.stringify(p)), version: 17, world: { background: { kind: 'color', color: '#ffffff' } }, cameras: [{ id: 'a', name: 'a', world: null }, { id: 'b', name: 'b', world: { exposure: 3 } }], activeCamera: 'b' };
    const m17 = migrateProject(v17)!;
    expect(m17.cameras[0].world).toMatchObject({ background: { color: '#ffffff' }, exposure: 1 });
    expect(m17.cameras[1].world).toMatchObject({ background: { color: '#141416' }, exposure: 3 });
    expect(m17.activeCamera).toBe('b');
    const none = migrateProject({ ...JSON.parse(JSON.stringify(p)), version: 17, world: { exposure: 2 }, cameras: [], activeCamera: null })!;
    expect(none.cameras.map((c) => c.id)).toEqual(['camera-1']);
    expect(none.cameras[0].world.exposure).toBe(2);
    expect(none.activeCamera).toBe('camera-1');
  });

  it('shows in the overview as the active camera\'s', () => {
    const store = new Store(emptyProject('t', DEFAULT_PROFILES));
    expect(overview(store)).toContain('World (camera-1): background #141416 · environment studio room ×1 · sun 2 at 55°/47° · exposure 1');
    const id = cmd.addCamera(store, { name: 'Hero' });
    cmd.updateCamera(store, id, { world: { background: { kind: 'hdr', texture: 'sky' } } });
    cmd.setActiveCamera(store, id);
    expect(overview(store)).toContain('World (hero): background HDR sky (missing)');
    expect(describeWorld(defaultWorld())).toContain('sun 2');
  });

  it('reads .hdr / .exr files as HDR textures and decodes Radiance pixels', () => {
    const file = radianceFile(4, 2, [128, 64, 32, 129]);   // 2^(129-128) × (v / 256) → 1.0, 0.5, 0.25
    expect(sniffMime(file, 'sky.hdr')).toBe('image/vnd.radiance');
    expect(isHdrMime(sniffMime(file))).toBe(true);
    expect(sniffMime(new Uint8Array([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]))).toBe('image/x-exr');
    expect(sniffMime(new Uint8Array([0, 0]), 'x.exr')).toBe('image/x-exr');
    expect(isHdrMime('image/png')).toBe(false);
    const img = decodeHdr(file.buffer as ArrayBuffer, 'image/vnd.radiance');
    expect([img.width, img.height]).toEqual([4, 2]);
    expect(img.data.length).toBe(4 * 2 * 4);
    expect(img.data[0]).toBeCloseTo(1); expect(img.data[1]).toBeCloseTo(0.5); expect(img.data[2]).toBeCloseTo(0.25);
  });
});
