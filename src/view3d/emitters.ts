/**
 * Light from the LEDs (docs/17-emitters.md): the scene side of
 * src/geometry/probes.ts.
 *
 * After the content is rebuilt the lamps are collected in world space and
 * **baked** — in background slices — into a transfer matrix to a grid of
 * spherical-harmonic probes, with the structure voxelized as the shadow
 * caster. Every frame the live pixel colours are multiplied through that
 * matrix and the probes are uploaded; materials read their irradiance from
 * them through `irradianceNode`, gated by a uniform so nothing has to be
 * rebuilt when emitters are switched on and off.
 */
import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld, texture3D, uniform, vec3 } from 'three/tsl';
import { SH_COEFFS, bakeTransfer, emptyOccupancy, probeCount, probeGrid, voxelize, type Emitter, type Occupancy, type ProbeGrid, type Transfer } from '../geometry/probes';
import type { WorldEmitters } from '../model/types';
import { lampsOf, type Lamps } from './pixels';

/** Probes filled per slice; a slice is one animation frame's worth of work. */
const SLICE = 400;
/** Emitters kept per probe. */
const K = 24;
/** Beyond this the 1/r² falloff makes a lamp irrelevant. */
const RADIUS = 8000;
/** Occluder triangles read at most (the rest is skipped — shadows stay approximate). */
const MAX_TRIANGLES = 40000;
/**
 * What `strength: 1` means. A shape's emissive value is tuned for the *look* (the LED preset's `glow` of 6
 * makes a sub-pixel lamp bloom), not as a radiance in W/sr — physically a 190 mm² tip at 6 lights almost
 * nothing. This turns "as bright as it looks" into "as bright as a lamp"; measured against the LED preset.
 */
const CALIBRATION = 300;

/** A curve's lamps placed in the world: one entry per instance of the curve. */
export interface LampPlacement { lamps: Lamps; base: number; matrix: THREE.Matrix4 }

export interface EmitterStats { probes: number; emitters: number; baked: number; spacing: number }

export class EmitterRig {
  /** 0 / 1: whether materials add the probe light at all */
  private gate = uniform(0);
  private strength = uniform(1);
  private gridMin = uniform(new THREE.Vector3());
  private gridStep = uniform(1);
  private gridDims = uniform(new THREE.Vector3(1, 1, 1));
  private textures: THREE.Data3DTexture[] = [];
  private sh = new Float32Array(0);
  private half: Uint16Array[] = [];

  private grid: ProbeGrid | null = null;
  private emitters: Emitter[] = [];
  private occupancy: Occupancy = emptyOccupancy();
  private transfer: Transfer | null = null;
  private bakedTo = 0;
  private contentKey = '';
  private enabled = false;

  /** Called when a bake finishes a slice, so the viewport keeps drawing. */
  onProgress: (stats: EmitterStats) => void = () => undefined;

  constructor() {
    for (let i = 0; i < SH_COEFFS; i++) {
      const data = new Uint16Array(4);
      const t = new THREE.Data3DTexture(data, 1, 1, 1);
      t.format = THREE.RGBAFormat;
      t.type = THREE.HalfFloatType;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      this.textures.push(t);
      this.half.push(data);
    }
  }

  /** What every lit material adds: the irradiance of the probes at the shaded point (0 while emitters are off). */
  irradianceNode(): THREE.Node<'vec3'> {
    const p = vec3(positionWorld).sub(this.gridMin as unknown as THREE.Node<'vec3'>).div(this.gridStep as unknown as THREE.Node<'float'>).add(0.5).div(this.gridDims as unknown as THREE.Node<'vec3'>);
    const n = vec3(normalWorld);
    const c = this.textures.map((t) => vec3(texture3D(t, p).rgb));
    const band1 = c[1].mul(n.y).add(c[2].mul(n.z)).add(c[3].mul(n.x)).mul(2 * 0.511664);
    const irradiance = c[0].mul(0.886227).add(band1).max(vec3(0));
    return irradiance.mul(this.gate as unknown as THREE.Node<'float'>).mul(this.strength as unknown as THREE.Node<'float'>) as unknown as THREE.Node<'vec3'>;
  }

