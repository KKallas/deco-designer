/**
 * Post-processing presets (docs/15-camera.md §3): programs `(post, params) =>
 * outputNode` with their knobs. "Eevee glow" is the project default.
 */
import type { PostProgram } from './types';

const EEVEE = `// Post-processing (docs/15-camera.md): (post, params) => the final image node.
// post.scene: color (HDR) / emissive / viewZ · post.ssr / bloom / lensflare / streaks / dof · post.tsl (the TSL namespace).
// Knobs: reflections ≥ 0 (the lamps mirrored in the metals, docs/31-ssr.md; 0 = off), threshold ≥ 0 (what glows),
// knee 0..1 (soft onset), radius 0..1 (0.3 halos … 1 fog), strength ≥ 0, flare / streaks ≥ 0 (share of the glow),
// streakLength 0..0.5 (of the screen), bokeh ≥ 0 (DOF blur size).
(post, params) => {
  const { tsl, scene } = post;
  // the reflections first, so a reflected lamp is hot enough to glow
  let base = scene.color;
  if (params.reflections > 0) base = post.ssr(base, { intensity: params.reflections });
  // what glows: the emissive channel (LED tips) and whatever the colour clips above 1 (hot reflections)
  const source = tsl.vec4(scene.emissive.rgb.add(tsl.max(base.rgb.sub(1), 0)), 1);
  const glow = post.bloom(source, params.strength, params.radius, params.threshold, params.knee);
  let out = base.add(glow);
  if (params.streaks > 0) out = out.add(post.streaks(glow, params.streakLength).mul(params.streaks));
  if (params.flare > 0) out = out.add(post.lensflare(glow).mul(params.flare));
  if (post.camera.dof) out = post.dof(out, params.bokeh);
  return out;
}`;

/** The Part 15 Eevee code, verbatim: a project still carrying it untouched is refreshed to EEVEE on load (docs/31-ssr.md §3). */
export const EEVEE_V15 = `// Post-processing (docs/15-camera.md): (post, params) => the final image node.
// post.scene: color (HDR) / emissive / viewZ · post.bloom / lensflare / streaks / dof · post.tsl (the TSL namespace).
// Knobs: threshold ≥ 0 (what glows), knee 0..1 (soft onset), radius 0..1 (0.3 halos … 1 fog), strength ≥ 0,
// flare / streaks ≥ 0 (share of the glow), streakLength 0..0.5 (of the screen), bokeh ≥ 0 (DOF blur size).
(post, params) => {
  const { tsl, scene } = post;
  // what glows: the emissive channel (LED tips) and whatever the colour clips above 1 (hot reflections)
  const source = tsl.vec4(scene.emissive.rgb.add(tsl.max(scene.color.rgb.sub(1), 0)), 1);
  const glow = post.bloom(source, params.strength, params.radius, params.threshold, params.knee);
  let out = scene.color.add(glow);
  if (params.streaks > 0) out = out.add(post.streaks(glow, params.streakLength).mul(params.streaks));
  if (params.flare > 0) out = out.add(post.lensflare(glow).mul(params.flare));
  if (post.camera.dof) out = post.dof(out, params.bokeh);
  return out;
}`;

const BLOOM_ONLY = `// Bloom on the emissive channel only.
(post, params) => {
  const glow = post.bloom(post.scene.emissive, params.strength, params.radius, params.threshold, params.knee);
  return post.scene.color.add(glow);
}`;

const DOF_ONLY = `// Depth of field from the camera settings, nothing else.
(post, params) => (post.camera.dof ? post.dof(post.scene.color, params.bokeh) : post.scene.color)`;

const PLAIN = `// The plain image (still through the pipeline: AgX view transform and the environment).
(post) => post.scene.color`;

export const POST_PRESETS: (Omit<PostProgram, 'enabled'> & { id: string })[] = [
  { id: 'eevee', label: 'Eevee glow', code: EEVEE, params: { reflections: 1, threshold: 0.8, knee: 0.5, radius: 0.45, strength: 1.2, flare: 0.3, streaks: 0.7, streakLength: 0.1, bokeh: 1 } },
  { id: 'bloom', label: 'Bloom only', code: BLOOM_ONLY, params: { threshold: 0.8, knee: 0.5, radius: 0.6, strength: 1 } },
  { id: 'dof', label: 'Depth of field only', code: DOF_ONLY, params: { bokeh: 1 } },
  { id: 'plain', label: 'No effects', code: PLAIN, params: {} },
];

export function defaultPost(): PostProgram {
  const p = POST_PRESETS[0];
  return { enabled: true, label: p.label, code: p.code, params: { ...p.params } };
}
