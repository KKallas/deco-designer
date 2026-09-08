/** The emitter transfer bake: probe lattice, voxel visibility, SH weights (docs/17-emitters.md). */
import { describe, expect, it } from 'vitest';
import { SH_COEFFS, bakeTransfer, evaluate, irradianceAt, occluded, probeCount, probeGrid, probePosition, voxelize, type Emitter } from '../src/geometry/probes';

const emitter = (x: number, y: number, z: number, slot = 0, area = 100): Emitter => ({ x, y, z, area, slot });

/** A solid 1000×1000 wall in the plane z = 0, as triangles. */
const wall = () => new Float32Array([
  -500, -500, 0, 500, -500, 0, 500, 500, 0,
  -500, -500, 0, 500, 500, 0, -500, 500, 0,
]);

describe('probe grid', () => {
  it('covers the box with padding and never exceeds the cap', () => {
    const g = probeGrid({ x: 0, y: 0, z: 0 }, { x: 1000, y: 1000, z: 1000 }, 250);
    expect(g.spacing).toBe(250);
    expect(probePosition(g, 0)).toEqual(g.min);
    expect(g.min.x).toBeLessThan(0);                              // padded outside the content
    const far = probePosition(g, probeCount(g) - 1);
    expect(far.x).toBeGreaterThanOrEqual(1000);
    const big = probeGrid({ x: 0, y: 0, z: 0 }, { x: 100000, y: 100000, z: 100000 }, 100, 4096);
    expect(probeCount(big)).toBeLessThanOrEqual(4096);
    expect(big.spacing).toBeGreaterThan(100);
  });

  it('a flat scene still gets a lattice with depth', () => {
    const g = probeGrid({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 1000 }, 250);
    expect(g.ny).toBeGreaterThanOrEqual(2);
  });
});

describe('visibility', () => {
  it('a wall blocks what is behind it and nothing else', () => {
    const occ = voxelize(wall(), { x: -500, y: -500, z: 0 }, { x: 500, y: 500, z: 0 }, 50);
    expect(occ.bits.some((b) => b === 1)).toBe(true);
    expect(occluded(occ, 0, 0, -400, 0, 0, 400)).toBe(true);       // straight through
    expect(occluded(occ, 0, 0, -400, 0, 0, -100)).toBe(false);     // both in front
    expect(occluded(occ, 2000, 0, -400, 2000, 0, 400)).toBe(false);// past the edge of the wall
    expect(occluded(occ, 0, 0, 400, 0, 0, -400)).toBe(true);       // and the other way round
  });

  it('no occupancy means nothing is blocked', () => {
    const occ = voxelize(new Float32Array(0), { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 50);
    expect(occluded(occ, -100, 0, 0, 100, 0, 0)).toBe(false);
  });
});

describe('transfer', () => {
  it('keeps the strongest emitters per probe and falls off with distance', () => {
    const g = probeGrid({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1000);
    const near = emitter(100, 0, 0, 0), far = emitter(5000, 0, 0, 1);
    const t = bakeTransfer(g, [far, near], { k: 1 });
    const pi = 0;
    expect(t.slots[pi]).toBe(near.slot);                            // the near one wins the only slot
    const t2 = bakeTransfer(g, [far, near], { k: 2 });
    expect([t2.slots[0], t2.slots[1]]).toEqual([near.slot, far.slot]);   // strongest first
    const w = (i: number) => t2.weights[(pi * 2 + i) * SH_COEFFS];
    const p = probePosition(g, pi);
    const d2 = (e: typeof near) => (e.x - p.x) ** 2 + (e.y - p.y) ** 2 + (e.z - p.z) ** 2;
    expect(w(0) / w(1)).toBeCloseTo(d2(far) / d2(near), 1);              // exactly the 1/r² ratio
  });

  it('probe irradiance follows the lit pixels and their direction', () => {
    const g = probeGrid({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1000);
    const t = bakeTransfer(g, [emitter(0, 500, 0, 0, 10000)], { k: 4 });
    const sh = new Float32Array(t.probes * SH_COEFFS * 3);
    const colours = new Float32Array(3);
    evaluate(t, colours, sh);
    expect(irradianceAt(sh, 0, { x: 0, y: 1, z: 0 })).toBe(0);      // dark pixel, no light
    colours.set([2, 1, 0.5]);
    evaluate(t, colours, sh);
    const up = irradianceAt(sh, 0, { x: 0, y: 1, z: 0 });           // facing the lamp
    const down = irradianceAt(sh, 0, { x: 0, y: -1, z: 0 });        // facing away
    expect(up).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(down);
    expect(irradianceAt(sh, 0, { x: 0, y: 1, z: 0 }, 1)).toBeCloseTo(up / 2, 5);   // green is half of red
    const scaled = new Float32Array(sh.length);
    evaluate(t, colours, scaled, 4);
    expect(irradianceAt(scaled, 0, { x: 0, y: 1, z: 0 })).toBeCloseTo(up * 4, 4);
  });

  it('a wall between probe and lamp leaves the probe dark', () => {
    const g = probeGrid({ x: 0, y: 0, z: -400 }, { x: 0, y: 0, z: -400 }, 1000);
    const lamp = emitter(0, 0, 400, 0, 10000);
    const occ = voxelize(wall(), { x: -500, y: -500, z: 0 }, { x: 500, y: 500, z: 0 }, 50);
    const lit = bakeTransfer(g, [lamp], { k: 2 });
    const shadowed = bakeTransfer(g, [lamp], { k: 2, occupancy: occ });
    const colours = new Float32Array([1, 1, 1]);
    const a = new Float32Array(lit.probes * SH_COEFFS * 3), b = new Float32Array(a.length);
    evaluate(lit, colours, a); evaluate(shadowed, colours, b);
    expect(irradianceAt(a, 0, { x: 0, y: 0, z: 1 })).toBeGreaterThan(0);
    expect(irradianceAt(b, 0, { x: 0, y: 0, z: 1 })).toBe(0);
  });

  it('bakes in slices and re-uses its arrays', () => {
    const g = probeGrid({ x: 0, y: 0, z: 0 }, { x: 500, y: 500, z: 500 }, 250);
    const es = [emitter(250, 250, 250, 0, 500)];
    const whole = bakeTransfer(g, es, { k: 4 });
    const half = Math.floor(whole.probes / 2);
    let sliced = bakeTransfer(g, es, { k: 4, to: half });
    const same = sliced;
    sliced = bakeTransfer(g, es, { k: 4, from: half, into: sliced });
    expect(sliced).toBe(same);                                       // same arrays, filled in place
    expect([...sliced.slots]).toEqual([...whole.slots]);
    expect([...sliced.weights]).toEqual([...whole.weights]);
  });
});
