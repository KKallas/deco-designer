/** The outline: a curve's stack of profile layers (docs/30-outline-and-shape-layers.md §3). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { describeCurve, overview } from '../src/app/overview';
import { DEFAULT_FILLS, DEFAULT_PROFILES } from '../src/model/defaults';
import { PRESET_PROFILES } from '../src/model/profiles';
import { emptyProject, outlineKey, pixelCount } from '../src/model/types';
import { layerCurve } from '../src/geometry/outline';
import { sampleCurve } from '../src/geometry/curve';

function fixture(pts: [number, number][], closed: boolean) {
  const store = new Store(emptyProject('o', DEFAULT_PROFILES, DEFAULT_FILLS));
  const plane = cmd.addPlane(store, 'front');
  const id = cmd.addCurve(store, plane);
  for (const [x, y] of pts) cmd.addVertex(store, id, { x, y });
  if (closed) cmd.toggleClosed(store, id);
  cmd.exitEdit(store);
  return { store, plane, id };
}

describe('outline layers', () => {
  it('a new curve has one layer on the line, bent from the first profile; the old one-profile commands act on it', () => {
    const { store, id } = fixture([[0, 0], [1000, 0]], false);
    const c = store.project.curves[0];
    expect(c.outline).toEqual([{ id: 'base', profileId: 'flat25x2', params: {}, materialId: null, color: null, offset: 0, lift: 0, pixels: null, visible: true }]);
    cmd.updateOutlineLayer(store, id, 'base', { color: '#FF0000' });
    expect(c.outline[0].color).toBe('#ff0000');
    cmd.updateOutlineLayer(store, id, 'base', { color: 'red' });   // not a hex colour: back to the profile's
    expect(c.outline[0].color).toBeNull();
    cmd.setCurveProfile(store, id, 'round15');
    cmd.setCurveParams(store, [id], { wall: 3 });
    expect(c.outline[0]).toMatchObject({ profileId: 'round15', params: { wall: 3 } });
    expect(store.evals.get(id)!.layers).toHaveLength(1);
    expect(store.evals.get(id)!.layers[0].curve).toBe(c.curve);   // on the line: the drawn curve itself
  });

  it('a layer with an offset is built on its own parallel curve — outside on a closed curve, left on an open one', () => {
    const { store, id } = fixture([[-500, -500], [500, -500], [500, 500], [-500, 500]], true);
    const led = cmd.addProfile(store, PRESET_PROFILES.find((p) => p.id === 'led-strip')!);
    const outer = cmd.addOutlineLayer(store, id, { profileId: led, offset: 20, lift: 5 })!;
    const inner = cmd.addOutlineLayer(store, id, { profileId: led, offset: -20 })!;
    expect([outer, inner]).toEqual(['led-strip', 'led-strip-2']);
    const ev = store.evals.get(id)!;
    expect(ev.layers.map((l) => Math.round(l.sampling.length))).toEqual([4000, 4160, 3840]);
    const lifted = ev.layers[1].curve.points;
    expect(lifted.every((v) => v.z === 5)).toBe(true);
    expect(Math.max(...lifted.map((v) => v.x))).toBeCloseTo(520, 6);
    expect(Math.max(...ev.layers[2].curve.points.map((v) => v.x))).toBeCloseTo(480, 6);
    // an open curve: + is the left of travel
    const open = fixture([[0, 0], [1000, 0]], false);
    cmd.addOutlineLayer(open.store, open.id, { offset: 30 });
    expect(open.store.evals.get(open.id)!.layers[1].curve.points.every((v) => v.y === 30)).toBe(true);
    expect(layerCurve(open.store.project.curves[0].curve, { offset: 0, lift: 0 })).toBe(open.store.project.curves[0].curve);
  });

  it('checks run per layer on the layer\'s own curve, and every violation names its layer', () => {
    const { store, id } = fixture([[0, 0], [500, 0], [500, 500]], false);
    cmd.filletVertex(store, id, store.project.curves[0].curve.points[1].id, 60);   // legal for the 25 × 2 flat bar (R ≥ 15)
    expect(store.evals.get(id)!.violations).toEqual([]);
    // a tube on the inside of the bend (the curve turns left, so + is the inside): R 60 − 45 = 15 < its 45 mm limit
    const lid = cmd.addOutlineLayer(store, id, { profileId: 'round15', offset: 45 })!;
    const ev = store.evals.get(id)!;
    expect(ev.layers[0].violations).toEqual([]);
    expect(ev.layers[1].violations.map((v) => [v.check, v.layer])).toEqual([['minBendRadius', lid]]);
    expect(ev.violations).toHaveLength(1);
    expect(describeCurve(store, id)).toContain(`(layer ${lid})`);
    cmd.updateOutlineLayer(store, id, lid, { visible: false });
    expect(store.evals.get(id)!.violations).toHaveLength(1);   // hidden is still checked
  });

  it('fixtures are per layer: chains, maps and columns on layer i of each curve', () => {
    const { store, plane, id } = fixture([[0, 0], [2000, 0]], false);
    const led = cmd.addProfile(store, PRESET_PROFILES.find((p) => p.id === 'led-strip')!);
    const b = cmd.addCurve(store, plane); cmd.addVertex(store, b, { x: 0, y: 100 }); cmd.addVertex(store, b, { x: 2000, y: 100 }); cmd.exitEdit(store);
    cmd.addOutlineLayer(store, [id, b], { profileId: led, offset: 14 });
    cmd.addOutlineLayer(store, [id, b], { profileId: led, offset: -14 });
    const tex = cmd.addTexture(store, { name: 'map', mime: 'image/png', data: 'd', width: 480, height: 10, source: '' });
    const anim = cmd.addAnimation(store, { name: 'A', texture: tex, fps: 24, frames: 10, width: 480 });
    cmd.setCurvePixels(store, [id, b], { chains: 1 }, 1);
    cmd.setCurvePixels(store, [id, b], { chains: 2 }, 2);
    cmd.chainCurvePixels(store, [id, b], anim, 1);
    cmd.chainCurvePixels(store, [id, b], anim, 2);
    const curves = store.project.curves;
    expect(curves.map((c) => c.outline.map((l) => pixelCount(l.pixels)))).toEqual([[0, 80, 160], [0, 80, 160]]);
    expect(curves.map((c) => c.outline.map((l) => l.pixels?.offset ?? null))).toEqual([[null, 0, 0], [null, 80, 160]]);
    cmd.removeAnimation(store, anim);
    expect(curves.every((c) => c.outline.slice(1).every((l) => l.pixels?.animation === null))).toBe(true);
    expect(overview(store)).toContain('✦ 80 px unpatched');
  });

  it('layers reorder, update, remove; materials and profiles that vanish are cleaned up; an empty outline is a construction line', () => {
    const { store, id } = fixture([[0, 0], [1000, 0]], false);
    const lid = cmd.addOutlineLayer(store, id, { profileId: 'round15', offset: 10 })!;
    cmd.moveOutlineLayer(store, id, lid, 0);
    expect(store.project.curves[0].outline.map((l) => l.id)).toEqual([lid, 'base']);
    cmd.updateOutlineLayers(store, [id], 0, { lift: 7, params: { wall: 0 }, profileId: 'ghost' });
    expect(store.project.curves[0].outline[0]).toMatchObject({ profileId: 'round15', lift: 7, params: { wall: 0 } });
    const mid = cmd.addMaterial(store, { name: 'M', code: '(tsl) => new tsl.MeshPhysicalNodeMaterial()', source: '', warnings: [] });
    cmd.setCurveMaterial(store, [id], mid, 1);
    cmd.removeMaterial(store, mid);
    expect(store.project.curves[0].outline[1].materialId).toBeNull();
    cmd.removeProfile(store, 'round15');
    expect(store.project.curves[0].outline[0].profileId).toBe('flat25x2');
    cmd.removeOutlineLayer(store, id, lid);
    cmd.removeOutlineLayer(store, id, 'base');
    expect(store.project.curves[0].outline).toEqual([]);
    expect(store.evals.get(id)!.layers).toEqual([]);
    expect(overview(store)).toContain('no outline (construction line)');
    // a profile on a bare line makes the base layer again
    cmd.setCurveProfile(store, id, 'flat25x2');
    expect(store.project.curves[0].outline.map((l) => l.id)).toEqual(['base']);
  });

  it('the outline survives duplicating, breaking and offsetting; the array welds by outline', () => {
    const { store, id } = fixture([[0, 0], [500, 0], [1000, 0]], false);
    cmd.addOutlineLayer(store, id, { profileId: 'round15', offset: 12 });
    const [copy] = cmd.duplicateCurves(store, [id]);
    expect(outlineKey(store.project.curves.find((c) => c.id === copy)!)).toBe(outlineKey(store.project.curves[0]));
    const off = cmd.offsetCurve(store, id, 30)!;
    expect(store.project.curves.find((c) => c.id === off)!.outline).toHaveLength(2);
    const sampling = sampleCurve(store.project.curves[0].curve);
    expect(layerCurve(store.project.curves[0].curve, { offset: 12, lift: 0 }, sampling).points).toHaveLength(3);
  });
});
