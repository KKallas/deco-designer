/**
 * The look of the viewport and the page previews (docs/15-camera.md): the
 * project's **post-processing script** `(post, params) => outputNode` run
 * over the scene pass (the background, environment and view transform are
 * the world's — src/view3d/world.ts, docs/16-world.md) — bloom / lens flare / glare streaks / depth of field
 * are helpers the script composes with its knobs. The blue selection glow
 * (emissive 0.45) stays under the default bloom threshold on purpose.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { Fn, Loop, convertToTexture, diffuseColor, emissive, float, metalness, mix, mrt, normalView, output, pass, pow, roughness, rtt, step as step_, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { dof as dofNode } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { ssgi as ssgiNode } from 'three/addons/tsl/display/SSGINode.js';
import { ssr as ssrNode } from 'three/addons/tsl/display/SSRNode.js';
import type { CameraSettings, PostProgram } from '../model/types';
import { dofRange } from '../model/camera';

export interface Effects {
  /** render the scene through the chain (replaces renderer.render) */
  render(): void;
  /** the viewer switches between a perspective and an orthographic camera */
  setCamera(camera: THREE.Camera): void;
  dispose(): void;
}

type V4 = THREE.Node<'vec4'>;
const v4 = (n: unknown): V4 => vec4(n as V4);
// The specular colour (F0) of a standard / physical material: 4 % for a dielectric, the base colour for a metal — what
// three's `specularColorBlended` holds, rebuilt here because the three/tsl entry does not export it (`diffuseColor` is
// the base colour at output time; the metal darkening goes to `diffuseContribution`).
const specularF0 = mix(vec3(0.04), diffuseColor.rgb, metalness);

const STREAK_DIRS = [15, 105, 60, 150].map((deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]);
const STREAK_SAMPLES = 24;

/** Four glare streaks (Blender Glare › Streaks): sum of the glow along four directions with a geometric falloff. */
const streaksFn = Fn(([tex, length]: [ReturnType<typeof rtt>, THREE.Node<'float'>]) => {
  const uv = (tex.uvNode ?? vec2(0)) as THREE.Node<'vec2'>;
  const acc = vec3(0).toVar();
  const step = length.div(STREAK_SAMPLES);
  // a sample outside the image contributes nothing (no wrapping / edge smearing)
  const inside = (q: THREE.Node<'vec2'>) => step_(vec2(0), q).mul(step_(q, vec2(1)));
  for (const [dx, dy] of STREAK_DIRS) {
    const d = vec2(dx, dy).mul(step);
    Loop({ start: 1, end: STREAK_SAMPLES, type: 'int' }, ({ i }: { i: THREE.Node<'int'> }) => {
      const k = float(i);
      const w = pow(float(0.86), k);
      const a = uv.add(d.mul(k)) as THREE.Node<'vec2'>, b = uv.sub(d.mul(k)) as THREE.Node<'vec2'>;
      const ia = inside(a), ib = inside(b);
      acc.addAssign(tex.sample(a).rgb.mul(w).mul(ia.x.mul(ia.y)));
      acc.addAssign(tex.sample(b).rgb.mul(w).mul(ib.x.mul(ib.y)));
    });
  }
  return vec4(acc.div(STREAK_SAMPLES * 0.9), 1);
});

