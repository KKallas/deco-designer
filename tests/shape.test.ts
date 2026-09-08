/** Shapes: a surface over curves with fill layers (docs/30-outline-and-shape-layers.md §4; was the panel of docs/28). */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_FILLS, DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, migrateProject, type Shape } from '../src/model/types';
import { PRESET_FILLS } from '../src/model/fills';
import { buildFillGeometry, shapeCurves, surfaceInput } from '../src/geometry/surface';
import { ALL_LEVELS, resolvePick } from '../src/model/pick';

function drawn(store: Store, plane: string, pts: [number, number][], closed = true): string {
  const id = cmd.addCurve(store, plane);
  for (const [x, y] of pts) cmd.addVertex(store, id, { x, y });
  if (closed) cmd.toggleClosed(store, id);
  cmd.exitEdit(store);
  return id;
}

/** A 1000 × 1000 square centred on the origin of the front plane, filled with the sheet. */
function fixture(closed = true) {
  const store = new Store(emptyProject('t', DEFAULT_PROFILES, DEFAULT_FILLS));
  const plane = cmd.addPlane(store, 'front');
  const curve = drawn(store, plane, [[-500, -500], [500, -500], [500, 500], [-500, 500]], closed);
  const shape = cmd.addShape(store, curve)!;
  return { store, plane, curve, shape };
}

function surface(store: Store, id?: string) {
  const sh = (id ? store.project.shapes.find((x) => x.id === id) : store.project.shapes[0]) as Shape;
  return surfaceInput(sh, shapeCurves(sh, store.project.curves));
}

function box(g: THREE.BufferGeometry) {
  return new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
}

/** Total area of the built triangles, mm². */
function area(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position'), idx = g.getIndex()!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i)); b.fromBufferAttribute(pos, idx.getX(i + 1)); c.fromBufferAttribute(pos, idx.getX(i + 2));
    sum += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  return sum;
}

