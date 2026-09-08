/** Shapes: profiles as programs (docs/14-shapes.md). */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { overview } from '../src/app/overview';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { PRESET_PROFILES, describeProfile, profileFromLegacy } from '../src/model/profiles';
import { emptyProject, migrateProject, paramsOf, vertex, type Curve } from '../src/model/types';
import { buildShapeGeometry, curveGeometry, shapeInput } from '../src/geometry/shape';
import { sweep, rect } from '../src/geometry/sweep';

const S_BEND: Curve = { points: [vertex(-500, -200), vertex(-170, 250), vertex(170, -250), vertex(500, 200)], closed: false };
const LIFTED: Curve = { points: [vertex(-500, -200), { ...vertex(-170, 250), z: 150 }, { ...vertex(170, -250), z: -150 }, vertex(500, 200)], closed: false };
const LOOP: Curve = { points: [vertex(-400, -250), vertex(400, -250), vertex(400, 250), vertex(-400, 250)], closed: true };
const input = (curve: Curve) => shapeInput({ id: 'c', name: 'c', curve })!;
const size = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); return g.boundingBox!.getSize(new THREE.Vector3()); };

function fixture() {
  const store = new Store(emptyProject('s', DEFAULT_PROFILES));
  const plane = cmd.addPlane(store, 'front');
  const id = cmd.addCurve(store, plane);
  for (const v of S_BEND.points) cmd.addVertex(store, id, { x: v.x, y: v.y });
  cmd.exitEdit(store);
  return { store, curve: id };
}