  /**
   * The content changed: collect the lamps and the occluders and start a bake. `key` identifies the
   * geometry — the same key re-uses what is already baked.
   */
  setContent(key: string, placements: LampPlacement[], occluders: THREE.Mesh[], settings: WorldEmitters): void {
    const full = `${key}|${settings.probeSpacing}|${settings.visibility}`;
    this.enabled = settings.enabled;
    this.strength.value = settings.strength * CALIBRATION;
    if (!settings.enabled) { this.gate.value = 0; return; }
    if (full === this.contentKey) return;
    this.contentKey = full;
    this.emitters = collectEmitters(placements);
    const bounds = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const e of this.emitters) bounds.expandByPoint(v.set(e.x, e.y, e.z));
    for (const m of occluders) bounds.expandByObject(m);
    if (!this.emitters.length || bounds.isEmpty()) { this.grid = null; this.transfer = null; this.gate.value = 0; return; }
    this.grid = probeGrid(bounds.min, bounds.max, settings.probeSpacing);
    this.occupancy = settings.visibility ? voxelize(triangleSoup(occluders), bounds.min, bounds.max, Math.max(60, settings.probeSpacing / 3)) : emptyOccupancy();
    this.transfer = null;
    this.bakedTo = 0;
    this.sh = new Float32Array(probeCount(this.grid) * SH_COEFFS * 3);
    this.resize();
  }

  /** True while a bake still has probes to fill. */
  get baking(): boolean { return !!this.grid && this.bakedTo < probeCount(this.grid); }

  get stats(): EmitterStats {
    return { probes: this.grid ? probeCount(this.grid) : 0, emitters: this.emitters.length, baked: this.bakedTo, spacing: this.grid?.spacing ?? 0 };
  }

  /** One slice of the bake — called from the frame loop while `baking`. */
  bakeSlice(): void {
    if (!this.grid) return;
    const total = probeCount(this.grid);
    if (this.bakedTo >= total) return;
    const to = Math.min(total, this.bakedTo + SLICE);
    this.transfer = bakeTransfer(this.grid, this.emitters, { k: K, radius: RADIUS, occupancy: this.occupancy, from: this.bakedTo, to, into: this.transfer ?? undefined });
    this.bakedTo = to;
    this.onProgress(this.stats);
  }

  /** The per-frame step: the live colours through the transfer matrix and into the probe textures. */
  update(colours: Float32Array): void {
    if (!this.enabled || !this.grid || !this.transfer) { this.gate.value = 0; return; }
    this.gate.value = 1;
    const t = this.transfer, probes = t.probes;
    const sh = this.sh;
    sh.fill(0);
    const { k, slots, weights } = t;
    for (let pi = 0; pi < probes; pi++) {
      const o = pi * SH_COEFFS * 3;
      for (let i = 0; i < k; i++) {
        const slot = slots[pi * k + i];
        if (slot < 0) continue;
        const c = slot * 3;
        const r = colours[c], g = colours[c + 1], b = colours[c + 2];
        if (r === 0 && g === 0 && b === 0) continue;
        const w = (pi * k + i) * SH_COEFFS;
        for (let q = 0; q < SH_COEFFS; q++) {
          const wq = weights[w + q];
          if (wq === 0) continue;
          sh[o + q * 3] += r * wq; sh[o + q * 3 + 1] += g * wq; sh[o + q * 3 + 2] += b * wq;
        }
      }
    }
    for (let q = 0; q < SH_COEFFS; q++) {
      const dst = this.half[q];
      for (let pi = 0; pi < probes; pi++) {
        const o = pi * SH_COEFFS * 3 + q * 3, d = pi * 4;
        dst[d] = THREE.DataUtils.toHalfFloat(clampHalf(sh[o]));
        dst[d + 1] = THREE.DataUtils.toHalfFloat(clampHalf(sh[o + 1]));
        dst[d + 2] = THREE.DataUtils.toHalfFloat(clampHalf(sh[o + 2]));
        dst[d + 3] = 0x3c00;   // 1.0
      }
      this.textures[q].needsUpdate = true;
    }
  }

  private resize(): void {
    const g = this.grid!;
    this.gridMin.value = new THREE.Vector3(g.min.x, g.min.y, g.min.z);
    this.gridStep.value = g.spacing;
    this.gridDims.value = new THREE.Vector3(g.nx, g.ny, g.nz);
    const n = probeCount(g);
    for (let q = 0; q < SH_COEFFS; q++) {
      const data = new Uint16Array(n * 4);
      this.half[q] = data;
      const t = this.textures[q];
      t.dispose();
      t.image = { data, width: g.nx, height: g.ny, depth: g.nz };
      t.needsUpdate = true;
    }
  }

  dispose(): void { for (const t of this.textures) t.dispose(); }
}

const clampHalf = (v: number): number => (Number.isFinite(v) ? Math.min(65504, Math.max(-65504, v)) : 0);

/** Every lamp of every instance, in world millimetres. */
export function collectEmitters(placements: LampPlacement[]): Emitter[] {
  const out: Emitter[] = [];
  const v = new THREE.Vector3();
  // an instance is a copy of the same string: same pixel slots, its own place in the world
  const scale = new THREE.Vector3();
  for (const { lamps, base, matrix } of placements) {
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    const areaScale = Math.abs(scale.x * scale.y) || 1;
    for (let j = 0; j < lamps.count; j++) {
      if (lamps.areas[j] <= 0) continue;
      v.set(lamps.positions[j * 3], lamps.positions[j * 3 + 1], lamps.positions[j * 3 + 2]).applyMatrix4(matrix);
      out.push({ x: v.x, y: v.y, z: v.z, area: lamps.areas[j] * areaScale, slot: base + j });
    }
  }
  return out;
}

/**
 * World-space triangles of the structure — what casts the shadows. The LED strings themselves are
 * skipped: a string would mostly shadow itself, and its triangles are the bulk of the scene.
 */
export function triangleSoup(meshes: THREE.Mesh[], cap = MAX_TRIANGLES): Float32Array {
  const parts: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; tris: number }[] = [];
  let total = 0;
  for (const m of meshes) {
    const geo = m.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    const idx = geo.getIndex();
    const tris = Math.floor((idx ? idx.count : pos.count) / 3);
    if (!tris) continue;
    m.updateWorldMatrix(true, false);
    parts.push({ geo, matrix: m.matrixWorld.clone(), tris });
    total += tris;
  }
  const stride = Math.max(1, Math.ceil(total / cap));
  const kept = Math.ceil(total / stride);
  const out = new Float32Array(kept * 9);
  const a = new THREE.Vector3();
  let n = 0, seen = 0;
  for (const { geo, matrix, tris } of parts) {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const idx = geo.getIndex();
    for (let t = 0; t < tris; t++, seen++) {
      if (seen % stride) continue;
      if (n + 9 > out.length) break;
      for (let c = 0; c < 3; c++) {
        const i = idx ? idx.getX(t * 3 + c) : t * 3 + c;
        a.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        out[n++] = a.x; out[n++] = a.y; out[n++] = a.z;
      }
    }
  }
  return out.subarray(0, n);
}

export { lampsOf };