describe('shapes (docs/30 §4)', () => {
  it('a shape over a closed curve starts with one Sheet layer and fills it exactly', () => {
    const { store, shape } = fixture();
    expect(shape).toBe('shape-1');
    expect(store.project.shapes[0]).toMatchObject({ id: 'shape-1', name: 'Shape 1', curves: ['curve-1'], expand: 0, resolution: 2 });
    expect(store.project.shapes[0].layers).toEqual([{ id: 'sheet', fillId: 'sheet', params: {}, materialId: null, color: null, offset: 0, visible: true }]);
    expect(store.selection.shapeId).toBe('shape-1');
    const s = surface(store)!;
    expect(s.area).toBeCloseTo(1e6, 3);
    const b = box(s.sheet);
    expect([b.min.x, b.max.x, b.min.y, b.max.y]).toEqual([-500, 500, -500, 500]);
    expect(area(s.sheet)).toBeCloseTo(1e6, 3);
    expect(s.inside(0, 0)).toBe(true);
    expect(s.inside(600, 0)).toBe(false);
    expect(s.heightAt(100, 100)).toBe(0);
  });

  it('an open curve is closed by the chord back to its first vertex and filled all the same', () => {
    const { store } = fixture(false);
    expect(area(surface(store)!.sheet)).toBeCloseTo(1e6, 3);
  });

  it('a second curve inside the first is a hole; expand grows every loop', () => {
    const { store, plane, shape } = fixture();
    const hole = drawn(store, plane, [[-200, -200], [200, -200], [200, 200], [-200, 200]]);
    cmd.updateShape(store, shape, { curves: ['curve-1', hole] });
    const s = surface(store)!;
    expect(s.loops).toHaveLength(2);
    expect(s.area).toBeCloseTo(1e6 - 160000, 3);
    expect(s.inside(0, 0)).toBe(false);
    expect(s.inside(400, 400)).toBe(true);
    // the strand across the middle is cut into two pieces around the hole
    const pieces = s.clip(new THREE.Vector2(-600, 0), new THREE.Vector2(600, 0));
    expect(pieces.map(([a, b]) => [a.x, b.x])).toEqual([[-500, -200], [200, 500]]);
    cmd.updateShape(store, shape, { expand: 10 });
    const grown = surface(store)!;
    expect(grown.area).toBeCloseTo(1020 * 1020 - 420 * 420, 3);
  });

  it('every fill preset builds over a sheet and over a frame with a hole, with uv', () => {
    const { store, plane, shape } = fixture();
    const hole = drawn(store, plane, [[-200, -200], [200, -200], [200, 200], [-200, 200]]);
    for (const curves of [['curve-1'], ['curve-1', hole]]) {
      cmd.updateShape(store, shape, { curves });
      const s = surface(store)!;
      for (const f of PRESET_FILLS) {
        const { geometry, info } = buildFillGeometry(f.code, s, f.params);
        expect(info.vertices, f.id).toBeGreaterThan(0);
        expect(info.hasUv, f.id).toBe(true);
        expect(geometry.getAttribute('normal'), f.id).toBeTruthy();
        // everything a fill makes lies over the surface (the net and the bubbles sit on it, never outside its box)
        const b = box(geometry);
        expect(b.min.x, f.id).toBeGreaterThanOrEqual(-500 - 50);
        expect(b.max.x, f.id).toBeLessThanOrEqual(500 + 50);
      }
    }
  });

  it('bubbles: count in several sizes, a clean margin from every edge and from each other, seeded, red metal by default', () => {
    const { store, plane, shape } = fixture();
    const hole = drawn(store, plane, [[-200, -200], [200, -200], [200, 200], [-200, 200]]);
    cmd.updateShape(store, shape, { curves: ['curve-1', hole] });
    const s = surface(store)!;
    expect(s.distanceToEdge(0, 0)).toBe(200);
    expect(s.distanceToEdge(450, 0)).toBe(50);
    const bubbles = PRESET_FILLS.find((f) => f.id === 'bubbles')!;
    expect(bubbles).toMatchObject({ params: { count: 30, size: 60, sizes: 3, margin: 10, seed: 1 }, color: '#b3121e', metalness: 1, roughness: 0.12 });
    const params = { count: 24, size: 80, sizes: 3, margin: 15, seed: 1 };
    const a = buildFillGeometry(bubbles.code, s, params).geometry.getAttribute('position');
    const b = buildFillGeometry(bubbles.code, s, params).geometry.getAttribute('position');
    expect(Array.from(a.array as Float32Array).slice(0, 30)).toEqual(Array.from(b.array as Float32Array).slice(0, 30));
    const c = buildFillGeometry(bubbles.code, s, { ...params, seed: 7 }).geometry.getAttribute('position');
    expect(Array.from(c.array as Float32Array).slice(0, 30)).not.toEqual(Array.from(a.array as Float32Array).slice(0, 30));
    // every sphere: its centre is the mean of its 25 × 17 vertices, its radius the spread in z; three sizes 40 / 33.3 / 26.7
    const PER = 25 * 17, n = a.count / PER;
    expect(n).toBe(24);
    const spheres: { x: number; y: number; r: number }[] = [];
    for (let k = 0; k < n; k++) {
      let cx = 0, cy = 0, zmin = Infinity, zmax = -Infinity;
      for (let i = 0; i < PER; i++) { cx += a.getX(k * PER + i); cy += a.getY(k * PER + i); zmin = Math.min(zmin, a.getZ(k * PER + i)); zmax = Math.max(zmax, a.getZ(k * PER + i)); }
      spheres.push({ x: cx / PER, y: cy / PER, r: (zmax - zmin) / 2 });
      expect(zmin).toBeCloseTo(0, 3);                                   // resting on the sheet
    }
    const radii = [...new Set(spheres.map((q) => Math.round(q.r * 10) / 10))].sort((p, q) => q - p);
    expect(radii).toEqual([40, 33.3, 26.7]);
    expect(spheres.filter((q) => q.r > 39)).toHaveLength(8);
    for (const q of spheres) {
      expect(s.inside(q.x, q.y)).toBe(true);
      expect(s.distanceToEdge(q.x, q.y)).toBeGreaterThanOrEqual(q.r + 15 - 1e-6);
      for (const o of spheres) if (o !== q) expect(Math.hypot(o.x - q.x, o.y - q.y)).toBeGreaterThanOrEqual(o.r + q.r + 15 - 1e-6);
    }
  });

  it('layers: add, update (params merge), reorder, remove; the fill dropdown only takes fills that exist', () => {
    const { store, shape } = fixture();
    const net = cmd.addShapeLayer(store, shape, { fillId: 'pvc-net', params: { pitch: 40 }, offset: 5 })!;
    expect(net).toBe('pvc-net');
    expect(store.project.shapes[0].layers.map((l) => l.id)).toEqual(['sheet', 'pvc-net']);
    cmd.updateShapeLayer(store, shape, net, { params: { wire: 3 }, visible: false, fillId: 'nope' });
    expect(store.project.shapes[0].layers[1]).toMatchObject({ fillId: 'pvc-net', params: { pitch: 40, wire: 3 }, visible: false, offset: 5 });
    cmd.updateShapeLayer(store, shape, net, { params: { pitch: null }, color: '#123456' });
    expect(store.project.shapes[0].layers[1]).toMatchObject({ params: { wire: 3 }, color: '#123456' });
    cmd.moveShapeLayer(store, shape, net, 0);
    expect(store.project.shapes[0].layers.map((l) => l.id)).toEqual(['pvc-net', 'sheet']);
    cmd.removeShapeLayer(store, shape, 'sheet');
    expect(store.project.shapes[0].layers.map((l) => l.id)).toEqual(['pvc-net']);
    expect(overview(store)).toContain('▱ Shape 1 [shape-1] · curve-1 · res 2 · layers: pvc-net offset 5 colour #123456 params {"wire":3} hidden');
  });

  it('fills: removing one moves its layers to the first remaining fill; the last stays', () => {
    const { store, shape } = fixture();
    cmd.addShapeLayer(store, shape, { fillId: 'bubbles' });
    expect(cmd.removeFill(store, 'bubbles')).toBe(true);
    expect(store.project.shapes[0].layers.map((l) => l.fillId)).toEqual(['sheet', 'sheet']);
    cmd.removeFill(store, 'pvc-net');
    expect(cmd.removeFill(store, 'sheet')).toBe(false);
    const id = cmd.addFill(store, { label: 'Dots', code: '(three, surface, params) => surface.sheet.clone()', params: { n: 1 }, color: '#fff' });
    expect(id).toBe('dots');
    expect(overview(store)).toContain('Fills: sheet "Sheet" no params · dots "Dots" n=1');
    expect(store.project.fills[1]).toMatchObject({ metalness: 0, roughness: 0.5 });
  });

  it('follows its curves: deleting one takes it out, the last one deletes the shape; the plane is the first curve\'s', () => {
    const { store, plane, shape } = fixture();
    const other = cmd.addPlane(store, 'top');
    const far = drawn(store, other, [[0, 0], [100, 0], [100, 100]]);
    const hole = drawn(store, plane, [[-100, -100], [100, -100], [100, 100], [-100, 100]]);
    cmd.updateShape(store, shape, { curves: ['curve-1', far, hole] });
    expect(shapeCurves(store.project.shapes[0], store.project.curves).map((c) => c.id)).toEqual(['curve-1', hole]);
    cmd.removeCurves(store, [hole]);
    expect(store.project.shapes[0].curves).toEqual(['curve-1', far]);
    cmd.removeCurves(store, ['curve-1', far]);
    expect(store.project.shapes).toHaveLength(0);
    expect(store.selection.shapeId).toBeNull();
  });

  it('is picked at the surface level, and selected in the viewport like a loft', () => {
    const { store } = fixture();
    expect(resolvePick(store.project, ALL_LEVELS, { curveId: null, loftId: null, shapeId: 'shape-1' })).toEqual({ kind: 'shape', id: 'shape-1' });
    expect(resolvePick(store.project, { ...ALL_LEVELS, loft: false }, { curveId: null, loftId: null, shapeId: 'shape-1' })).toBeNull();
    cmd.selectShape(store, null);
    expect(store.selection.shapeId).toBeNull();
    cmd.selectShape(store, 'shape-1');
    cmd.deleteSelection(store);
    expect(store.project.shapes).toHaveLength(0);
  });

  it('migrates a version 15 panel into a shape with one Sheet layer carrying its material and offset', () => {
    const { store } = fixture();
    const raw = JSON.parse(JSON.stringify(store.project)) as Record<string, unknown>;
    raw.version = 15;
    delete raw.shapes; delete raw.fills;
    raw.panels = [{ id: 'panel-1', name: 'Panel 1', curve: 'curve-1', materialId: null, offset: -12, expand: 3, resolution: 4 }];
    for (const c of raw.curves as Record<string, unknown>[]) { c.profileId = 'round15'; c.params = { wall: 2 }; c.materialId = null; c.pixels = null; delete c.outline; }
    const m = migrateProject(raw)!;
    expect(m.version).toBe(18);
    expect(m.fills.map((f) => f.id)).toEqual(['sheet']);
    expect(m.shapes).toEqual([{ id: 'panel-1', name: 'Panel 1', curves: ['curve-1'], expand: 3, resolution: 4, layers: [{ id: 'sheet', fillId: 'sheet', params: {}, materialId: null, color: null, offset: -12, visible: true }] }]);
    expect(m.curves[0].outline).toEqual([{ id: 'base', profileId: 'round15', params: { wall: 2 }, materialId: null, color: null, offset: 0, lift: 0, pixels: null, visible: true }]);
    expect((m.curves[0] as unknown as Record<string, unknown>).profileId).toBeUndefined();
    // a current file round-trips
    expect(migrateProject(JSON.parse(JSON.stringify(store.project)))).toEqual(store.project);
  });
});
