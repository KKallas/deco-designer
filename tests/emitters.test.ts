/** Pixel fixtures, animation maps and the emitter transfer bake (docs/17-emitters.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { PIXELS_PER_CHAIN, emptyProject, migrateProject, pixelCount, playbackRange } from '../src/model/types';
import { defaultEmitters, normalizePixels } from '../src/model/world';
import { frameAt } from '../src/view3d/pixels';

const project = () => emptyProject('t', DEFAULT_PROFILES);

describe('fixtures', () => {
  it('a fixture is 1–3 daisy-chained chains of 80 pixels', () => {
    expect(PIXELS_PER_CHAIN).toBe(80);
    expect(pixelCount(null)).toBe(0);
    expect(pixelCount(normalizePixels({ chains: 1 }))).toBe(80);
    expect(pixelCount(normalizePixels({ chains: 3 }))).toBe(240);
    expect(pixelCount(normalizePixels({ chains: 9 }))).toBe(240);     // clamped
    expect(normalizePixels({ offset: -5, chains: 0 })).toMatchObject({ chains: 1, offset: 0, animation: null, reverse: false });
  });

  it('patches curves to an animation and chains their columns', () => {
    const store = new Store(project());
    const plane = cmd.addPlane(store, 'front');
    const ids = [0, 1, 2].map(() => { const id = cmd.addCurve(store, plane); cmd.addVertex(store, id, { x: 0, y: 0 }); cmd.addVertex(store, id, { x: 2000, y: 0 }); cmd.exitEdit(store); return id; });
    const tex = cmd.addTexture(store, { name: 'map', mime: 'image/png', data: 'data:image/png;base64,x', width: 240, height: 600, source: 'map.png' });
    const anim = cmd.addAnimation(store, { name: 'Chase', texture: tex, fps: 30, frames: 600, width: 240 });
    cmd.setCurvePixels(store, ids, { chains: 1 });
    expect(store.project.curves.map((c) => pixelCount(c.outline[0].pixels))).toEqual([80, 80, 80]);
    cmd.chainCurvePixels(store, ids, anim);
    expect(store.project.curves.map((c) => c.outline[0].pixels?.offset)).toEqual([0, 80, 160]);
    expect(store.project.curves.every((c) => c.outline[0].pixels?.animation === anim)).toBe(true);
    cmd.setCurvePixels(store, [ids[1]], { chains: 3 });
    cmd.chainCurvePixels(store, ids, anim);
    expect(store.project.curves.map((c) => c.outline[0].pixels?.offset)).toEqual([0, 80, 320]);
    cmd.setCurvePixels(store, ids, null);
    expect(store.project.curves.every((c) => c.outline[0].pixels === null)).toBe(true);
  });

  it('removing an animation un-patches the fixtures playing it', () => {
    const store = new Store(project());
    const plane = cmd.addPlane(store, 'front');
    const id = cmd.addCurve(store, plane); cmd.addVertex(store, id, { x: 0, y: 0 }); cmd.addVertex(store, id, { x: 1000, y: 0 }); cmd.exitEdit(store);
    const tex = cmd.addTexture(store, { name: 'map', mime: 'image/png', data: 'd', width: 80, height: 10, source: '' });
    const anim = cmd.addAnimation(store, { name: 'A', texture: tex, fps: 24, frames: 10, width: 80 });
    cmd.setCurvePixels(store, [id], { chains: 1, animation: anim });
    cmd.setPlayback(store, { playing: true });
    // the clock follows the longest map patched while out is auto: 10 frames at 24 fps
    expect(playbackRange(store.project)).toEqual({ start: 0, end: 10 / 24 });
    cmd.removeAnimation(store, anim);
    expect(store.project.curves[0].outline[0].pixels).toMatchObject({ chains: 1, animation: null });
    expect(store.project.playback.playing).toBe(true);
  });

  it('the clock has a range and each map wraps inside its own length', () => {
    const store = new Store(project());
    const tex = cmd.addTexture(store, { name: 'map', mime: 'image/png', data: 'd', width: 80, height: 60, source: '' });
    const anim = cmd.addAnimation(store, { name: 'A', texture: tex, fps: 30, frames: 60, width: 80 });
    const a = store.project.animations.find((x) => x.id === anim)!;
    // 2 s of map: it repeats, and the clock's loop flag no longer reaches it
    expect(frameAt(a, 0)).toBe(0);
    expect(frameAt(a, 1)).toBe(30);
    expect(frameAt(a, 2)).toBe(0);
    expect(frameAt(a, 2.5)).toBe(15);
    // in / out are the transport's, in seconds; out empty follows the longest map
    cmd.setPlayback(store, { start: 1, end: 5, loop: false });
    expect(playbackRange(store.project)).toEqual({ start: 1, end: 5 });
    cmd.setPlayback(store, { end: null });
    expect(playbackRange(store.project)).toEqual({ start: 1, end: 2 });
    // out is never before in
    cmd.setPlayback(store, { end: 0.5 });
    expect(playbackRange(store.project).end).toBeGreaterThan(1);
  });

  it('an unknown animation id is never stored', () => {
    const store = new Store(project());
    const plane = cmd.addPlane(store, 'front');
    const id = cmd.addCurve(store, plane); cmd.addVertex(store, id, { x: 0, y: 0 }); cmd.addVertex(store, id, { x: 500, y: 0 }); cmd.exitEdit(store);
    cmd.setCurvePixels(store, [id], { animation: 'nope' });
    expect(store.project.curves[0].outline[0].pixels?.animation).toBeNull();
  });

  it('migrates a version 8 project: no animations, no fixtures, emitters off', () => {
    const p = project() as unknown as Record<string, unknown>;
    p.version = 8; delete p.animations; delete p.playback;
    p.world = { background: { kind: 'color', color: '#ffffff' } };   // a version 8 world: no emitters yet; lands on the cameras (docs/36)
    p.cameras = []; p.activeCamera = null;
    const m = migrateProject(JSON.parse(JSON.stringify(p)))!;
    expect(m.version).toBe(18);
    expect(m.animations).toEqual([]);
    expect(m.playback).toEqual({ playing: false, loop: true, start: 0, end: null });
    expect(m.cameras[0].world.background).toEqual({ kind: 'color', color: '#ffffff' });
    expect(m.cameras[0].world.emitters).toEqual(defaultEmitters());
    expect(defaultEmitters().enabled).toBe(false);
  });

  it('shows fixtures and animations in the overview', () => {
    const store = new Store(project());
    const plane = cmd.addPlane(store, 'front');
    const id = cmd.addCurve(store, plane); cmd.addVertex(store, id, { x: 0, y: 0 }); cmd.addVertex(store, id, { x: 2000, y: 0 }); cmd.exitEdit(store);
    const tex = cmd.addTexture(store, { name: 'map', mime: 'image/png', data: 'd', width: 160, height: 300, source: '' });
    const anim = cmd.addAnimation(store, { name: 'Chase', texture: tex, fps: 30, frames: 300, width: 160 });
    cmd.setCurvePixels(store, [id], { chains: 2, animation: anim, offset: 0 });
    cmd.setPlayback(store, { playing: true });
    const text = overview(store);
    expect(text).toContain('✦ 160 px chase@0');
    expect(text).toContain('Animations: chase "Chase" 160×300 @ 30 fps · 1 patched');
    expect(text).toContain('Clock: playing · in 0.00 s · out 10.00 s (auto) · loop');
  });
});