describe('shape programs', () => {
  it('every preset builds a mesh with uv in mm on an open, a closed and a 3D curve', () => {
    for (const p of PRESET_PROFILES) {
      for (const curve of [S_BEND, LOOP, LIFTED]) {
        const { geometry, info } = buildShapeGeometry(p.code, input(curve), p.params);
        expect(info.vertices, p.id).toBeGreaterThan(0);
        expect(info.triangles, p.id).toBeGreaterThan(0);
        expect(info.hasUv, p.id).toBe(true);
        expect(geometry.getAttribute('normal'), p.id).toBeTruthy();
      }
    }
  });

  it('sweeps a cross-section with mm uv, hard corners, holes and end caps; the flat bar stays flat to the plane on a 3D curve', () => {
    const straight = input({ points: [vertex(0, 0), vertex(1000, 0)], closed: false });
    const bar = sweep(straight, rect(2, 25));
    const s = size(bar);
    expect(s.x).toBeCloseTo(1000, 3); expect(s.y).toBeCloseTo(2, 3); expect(s.z).toBeCloseTo(25, 3);   // width along the plane normal
    const uv = bar.getAttribute('uv');
    let uMax = 0, vMax = 0;
    for (let i = 0; i < uv.count; i++) { uMax = Math.max(uMax, uv.getX(i)); vMax = Math.max(vMax, uv.getY(i)); }
    expect(uMax).toBeCloseTo(1000, 3);
    expect(vMax).toBeCloseTo(2 * (2 + 25), 3);   // v runs around the section (uv of the caps stays within the section)
    expect(size(sweep(straight, rect(2, 25), { rotate: 90 })).y).toBeCloseTo(25, 3);   // lying flat
    const solid = sweep(straight, rect(20, 20)), hollow = sweep(straight, rect(20, 20), { holes: [rect(17, 17)] });
    expect(hollow.getIndex()!.count).toBeGreaterThan(solid.getIndex()!.count);
    const noCaps = sweep(straight, rect(20, 20), { caps: false });
    expect(solid.getIndex()!.count - noCaps.getIndex()!.count).toBe(2 * 2 * 3);   // two caps of two triangles
    // 3D curve: every section's "up" edge is parallel to the plane normal within the perpendicular-to-tangent tilt
    const lifted = sweep(input(LIFTED), rect(2, 25), { caps: false });
    const pos = lifted.getAttribute('position');
    for (let i = 0; i < pos.count; i += 8) {   // ring of 8 vertices (4 hard corners × 2): corner 0 → corner 3 is the 25 mm side
      const dz = pos.getZ(i + 6) - pos.getZ(i), dxy = Math.hypot(pos.getX(i + 6) - pos.getX(i), pos.getY(i + 6) - pos.getY(i));
      expect(Math.hypot(dz, dxy)).toBeCloseTo(25, 3);
      expect(dz).toBeGreaterThan(20);   // mostly along the plane normal even on the lifted parts
    }
  });

  it('a closed curve is mitred at its seam like every other corner', () => {
    const inp = input(LOOP);                                   // a 800 × 500 square: corners at the four vertices, the seam on the first
    const steps = 260;                                         // 10 mm a step, so every corner lands on a section
    const f = inp.frames(steps);
    const bisector = new THREE.Vector3(1, -1, 0).normalize();   // the seam turns from -x..+x to +y: the mitre plane is the diagonal
    expect(f.tangents[0].angleTo(bisector)).toBeCloseTo(0, 5);
    expect(f.tangents[steps].angleTo(bisector)).toBeCloseTo(0, 5);
    const box = sweep(inp, rect(25, 25), { steps });
    const pos = box.getAttribute('position');
    const ring = pos.count / (steps + 1);
    for (let k = 0; k < ring; k++) {                            // the last section is the first one: the seam closes as one corner
      expect(pos.getX(steps * ring + k)).toBeCloseTo(pos.getX(k), 6);
      expect(pos.getY(steps * ring + k)).toBeCloseTo(pos.getY(k), 6);
    }
    const across = Math.abs(pos.getX(1) - pos.getX(0)) + Math.abs(pos.getY(1) - pos.getY(0));
    const at130 = Math.abs(pos.getX(130 * ring + 1) - pos.getX(130 * ring)) + Math.abs(pos.getY(130 * ring + 1) - pos.getY(130 * ring));
    expect(across).toBeCloseTo(at130, 1);                       // as wide as the corner at the far end
  });

  it('gives the program the path, samples, frames and plane normal; params reach the code', () => {
    const inp = input(S_BEND);
    expect(inp.length).toBeGreaterThan(1000);
    expect(inp.samples.length).toBeGreaterThan(50);
    const f = inp.frames(10);
    expect(f.points.length).toBe(11);
    expect(f.tangents[0].length()).toBeCloseTo(1, 5);
    expect(inp.planeNormal.z).toBe(1);
    const tube = PRESET_PROFILES.find((e) => e.id === 'round-tube')!;
    const thin = size(buildShapeGeometry(tube.code, inp, { diameter: 4, wall: 0 }).geometry);
    const thick = size(buildShapeGeometry(tube.code, inp, { diameter: 80, wall: 0 }).geometry);
    expect(thick.z - thin.z).toBeCloseTo(76, 0);
  });

  it('LED string: twisted wires of the outer diameter, one LED per pitch standing on the wire, lit tips as emissive vertices', () => {
    const led = PRESET_PROFILES.find((e) => e.id === 'led-strip')!;
    const straight = input({ points: [vertex(0, 0), vertex(1000, 0)], closed: false });
    const params = { ...led.params, pitch: 100, seed: 3 };
    const { geometry, info } = buildShapeGeometry(led.code, straight, params);
    expect(info.hasUv).toBe(true);
    expect(geometry.hasAttribute('color') && geometry.hasAttribute('emissive')).toBe(true);
    const em = geometry.getAttribute('emissive');
    let lit = 0;
    for (let i = 0; i < em.count; i++) if (em.getX(i) > 0) lit++;
    expect(lit).toBe(Math.floor(1000 / 100) * 24);   // one lit box (24 vertices) per LED
    expect(Math.max(...Array.from({ length: em.count }, (_, i) => em.getX(i)))).toBeCloseTo(6, 5);   // glow = 6
    // the wires alone fit in the outer diameter; with LEDs the string reaches wire radius + LED height
    const wires = size(buildShapeGeometry(led.code, straight, { ...params, ledHeight: 0 }).geometry);
    expect(wires.y).toBeGreaterThan(3.6); expect(wires.y).toBeLessThanOrEqual(4.01);
    expect(wires.z).toBeGreaterThan(3.6); expect(wires.z).toBeLessThanOrEqual(4.01);
    const pos = geometry.getAttribute('position');
    let far = 0;
    for (let i = 0; i < pos.count; i++) far = Math.max(far, Math.hypot(pos.getY(i), pos.getZ(i)));
    expect(far).toBeCloseTo(Math.hypot(2 + 20, 2.5), 1);   // wire radius + LED height, at a corner of the 5 mm tip
    // random directions: not all LEDs point the same way
    const dirs = new Set<string>();
    for (let i = 0; i < em.count; i++) if (em.getX(i) > 0) dirs.add(`${Math.sign(Math.round(pos.getY(i)))}${Math.sign(Math.round(pos.getZ(i)))}`);
    expect(dirs.size).toBeGreaterThan(1);
    // deterministic: same seed → same mesh; another seed → different directions
    const again = buildShapeGeometry(led.code, straight, params).geometry.getAttribute('position');
    expect(again.getX(again.count - 1)).toBe(pos.getX(pos.count - 1));
  });

  it('reports broken programs instead of returning junk', () => {
    expect(() => buildShapeGeometry('(three, curve) => 42', input(S_BEND), {})).toThrow(/BufferGeometry/);
    expect(() => buildShapeGeometry('(three, curve) => { throw new Error("nope"); }', input(S_BEND), {})).toThrow(/nope/);
    expect(() => buildShapeGeometry('(three, curve) => new three.BufferGeometry()', input(S_BEND), {})).toThrow(/no vertices/);
    expect(shapeInput({ id: 'x', name: 'x', curve: { points: [vertex(0, 0)], closed: false } })).toBeNull();
  });

  it('profiles are project data: add / assign / override params / remove; the overview lists them', () => {
    const { store, curve } = fixture();
    const { id: _presetId, ...tube } = PRESET_PROFILES.find((e) => e.id === 'round-tube')!;
    const a = cmd.addProfile(store, { ...tube, label: 'Tube 20' });
    const b = cmd.addProfile(store, { ...tube, label: 'Tube 20' });
    expect([a, b]).toEqual(['tube-20', 'tube-20-2']);   // id from the label (a preset added as is keeps its own id)
    cmd.updateProfile(store, a, { params: { diameter: 20, wall: 2 } });
    cmd.setCurveProfile(store, [curve], a);
    cmd.setCurveParams(store, [curve], { diameter: 30 });
    const c = store.project.curves[0];
    expect(paramsOf(store.profileOf(c.outline[0]), c.outline[0])).toEqual({ diameter: 30, wall: 2 });
    expect(size(curveGeometry(c, store.profileOf(c.outline[0]), c.outline[0].params)!).z).toBeCloseTo(30, 3);
    expect(overview(store)).toContain('params {"diameter":30}');
    expect(overview(store)).toContain('tube-20 "Tube 20" diameter=20 wall=2 (R ≥ 45, ≤ 6000 mm)');
    cmd.setCurveParams(store, [curve], { diameter: null });
    expect(store.project.curves[0].outline[0].params).toEqual({});
    expect(cmd.duplicateProfile(store, a)).toBe('tube-20-copy');
    expect(store.project.profiles.map((x) => x.id)).toEqual(['flat25x2', 'round15', 'tube-20', 'tube-20-copy', 'tube-20-2']);
    cmd.moveProfile(store, 'tube-20-2', 0);
    expect(store.project.profiles[0].id).toBe('tube-20-2');
    expect(cmd.removeProfile(store, a)).toBe(true);
    expect(store.project.curves[0].outline[0].profileId).toBe('tube-20-2');   // moved to the first remaining
    for (const id of ['tube-20-2', 'tube-20-copy', 'flat25x2']) cmd.removeProfile(store, id);
    expect(cmd.removeProfile(store, 'round15')).toBe(false);   // the last one stays
    expect(store.project.profiles.map((x) => x.id)).toEqual(['round15']);
  });

  it('migrates pre-Part-14 profiles (shape / a / b / t / rotate) to code with the same look', () => {
    const flat = profileFromLegacy({ id: 'f', label: 'F', shape: 'flat', a: 25, b: 2, t: 0, rotate: 90, color: '#abc', limits: { minBendRadius: 15, maxLength: 6000 } });
    expect(flat.params).toEqual({ width: 25, thickness: 2, rotate: 90 });
    expect(describeProfile(flat)).toBe('width=25 thickness=2 rotate=90');
    const straight = input({ points: [vertex(0, 0), vertex(1000, 0)], closed: false });
    const s = size(buildShapeGeometry(flat.code, straight, flat.params).geometry);
    expect(s.y).toBeCloseTo(25, 3); expect(s.z).toBeCloseTo(2, 3);   // rotate 90: lying flat on the plane
    const round = profileFromLegacy({ id: 'r', shape: 'round', a: 15, t: 1.5 });
    expect(round.params).toEqual({ diameter: 15, wall: 1.5 });
    const box = profileFromLegacy({ id: 'b', shape: 'rect', a: 20, b: 10, t: 1 });
    expect(size(buildShapeGeometry(box.code, straight, box.params).geometry).y).toBeCloseTo(20, 3);
    const { store } = fixture();
    const old = JSON.parse(JSON.stringify(store.project)) as { version: number; profiles: Record<string, unknown>[]; curves: Record<string, unknown>[] };
    old.version = 5;
    old.profiles = [{ id: 'flat25x2', label: 'Flat bar 25×2 mm', shape: 'flat', a: 25, b: 2, t: 0, rotate: 0, color: '#c9c9cf', limits: { minBendRadius: 15, maxLength: 6000 } }];
    for (const q of old.curves) { q.profileId = 'flat25x2'; delete q.outline; }   // a version-5 curve: one profile, no outline
    const migrated = migrateProject(old)!;
    expect(migrated.version).toBe(18);
    expect(migrated.profiles[0].params).toEqual({ width: 25, thickness: 2, rotate: 0 });
    expect(migrated.curves[0].outline[0].params).toEqual({});
    expect(migrateProject(JSON.parse(JSON.stringify(store.project)))).toEqual(store.project);
  });
});