const clamp01 = (v: number, d: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const pos = (v: number, d: number) => (Number.isFinite(v) ? Math.max(0, v) : d);

/** Knobs of `post.ssr` (docs/31-ssr.md §2) — distances in mm. */
export interface SsrOptions { intensity?: number; maxDistance?: number; thickness?: number; quality?: number; resolution?: number }
export const SSR_DEFAULTS: Required<SsrOptions> = { intensity: 1, maxDistance: 4000, thickness: 40, quality: 0.5, resolution: 1 };

/** What a post script sees as `post` (docs/15-camera.md §3). */
export interface PostScope {
  tsl: typeof TSL;
  three: typeof THREE;
  scene: { color: V4; emissive: V4; viewZ: THREE.Node<'float'> };
  camera: { focalLength: number; filmBack: { width: number; height: number }; aspect: number; dof: boolean; focusDistance: number; fStop: number };
  bloom: (source: unknown, strength: number, radius: number, threshold: number, knee?: number) => V4;
  lensflare: (node: unknown, opts?: Record<string, unknown>) => V4;
  streaks: (node: unknown, length: number) => V4;
  dof: (node: unknown, bokeh?: number) => V4;
  /** screen-space bounce: what the lit and emissive pixels throw onto their neighbours (docs/17-emitters.md) */
  ssgi: (node: unknown, opts?: Record<string, number>) => V4;
  /** screen-space reflections: `node` plus what the metals on screen mirror (docs/31-ssr.md); intensity 0 builds nothing */
  ssr: (node: unknown, opts?: SsrOptions) => V4;
  rtt: (node: unknown, width?: number, height?: number) => V4;
}

/** Compile the script — throws on a syntax error. Comments are stripped like material code. */
export function compilePost(code: string): (post: PostScope, params: Record<string, number>) => unknown {
  const body = code.replace(/^\s*\/\/.*$/gm, '').trim();
  return new Function('post', 'params', `"use strict"; return (${body})(post, params);`) as (p: PostScope, q: Record<string, number>) => unknown;
}

/**
 * The scene pass and the script's output node — no renderer needed (tests build it headless). Throws with the
 * script's error. `dofAllowed` is false with the orthographic camera.
 */
export function buildPostNode(scene: THREE.Scene, camera: THREE.Camera, post: PostProgram, cam: CameraSettings, aspect: number, dofAllowed = true): { scenePass: ReturnType<typeof pass>; out: V4; nodes: THREE.Node[] } {
  const scenePass = pass(scene, camera);
  // `normal` rides along for the screen-space bounce (post.ssgi, docs/17-emitters.md); metalness, roughness and the
  // specular colour (F0) for the reflections (post.ssr, docs/31-ssr.md)
  scenePass.setMRT(mrt({ output, emissive, normal: normalView, metalness, roughness, specular: specularF0 }));
  const nodes: THREE.Node[] = [scenePass];
  const track = <T,>(n: T): T => { nodes.push(n as unknown as THREE.Node); return n; };
  const scope: PostScope = {
    tsl: TSL, three: THREE,
    scene: { color: v4(scenePass.getTextureNode('output')), emissive: v4(scenePass.getTextureNode('emissive')), viewZ: scenePass.getViewZNode() as unknown as THREE.Node<'float'> },
    camera: { focalLength: cam.focalLength, filmBack: { ...cam.filmBack }, aspect, dof: dofAllowed && cam.dof.enabled, focusDistance: cam.dof.focusDistance, fStop: cam.dof.fStop },
    // knobs are clamped to what the nodes accept: radius 0..1 (mip mix, 1 = fog), knee 0..1, strength / threshold ≥ 0
    bloom: (source, strength, radius, threshold, knee = 0.01) => { const b = track(bloom(v4(source), pos(strength, 1), clamp01(radius, 0.4), pos(threshold, 0.8))); b.smoothWidth.value = clamp01(knee, 0.5); return v4(b); },
    lensflare: (node, opts = {}) => v4(track(lensflare(v4(node), { threshold: float(0.6), ghostSamples: float(3), ghostSpacing: float(0.3), ghostAttenuationFactor: float(22), ghostTint: vec3(1, 0.92, 0.75), ...opts }))),
    // streak length is a fraction of the screen (0..0.5)
    streaks: (node, length) => { const small = track(rtt(v4(node), 512, 512)); const tex = track(rtt(streaksFn(small, float(Math.min(0.5, pos(length, 0.1)))), 512, 512)); return v4(tex); },
    dof: (node, bokeh = 1) => v4(track(dofNode(v4(node), scenePass.getViewZNode(), cam.dof.focusDistance, dofRange(cam), pos(bokeh, 1)))),
    ssgi: (node, opts = {}) => {
      const g = track(ssgiNode(v4(node), scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), camera as THREE.PerspectiveCamera));
      for (const [k, v] of Object.entries(opts)) { const u = (g as unknown as Record<string, { value?: number }>)[k]; if (u && typeof u === 'object' && 'value' in u) u.value = v; }
      return v4(g);
    },
    ssr: (node, opts = {}) => {
      const o = { ...SSR_DEFAULTS, ...opts };
      const intensity = pos(o.intensity, 1);
      if (intensity <= 0) return v4(node);
      // the node samples its colour and normal inputs itself (the hit, the blur), so both must be texture nodes: the
      // normal target as it is, the colour as a texture (the scene colour already is one; anything else is rendered to one)
      const normal = scenePass.getTextureNode('normal'), specular = scenePass.getTextureNode('specular');
      const direct = node === scope.scene.color;
      const colour = direct ? scenePass.getTextureNode('output') : track(convertToTexture(v4(node)));
      const r = track(ssrNode(colour, scenePass.getTextureNode('depth'), normal as unknown as THREE.Node<'vec3'>, {
        metalnessNode: normal.a,
        roughnessNode: specular.a,
        camera,
      }));
      r.intensity.value = intensity;
      r.maxDistance.value = Math.max(1, pos(o.maxDistance, SSR_DEFAULTS.maxDistance));
      r.thickness.value = Math.max(1, pos(o.thickness, SSR_DEFAULTS.thickness));
      r.quality.value = clamp01(o.quality, SSR_DEFAULTS.quality);
      r.resolutionScale = Math.min(1, Math.max(0.25, Number.isFinite(o.resolution) ? o.resolution : 1));
      // the node weights the hit by metalness; the specular colour tints it (gold reflects gold, chrome white)
      const tinted = v4(r).rgb.mul(v4(specular).rgb);
      return v4(vec4(v4(node).rgb.add(tinted), v4(node).a));
    },
    rtt: (node, width, height) => v4(track(rtt(v4(node), width, height))),
  };
  const result = compilePost(post.code)(scope, { ...post.params });
  if (!result || typeof result !== 'object' || !(result as { isNode?: boolean }).isNode) throw new Error('the script must return a node (e.g. post.scene.color)');
  return { scenePass, out: v4(result), nodes };
}

