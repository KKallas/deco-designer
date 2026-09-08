/**
 * Run converted material code (src/blend/tsl.ts) — `(tsl, host) => material`.
 * The host supplies Blender's texture coordinates for the mesh the material
 * goes on. docs/09-blender-import.md.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

type Vec3Node = THREE.Node<'vec3'>;

/** Blender coordinate spaces, as TSL nodes. All in Blender's units (metres); the app models in mm. */
export interface MaterialHost {
  /** 0..1 over the mesh's bounding box (Blender "Generated") */
  generated: Vec3Node;
  /** object-local position in metres */
  object: Vec3Node;
  /** surface uv in metres (mesh uvs are mm) — the converter's default texture coordinate */
  uv: Vec3Node;
  normal: Vec3Node;
  /** world position in metres */
  position: Vec3Node;
  /** a project texture by id (docs/13-material-editor.md) — sRGB, repeating; a mid-grey placeholder if unknown. Sample with `texture(host.texture('id'), host.uv.xy)`. */
  texture: (id: string) => THREE.Texture;
}

/** Resolves texture ids for a host; null = unknown (the host falls back to the placeholder). */
export type TextureLookup = (id: string) => THREE.Texture | null;

let placeholder: THREE.Texture | null = null;
/** 1×1 mid grey, shared. */
export function placeholderTexture(): THREE.Texture {
  if (!placeholder) {
    placeholder = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    placeholder.colorSpace = THREE.SRGBColorSpace;
    placeholder.needsUpdate = true;
  }
  return placeholder;
}

function textureFn(lookup?: TextureLookup): MaterialHost['texture'] {
  return (id) => lookup?.(id) ?? placeholderTexture();
}

/** Repeating sRGB texture around an image element or bitmap (the settings every project texture gets). */
export function imageTexture(image: TexImageSource | undefined): THREE.Texture {
  const t = new THREE.Texture(image as THREE.Texture['image']);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (image) t.needsUpdate = true;
  return t;
}

export interface HostOptions {
  /** mesh bounds in mm (for `generated`); default: a 1 m cube centred on the origin */
  bounds?: { min: THREE.Vector3; max: THREE.Vector3 };
  /** divide the mesh's uv by this — uvs are millimetres on every mesh (docs/05-loft.md, docs/10-materials.md), so 1000 gives metres */
  uvScale?: number;
  /** project textures by id */
  textures?: TextureLookup;
}

export function hostFor(opts: HostOptions = {}): MaterialHost {
  const min = opts.bounds?.min ?? new THREE.Vector3(-500, -500, -500);
  const max = opts.bounds?.max ?? new THREE.Vector3(500, 500, 500);
  const size = max.clone().sub(min);
  const safe = new THREE.Vector3(size.x || 1, size.y || 1, size.z || 1);
  const uvScale = opts.uvScale ?? 1000;
  return {
    generated: TSL.positionLocal.sub(TSL.vec3(min.x, min.y, min.z)).div(TSL.vec3(safe.x, safe.y, safe.z)),
    object: TSL.positionLocal.div(1000),
    uv: TSL.vec3(TSL.uv().div(uvScale), 0),
    normal: TSL.normalLocal,
    position: TSL.positionWorld.div(1000),
    texture: textureFn(opts.textures),
  };
}

/**
 * One host for every mesh in a scene: `generated` reads each mesh's own
 * bounding box through per-object uniforms, so one compiled material serves
 * all curves and lofts. uv is expected in mm (pipe and loft geometry).
 */
export function hostForObjects(textures?: TextureLookup): MaterialHost {
  const box = new THREE.Box3();
  const boundsOf = (object: THREE.Object3D | null) => {
    const g = (object as THREE.Mesh | null)?.geometry;
    if (!g) return box.set(new THREE.Vector3(-500, -500, -500), new THREE.Vector3(500, 500, 500));
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox!;
  };
  const min = TSL.uniform(new THREE.Vector3()).onObjectUpdate(({ object }, self) => { self.value.copy(boundsOf(object).min); });
  const size = TSL.uniform(new THREE.Vector3(1, 1, 1)).onObjectUpdate(({ object }, self) => {
    const b = boundsOf(object); self.value.subVectors(b.max, b.min);
    if (!self.value.x) self.value.x = 1; if (!self.value.y) self.value.y = 1; if (!self.value.z) self.value.z = 1;
  });
  return {
    generated: TSL.positionLocal.sub(min).div(size),
    object: TSL.positionLocal.div(1000),
    uv: TSL.vec3(TSL.uv().div(1000), 0),
    normal: TSL.normalLocal,
    position: TSL.positionWorld.div(1000),
    texture: textureFn(textures),
  };
}

const scope = { ...TSL, MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial, DoubleSide: THREE.DoubleSide, FrontSide: THREE.FrontSide, Color: THREE.Color };

/** Evaluate converted material source. Throws with the JS error if the code is broken. */
export function buildMaterial(code: string, host: MaterialHost): THREE.MeshPhysicalNodeMaterial {
  const body = code.replace(/^\s*\/\/.*$/gm, '').trim();
  const fn = new Function('tsl', 'host', `"use strict"; return (${body})(tsl, host);`) as (t: typeof scope, h: MaterialHost) => unknown;
  const m = fn(scope, host);
  if (!(m instanceof THREE.MeshPhysicalNodeMaterial)) throw new Error('the code must return a MeshPhysicalNodeMaterial');
  return m;
}
