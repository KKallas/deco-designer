/** Camera settings and the post-processing script (docs/15-camera.md). */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, migrateProject } from '../src/model/types';
import { activeCameraOf, cameraFov, defaultCamera, dofRange, frameRect, horizontalFov, stillSize, verticalFov } from '../src/model/camera';
import { EEVEE_V15, POST_PRESETS, defaultPost } from '../src/model/post-presets';
import { buildPostNode, compilePost } from '../src/view3d/effects';

describe('camera', () => {
  it('the frame is the camera: film back and lens give its field of view; the viewport shows it inscribed plus extra', () => {
    const cam = defaultCamera();                                   // 50 mm on 36×24
    expect(cameraFov(cam).vertical).toBeCloseTo(26.99, 1);         // 2·atan(24 / 100): the classic 50 mm
    expect(cameraFov(cam).horizontal).toBeCloseTo(39.6, 1);
    expect(verticalFov(cam, 1.5)).toBeCloseTo(26.99, 1);            // a 3:2 viewport is exactly the frame
    expect(verticalFov(cam, 1.78)).toBeCloseTo(26.99, 1);           // wider viewport: full-height frame, extra at the sides
    expect(horizontalFov(cam, 1.78)).toBeGreaterThan(39.6);
    expect(verticalFov(cam, 1.0)).toBeGreaterThan(26.99);           // square viewport: full-width frame, extra above and below
    expect(horizontalFov(cam, 1.0)).toBeCloseTo(39.6, 1);
    expect(cameraFov({ ...cam, focalLength: 24 }).vertical).toBeGreaterThan(50);
    expect(cameraFov({ ...cam, filmBack: { width: 7.6, height: 5.7 } }).vertical).toBeCloseTo(6.5, 0);   // a phone sensor with a 50 mm is a tele
    expect(frameRect(cam, 1800, 900)).toEqual({ x: 225, y: 0, w: 1350, h: 900 });    // pillarboxed
    expect(frameRect(cam, 900, 900)).toEqual({ x: 0, y: 150, w: 900, h: 600 });      // letterboxed
    expect(frameRect(cam, 1500, 1000)).toEqual({ x: 0, y: 0, w: 1500, h: 1000 });    // exact
  });

  it('blur range grows with focus distance and f-stop, shrinks with focal length', () => {
    const cam = { ...defaultCamera(), dof: { enabled: true, focusDistance: 3000, fStop: 2.8 } };
    const base = dofRange(cam);
    expect(base).toBeGreaterThan(100);
    expect(dofRange({ ...cam, dof: { ...cam.dof, fStop: 8 } })).toBeGreaterThan(base * 2);
    expect(dofRange({ ...cam, dof: { ...cam.dof, focusDistance: 6000 } })).toBeGreaterThan(base * 3);
    expect(dofRange({ ...cam, focalLength: 100 })).toBeLessThan(base / 3);
  });

  it('cameras are objects: add / update / pose / look through / remove; there is always one, always looked through (docs/36)', () => {
    const store = new Store(emptyProject('c', DEFAULT_PROFILES));
    expect(store.project.cameras.map((c) => c.id)).toEqual(['camera-1']);           // a new project starts with Camera 1
    expect(store.project.activeCamera).toBe('camera-1');
    expect(store.project.cameras[0]).toMatchObject({ ...defaultCamera(), name: 'Camera 1' });
    expect(cmd.removeCamera(store, 'camera-1')).toBeUndefined();
    expect(store.project.cameras.map((c) => c.id)).toEqual(['camera-1']);           // the last camera stays
    const a = cmd.addCamera(store, { name: 'Hero', pose: { position: { x: 0, y: 1000, z: 5000 }, target: { x: 0, y: 500, z: 0 } } });
    const b = cmd.addCamera(store, { name: 'Hero', focalLength: 85 });
    expect([a, b]).toEqual(['hero', 'hero-2']);
    expect(store.project.cameras[1]).toMatchObject({ ...defaultCamera(), id: 'hero', name: 'Hero', pose: { position: { x: 0, y: 1000, z: 5000 }, target: { x: 0, y: 500, z: 0 } } });
    cmd.updateCamera(store, a, { focalLength: 85, dof: { enabled: true, fStop: 2 }, filmBack: { width: 23.6 } });
    expect(store.project.cameras[1]).toMatchObject({ focalLength: 85, filmBack: { width: 23.6, height: 24 }, dof: { enabled: true, focusDistance: 3000, fStop: 2 } });
    cmd.setCameraPose(store, a, { position: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 } });
    expect(store.project.cameras[1].pose).toEqual({ position: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 } });
    expect(store.canUndo).toBe(true);
    cmd.setActiveCamera(store, a);
    expect(store.project.activeCamera).toBe('hero');
    cmd.setActiveCamera(store, 'ghost');
    expect(store.project.activeCamera).toBe('hero');                                 // an unknown id is a no-op, never null
    expect(activeCameraOf(store.project).id).toBe('hero');
    cmd.removeCamera(store, 'camera-1');
    expect(cmd.duplicateCamera(store, a)).toBe('hero-copy');
    expect(store.project.cameras.map((c) => c.id)).toEqual(['hero', 'hero-copy', 'hero-2']);
    cmd.moveCamera(store, 'hero-2', 0);
    expect(store.project.cameras[0].id).toBe('hero-2');
    cmd.setPost(store, { enabled: false, params: { threshold: 1 } });
    const text = overview(store);
    expect(text).toContain('◉ hero "Hero" 85 mm on 23.6×24');
    expect(text).toContain('DOF focus 3000 mm f/2');
    expect(text).toContain('Post: "Eevee glow" off (threshold=1)');
    cmd.selectCamera(store, a);
    expect(store.selection.cameraId).toBe('hero');
    expect(store.selection.curves).toEqual([]);
    cmd.enterPostEdit(store);
    expect(store.mode.kind).toBe('post');
    cmd.exitPostEdit(store);
    expect(store.mode.kind).toBe('object');
    cmd.removeCamera(store, a);                                                      // the one looked through: its neighbour takes over
    expect(store.selection.cameraId).toBeNull();
    expect(store.project.activeCamera).toBe('hero-2');
    expect(store.project.cameras.map((c) => c.id)).toEqual(['hero-2', 'hero-copy']);
    expect(overview(store)).toContain('◉ hero-2');
    expect(overview(store)).not.toContain('free view');
    // an agent script that empties the list still leaves a camera looked through (validate)
    store.update((s) => { s.project.cameras = []; });
    expect(store.project.cameras.map((c) => c.id)).toEqual(['camera-1']);
    expect(store.project.activeCamera).toBe('camera-1');
  });

  it('migrates: no cameras → Camera 1 looked through; a Part 15 single camera → "Camera 1", looked through', () => {
    const store = new Store(emptyProject('c', DEFAULT_PROFILES));
    const old = JSON.parse(JSON.stringify(store.project)) as Record<string, unknown>;
    delete old.cameras; delete old.activeCamera; delete old.post;
    const migrated = migrateProject(old)!;
    expect(migrated.cameras.map((c) => c.id)).toEqual(['camera-1']);
    expect(migrated.activeCamera).toBe('camera-1');
    expect(migrated.post).toEqual(defaultPost());
    const tuned = JSON.parse(JSON.stringify(store.project)) as Record<string, unknown>;
    delete tuned.cameras; delete tuned.activeCamera;
    tuned.version = 6; tuned.camera = { ...defaultCamera(), focalLength: 85, dof: { enabled: true, focusDistance: 2400, fStop: 2 } };
    const m2 = migrateProject(tuned)!;
    expect(m2.cameras.map((c) => c.id)).toEqual(['camera-1']);
    expect(m2.cameras[0]).toMatchObject({ name: 'Camera 1', focalLength: 85, dof: { focusDistance: 2400 } });
    expect(m2.activeCamera).toBe('camera-1');
    const plain = JSON.parse(JSON.stringify(store.project)) as Record<string, unknown>;
    delete plain.cameras; delete plain.activeCamera; plain.version = 6; plain.camera = defaultCamera();
    expect(migrateProject(plain)!.cameras).toEqual([{ ...defaultCamera(), id: 'camera-1', name: 'Camera 1', pose: store.project.cameras[0].pose, world: store.project.cameras[0].world }]);
    expect(migrateProject(JSON.parse(JSON.stringify(store.project)))).toEqual(store.project);
  });

  it('every preset builds an output node headless; a broken script is reported', () => {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1.5);
    const cam = { ...defaultCamera(), dof: { enabled: true, focusDistance: 2000, fStop: 2.8 } };
    for (const preset of POST_PRESETS) {
      const post = { enabled: true, label: preset.label, code: preset.code, params: { ...preset.params } };
      const { out, nodes } = buildPostNode(scene, camera, post, cam, 1.5);
      expect((out as { isNode?: boolean }).isNode, preset.id).toBe(true);
      expect(nodes.length, preset.id).toBeGreaterThan(0);
    }
    const eevee = { ...defaultPost() };
    expect(buildPostNode(scene, camera, eevee, cam, 1.5).nodes.length).toBeGreaterThan(4);           // pass, bloom, streaks (2 rtt), flare, dof
    expect(buildPostNode(scene, camera, eevee, cam, 1.5, false).nodes.length).toBe(buildPostNode(scene, camera, eevee, { ...cam, dof: { ...cam.dof, enabled: false } }, 1.5).nodes.length);   // no dof with the ortho camera
    expect(() => compilePost('(post) => {')).toThrow();
    expect(() => buildPostNode(scene, camera, { ...eevee, code: '(post) => 42' }, cam, 1.5)).toThrow(/must return a node/);
    expect(() => buildPostNode(scene, camera, { ...eevee, code: '(post) => { throw new Error("boom"); }' }, cam, 1.5)).toThrow(/boom/);
  });

  it('post.ssr (docs/31-ssr.md): the Eevee knob builds the reflection node, 0 builds nothing; an untouched Part 15 script is refreshed', () => {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1.5);
    const cam = defaultCamera();
    const eevee = defaultPost();
    expect(eevee.params.reflections).toBe(1);
    const on = buildPostNode(scene, camera, eevee, cam, 1.5).nodes;
    const off = buildPostNode(scene, camera, { ...eevee, params: { ...eevee.params, reflections: 0 } }, cam, 1.5).nodes;
    expect(on.length).toBe(off.length + 1);
    expect(on.some((n) => (n as { isSSRNode?: boolean }).isSSRNode || n.constructor.name === 'SSRNode')).toBe(true);
    // knobs land on the node in mm; the helper clamps quality to 0..1 and the resolution to 0.25..1
    const custom = { ...eevee, code: '(post) => post.ssr(post.scene.color, { maxDistance: 2500, thickness: 20, quality: 3, resolution: 0.1 })' };
    const node = buildPostNode(scene, camera, custom, cam, 1.5).nodes.find((n) => n.constructor.name === 'SSRNode') as unknown as { maxDistance: { value: number }; thickness: { value: number }; quality: { value: number }; resolutionScale: number };
    expect(node.maxDistance.value).toBe(2500);
    expect(node.thickness.value).toBe(20);
    expect(node.quality.value).toBe(1);
    expect(node.resolutionScale).toBe(0.25);
    // the scene pass carries what the trace reads
    const { scenePass } = buildPostNode(scene, camera, eevee, cam, 1.5);
    for (const ch of ['normal', 'specular']) expect(scenePass.getTextureNode(ch), ch).toBeTruthy();   // metalness / roughness ride in their alphas
    // migration 16 → 17: the verbatim Part 15 Eevee code becomes the preset and gains the knob, keeping tuned values
    const raw = (code: string) => ({ ...JSON.parse(JSON.stringify(emptyProject('x', DEFAULT_PROFILES))), version: 16, post: { enabled: false, label: 'Eevee glow', code, params: { threshold: 0.9, knee: 0.5, radius: 0.45, strength: 2, flare: 0, streaks: 0, streakLength: 0.1, bokeh: 1 } } });
    const m = migrateProject(raw(EEVEE_V15))!;
    expect(m.version).toBe(18);
    expect(m.post.code).toBe(eevee.code);
    expect(m.post.params).toEqual({ ...eevee.params, threshold: 0.9, strength: 2, flare: 0, streaks: 0 });
    expect(m.post.enabled).toBe(false);
    const edited = migrateProject(raw(EEVEE_V15 + '\n// mine'))!;
    expect(edited.post.code).toBe(EEVEE_V15 + '\n// mine');
    expect(edited.post.params.reflections).toBeUndefined();
  });

  it('a still (docs/32) is the film-back aspect of the camera, the viewport aspect while orthographic, 256..8192 px wide', () => {
    const cam = { ...defaultCamera(), filmBack: { width: 36, height: 24 } };
    expect(stillSize(cam, 1.0)).toEqual({ width: 3840, height: 2560 });
    expect(stillSize(cam, 1.0, 1920)).toEqual({ width: 1920, height: 1280 });
    expect(stillSize(null, 16 / 9, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(stillSize(cam, 1.0, 20000).width).toBe(8192);
    expect(stillSize(cam, 1.0, 10).width).toBe(256);
    expect(stillSize(cam, 1.0, NaN).width).toBe(3840);
  });
});
