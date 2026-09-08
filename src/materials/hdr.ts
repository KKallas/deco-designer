/**
 * HDR images (docs/16-world.md): Radiance .hdr and OpenEXR .exr files kept
 * as project textures (base64 data URLs) — decoded with three's loaders
 * into float data for a world's background / environment, and tone-mapped
 * into a small PNG for thumbnails. Browser only (canvas) except `decodeHdr`.
 */
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDR_MIMES } from '../model/world';
import type { Texture } from '../model/types';

export interface HdrImage { width: number; height: number; data: Float32Array; }

/** Decode .hdr / .exr bytes to linear float RGBA. Throws if the file cannot be read. */
export function decodeHdr(bytes: ArrayBuffer, mime: string): HdrImage {
  if (mime === HDR_MIMES.exr) {
    const loader = new EXRLoader();
    loader.setDataType(THREE.FloatType);
    const r = loader.parse(bytes) as { width: number; height: number; data: Float32Array; format: THREE.PixelFormat };
    if (r.format !== THREE.RGBAFormat) throw new Error('EXR: only RGBA output is supported');
    return { width: r.width, height: r.height, data: r.data };
  }
  const loader = new HDRLoader();
  loader.type = THREE.FloatType;
  const r = loader.parse(bytes) as { width: number; height: number; data: Float32Array } | null;
  if (!r) throw new Error('not a Radiance HDR file');
  return { width: r.width, height: r.height, data: r.data };
}

/** The bytes of a data URL. */
export function dataUrlBytes(url: string): ArrayBuffer {
  const i = url.indexOf(',');
  const bin = atob(i >= 0 ? url.slice(i + 1) : url);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out.buffer;
}

export function decodeHdrTexture(t: Pick<Texture, 'data' | 'mime'>): HdrImage {
  return decodeHdr(dataUrlBytes(t.data), t.mime);
}

/** An equirectangular float texture for `scene.background` / PMREM. */
export function hdrDataTexture(img: HdrImage): THREE.DataTexture {
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

/** A tone-mapped PNG data URL (x / (1 + x), sRGB) at most `width` px wide — thumbnails in the lists. */
export function hdrThumbnail(img: HdrImage, width = 256): string {
  const step = Math.max(1, Math.ceil(img.width / width));
  const w = Math.max(1, Math.floor(img.width / step)), h = Math.max(1, Math.floor(img.height / step));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const srgb = (v: number) => { const c = v / (1 + v); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((img.height - 1 - y * step) * img.width + x * step) * 4, di = (y * w + x) * 4;
    out.data[di] = srgb(img.data[si]); out.data[di + 1] = srgb(img.data[si + 1]); out.data[di + 2] = srgb(img.data[si + 2]); out.data[di + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

const thumbs = new Map<string, { data: string; url: string }>();

/** Cached thumbnail per texture id (recomputed when the data changes); null if the file cannot be decoded. */
export function hdrThumbnailFor(t: Texture): string | null {
  const hit = thumbs.get(t.id);
  if (hit && hit.data === t.data) return hit.url;
  try {
    const url = hdrThumbnail(decodeHdrTexture(t));
    thumbs.set(t.id, { data: t.data, url });
    return url;
  } catch (e) { console.warn(`HDR "${t.name}" (${t.id}) could not be decoded:`, e); return null; }
}