export interface EffectsOptions { perRender?: boolean }

/** The pipeline for a project's post script. Throws if the script fails — use `fallbackEffects` then. */
export function createEffects(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, post: PostProgram, cam: CameraSettings, opts: EffectsOptions = {}): Effects {
  const aspect = (camera as THREE.PerspectiveCamera).aspect || 1.5;
  const dofAllowed = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  const { scenePass, out, nodes } = buildPostNode(scene, camera, post, cam, aspect, dofAllowed);
  return pipeline(renderer, scenePass, out, nodes, opts.perRender ?? true);
}

/** The plain image through the pipeline (view transform only) — what a broken script falls back to. */
export function fallbackEffects(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): Effects {
  const scenePass = pass(scene, camera);
  return pipeline(renderer, scenePass, v4(scenePass), [scenePass], true);
}

function pipeline(renderer: THREE.WebGPURenderer, scenePass: ReturnType<typeof pass>, out: V4, nodes: THREE.Node[], perRender: boolean): Effects {
  const post = new THREE.RenderPipeline(renderer);
  post.outputNode = out;
  // The pass / bloom / flare nodes re-render their input once per *frame id* by default and here that left them
  // frozen on their first frame (a chain built before the scene was populated showed nothing at all). Gating them
  // on the render counter — advanced by every render call — keeps them live; there is one chain render per tick.
  if (perRender) for (const n of nodes) n.updateBeforeType = THREE.NodeUpdateType.RENDER;
  return {
    render: () => post.render(),
    setCamera: (c) => { scenePass.camera = c; },
    dispose: () => { post.dispose(); },
  };
}
