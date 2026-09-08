/**
 * Project textures as three.js textures (docs/13-material-editor.md): one
 * texture object per id, its image swapped in place when the data changes,
 * so compiled materials keep working when a texture is added, replaced or
 * renamed. Also the helpers that turn a file / bytes into a project Texture.
 */
import * as THREE from 'three/webgpu';
import type { Texture } from '../model/types';
import { imageTexture } from './runtime';
import { HDR_MIMES, isHdrMime } from '../model/world';
import { decodeHdr } from './hdr';

export class TextureCache {
  private entries = new Map<string, { texture: THREE.Texture; data: string | null; loading: number }>();
  private placeholder: HTMLCanvasElement | null = null;

  /** The texture for an id — created (grey) if unknown, filled by `sync`. */
  get(id: string): THREE.Texture {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, e = { texture: imageTexture(this.grey()), data: null, loading: 0 });
    return e.texture;
  }

  /** Load new / changed project textures into their objects; ids that are gone go back to grey. */
  sync(textures: Texture[]): void {
    const seen = new Set<string>();
    for (const t of textures) {
      seen.add(t.id);
      let e = this.entries.get(t.id);
      if (!e) this.entries.set(t.id, e = { texture: imageTexture(this.grey()), data: null, loading: 0 });
      if (e.data === t.data) continue;
      e.data = t.data;
      const gen = ++e.loading;
      if (isHdrMime(t.mime)) { swap(e.texture, this.grey()); continue; }   // HDRs are for worlds (docs/16-world.md); a material sampling one gets grey
      const img = new Image();
      img.onload = () => { if (e!.loading !== gen) return; swap(e!.texture, img); };
      img.onerror = () => { if (e!.loading === gen) console.warn(`texture "${t.name}" (${t.id}) could not be decoded`); };
      img.src = t.data;
    }
    for (const [id, e] of this.entries) {
      if (seen.has(id) || e.data === null) continue;
      e.data = null; e.loading++;
      swap(e.texture, this.grey());
    }
  }

  private grey(): HTMLCanvasElement {
    if (!this.placeholder) {
      this.placeholder = document.createElement('canvas');
      this.placeholder.width = this.placeholder.height = 1;
      const ctx = this.placeholder.getContext('2d')!;
      ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 1, 1);
    }
    return this.placeholder;
  }
}

/** Replace a texture's image; dispose first so the GPU texture is recreated at the new size. */
function swap(t: THREE.Texture, image: HTMLImageElement | HTMLCanvasElement): void {
  t.dispose();
  t.image = image;
  t.needsUpdate = true;
}

const MIMES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', ...HDR_MIMES };
export const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.hdr,.exr,image/*';
/** Only the HDR formats a world can use (docs/16-world.md). */
export const HDR_ACCEPT = '.hdr,.exr';

/** Mime type from the first bytes (Blender's packed files carry no type), falling back to the name's extension. */
export function sniffMime(bytes: Uint8Array, name = ''): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes[0] === 0x23 && bytes[1] === 0x3f) return HDR_MIMES.hdr;   // "#?RADIANCE" / "#?RGBE"
  if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return HDR_MIMES.exr;
  return MIMES[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';
}

export function isImageMime(mime: string): boolean { return mime.startsWith('image/'); }

/** Texture name from a file name: the base name without extension. */
export function textureName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,5}$/i, '') || fileName;
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Decode to learn the size; rejects if the browser cannot read the image. */
function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('not a readable image'));
    img.src = url;
  });
}

/** A project texture (without id) from image bytes — a dropped file or an image packed in a .blend. */
export async function textureFromBytes(bytes: Uint8Array, name: string, source: string): Promise<Omit<Texture, 'id'>> {
  const mime = sniffMime(bytes, name);
  if (!isImageMime(mime)) throw new Error(`${name}: not a PNG / JPEG / WebP image or an HDR / EXR`);
  const data = dataUrl(bytes, mime);
  const { width, height } = isHdrMime(mime) ? decodeHdr(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, mime) : await measure(data);
  return { name: textureName(name), mime, data, width, height, source };
}

export async function textureFromFile(file: File): Promise<Omit<Texture, 'id'>> {
  return textureFromBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.name);
}
