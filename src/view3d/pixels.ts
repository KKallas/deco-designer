/**
 * The live colour of every LED (docs/17-emitters.md).
 *
 * A profile program numbers its lamps with a `pixel` vertex attribute; the
 * viewer gives each outline layer of each curve (docs/30 §3) a block of
 * **slots** in one project-wide buffer, keyed `curve/layer`.
 * A layer patched as a fixture reads its colours from an **animation map**
 * — a PNG where x = LED id and y = frame — otherwise the lamps keep the
 * colour the shape baked into them. The buffer is a texture the lamp
 * materials sample, and the same numbers drive the lighting bake.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, int, ivec2, max as tslMax, step, textureLoad, uniform, vec3 } from 'three/tsl';
import type { Animation, Id, Project, Texture } from '../model/types';
import { findAnimation, pixelCount } from '../model/types';

/** Slots per texture row. */
const ROW = 256;

type Uniform = ReturnType<typeof uniform>;

/** The lamps a built geometry carries: where they are (local mm), how big their lit surface is, what colour the shape gave them. */
export interface Lamps {
  count: number;
  /** 3 per lamp, geometry-local mm */
  positions: Float32Array;
  /** mm² of lit surface per lamp */
  areas: Float32Array;
  /** 3 per lamp: the shape's own emissive colour */
  colours: Float32Array;
}

const EMPTY_LAMPS: Lamps = { count: 0, positions: new Float32Array(0), areas: new Float32Array(0), colours: new Float32Array(0) };

/** Read a geometry's `pixel` attribute: one lamp per index, its position the centre of its vertices. */
export function lampsOf(geo: THREE.BufferGeometry): Lamps {
  const px = geo.getAttribute('pixel');
  const pos = geo.getAttribute('position');
  if (!px || !pos) return EMPTY_LAMPS;
  let count = 0;
  for (let i = 0; i < px.count; i++) count = Math.max(count, Math.round(px.getX(i)) + 1);
  if (count <= 0) return EMPTY_LAMPS;
  const positions = new Float32Array(count * 3), colours = new Float32Array(count * 3), areas = new Float32Array(count);
  const n = new Float32Array(count);
  const emissive = geo.getAttribute('emissive');
  for (let i = 0; i < px.count; i++) {
    const p = Math.round(px.getX(i));
    if (p < 0) continue;
    positions[p * 3] += pos.getX(i); positions[p * 3 + 1] += pos.getY(i); positions[p * 3 + 2] += pos.getZ(i);
    if (emissive && n[p] === 0) { colours[p * 3] = emissive.getX(i); colours[p * 3 + 1] = emissive.getY(i); colours[p * 3 + 2] = emissive.getZ(i); }
    n[p]++;
  }
  for (let p = 0; p < count; p++) if (n[p]) { positions[p * 3] /= n[p]; positions[p * 3 + 1] /= n[p]; positions[p * 3 + 2] /= n[p]; }
  // lit surface: the triangles whose corners all belong to the lamp
  const idx = geo.getIndex();
  const tris = idx ? idx.count / 3 : pos.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const p = Math.round(px.getX(i0));
    if (p < 0 || p !== Math.round(px.getX(i1)) || p !== Math.round(px.getX(i2))) continue;
    a.fromBufferAttribute(pos as THREE.BufferAttribute, i0); b.fromBufferAttribute(pos as THREE.BufferAttribute, i1); c.fromBufferAttribute(pos as THREE.BufferAttribute, i2);
    areas[p] += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
  }
  return { count, positions, areas, colours };
}

/** A decoded animation map: RGB rows of frames. */
export interface PixelMap { width: number; height: number; data: Uint8ClampedArray }

const srgb = new Float32Array(256);
for (let i = 0; i < 256; i++) { const v = i / 255; srgb[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }

/** Decode the PNG behind an animation (browser only); the result is cached per texture data. */
export class PixelMaps {
  private maps = new Map<Id, { data: string; map: PixelMap | null }>();

  /** Start decoding anything new; `onReady` fires when a map arrives. */
  sync(project: Project, onReady: () => void): void {
    const wanted = new Set<Id>();
    for (const a of project.animations) {
      const t = project.textures.find((x) => x.id === a.texture);
      if (!t) continue;
      wanted.add(a.texture);
      const hit = this.maps.get(a.texture);
      if (hit && hit.data === t.data) continue;
      this.maps.set(a.texture, { data: t.data, map: null });
      void decode(t).then((map) => {
        const e = this.maps.get(t.id);
        if (!e || e.data !== t.data) return;
        e.map = map;
        onReady();
      });
    }
    for (const id of [...this.maps.keys()]) if (!wanted.has(id)) this.maps.delete(id);
  }

  get(a: Animation | null): PixelMap | null {
    return a ? this.maps.get(a.texture)?.map ?? null : null;
  }
}

async function decode(t: Texture): Promise<PixelMap | null> {
  try {
    const bmp = await createImageBitmap(await (await fetch(t.data)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return { width: img.width, height: img.height, data: img.data };
  } catch (e) {
    console.warn(`animation map "${t.name}" (${t.id}) could not be decoded:`, e);
    return null;
  }
}

/** The frame an animation shows at `seconds` (held on the last frame when it does not loop). */
export function frameAt(a: Animation, seconds: number): number {
  const frames = Math.max(1, a.frames);
  const f = Math.floor(seconds * Math.max(0.01, a.fps));
  // a map always wraps within its own length: a 2 s chase repeats across a 14 s clock
  // (docs/22-transport-in-out.md §3) — looping the clock is the transport's business
  return ((f % frames) + frames) % frames;
}

/** One block of slots: one outline layer's lamps. */
interface Block { base: number; count: number; colours: Float32Array }

export class PixelBuffer {
  /** RGB per slot, linear — what the lighting bake multiplies through its transfer matrix */
  colours = new Float32Array(0);
  readonly texture: THREE.DataTexture;
  private data = new Float32Array(0);
  private blocks = new Map<Id, Block>();
  private next = 0;
  /** never changes: it is compiled into every lamp material */
  private readonly width = ROW;
  /** bumped whenever the layout changes, so the lighting bake knows to start again */
  layoutKey = '';

  constructor() {
    this.texture = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  /** Start assigning slots (call for every layer with lamps, then `endLayout`). */
  beginLayout(): void { this.next = 0; this.pending = new Map(); }
  private pending = new Map<Id, Block>();

  /** Give a layer's lamps their slots (`id` = `curve/layer`); returns the first one. */
  addFixture(id: string, lamps: Lamps): number {
    const base = this.next;
    this.pending.set(id, { base, count: lamps.count, colours: lamps.colours });
    this.next += lamps.count;
    return base;
  }

  endLayout(): void {
    const key = [...this.pending].map(([id, b]) => `${id}:${b.base}:${b.count}`).join('|');
    this.blocks = this.pending;
    this.pending = new Map();
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const total = Math.max(1, this.next);
    const height = Math.max(1, Math.ceil(total / ROW));
    this.colours = new Float32Array(total * 3);
    this.data = new Float32Array(this.width * height * 4);
    this.texture.dispose();
    this.texture.image = { data: this.data, width: this.width, height } as unknown as THREE.DataTexture['image'];
    this.texture.needsUpdate = true;
  }

  get slots(): number { return this.next || this.colours.length / 3; }
  baseOf(id: Id): number { return this.blocks.get(id)?.base ?? 0; }

  /**
   * Write the colours of this moment: a patched fixture reads its animation's row, everything else keeps
   * the colour its shape baked in. Returns true when anything changed.
   */
  fill(project: Project, maps: PixelMaps, seconds: number): boolean {
    let changed = false;
    const put = (slot: number, r: number, g: number, b: number) => {
      const c = slot * 3;
      if (this.colours[c] !== r || this.colours[c + 1] !== g || this.colours[c + 2] !== b) changed = true;
      this.colours[c] = r; this.colours[c + 1] = g; this.colours[c + 2] = b;
      const d = slot * 4;
      this.data[d] = r; this.data[d + 1] = g; this.data[d + 2] = b; this.data[d + 3] = 1;
    };
    for (const c of project.curves) for (const layer of c.outline) {
      const block = this.blocks.get(`${c.id}/${layer.id}`);
      if (!block) continue;
      const fixture = layer.pixels;
      const anim = fixture ? findAnimation(project, fixture.animation) : null;
      const map = maps.get(anim);
      const pixels = pixelCount(fixture);
      const frame = anim ? frameAt(anim, seconds) : 0;
      for (let j = 0; j < block.count; j++) {
        const own = [block.colours[j * 3], block.colours[j * 3 + 1], block.colours[j * 3 + 2]] as const;
        if (!fixture || !anim || !map) { put(block.base + j, own[0], own[1], own[2]); continue; }
        const p = fixture.reverse ? pixels - 1 - j : j;
        if (j >= pixels || p < 0) { put(block.base + j, 0, 0, 0); continue; }
        const x = fixture.offset + p;
        if (x >= map.width) { put(block.base + j, 0, 0, 0); continue; }
        const o = (Math.min(map.height - 1, frame) * map.width + x) * 4;
        // the lamp's own colour sets how bright "white" is (the shape's glow), the map sets the hue
        const scale = Math.max(own[0], own[1], own[2]) || 1;
        put(block.base + j, srgb[map.data[o]] * scale, srgb[map.data[o + 1]] * scale, srgb[map.data[o + 2]] * scale);
      }
    }
    if (changed) this.texture.needsUpdate = true;
    return changed;
  }

  /** What a lamp shows: its slot's colour (a vertex with `pixel` < 0 is not a lamp and stays black). */
  node(base: Uniform): THREE.Node<'vec3'> {
    const px = float(attribute('pixel', 'float') as unknown as THREE.Node<'float'>);
    const on = step(float(-0.5), px);                       // 1 for a lamp, 0 for the wire
    const i = int(tslMax(px, float(0)).add(base as unknown as THREE.Node<'float'>).add(0.5));
    const w = int(this.width);
    const texel = textureLoad(this.texture, ivec2(i.mod(w), i.div(w)));
    return vec3(texel.rgb).mul(on) as unknown as THREE.Node<'vec3'>;
  }

  /** A uniform for a layer's first slot (kept, so its material never has to be rebuilt). */
  baseUniform(id: Id): Uniform {
    let u = this.bases.get(id);
    if (!u) this.bases.set(id, u = uniform(0));
    u.value = this.baseOf(id);
    return u;
  }
  private bases = new Map<Id, Uniform>();
}
