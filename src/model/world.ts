/**
 * The world (docs/16-world.md): background, environment lighting, one sun
 * and the exposure — every camera carries one, the viewport shows the active
 * camera's (docs/36-camera-world.md). Plain data helpers; the scene side is
 * src/view3d/world.ts.
 */
import type { Animation, CurvePixels, Id, Playback, Project, Vec3, World, WorldBackground, WorldEmitters, WorldEnvironment, WorldSun } from './types';

export const DEFAULT_BACKGROUND = '#141416';

/** Today's viewport look: the dark grey, the studio room in the reflections, a sun from the front right. */
export function defaultWorld(): World {
  return {
    background: { kind: 'color', color: DEFAULT_BACKGROUND },
    environment: { kind: 'room' },
    strength: 1,
    rotation: 0,
    sun: { enabled: true, azimuth: 55, elevation: 47, color: '#ffffff', strength: 2, shadows: false },
    exposure: 1,
    emitters: defaultEmitters(),
  };
}

/** Emissive geometry lighting the scene (docs/17-emitters.md): off until asked for — the bake costs. */
export function defaultEmitters(): WorldEmitters {
  return { enabled: false, probeSpacing: 250, visibility: true, strength: 1 };
}

const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const hex = (v: unknown, d: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const id = (v: unknown): Id => (typeof v === 'string' && v ? v : '');

export function normalizeBackground(raw: unknown): WorldBackground {
  const r = (raw ?? {}) as Partial<{ kind: string; color: string; texture: string; blur: number }>;
  if (r.kind === 'hdr') return { kind: 'hdr', texture: id(r.texture), blur: num(r.blur, 0, 0, 1) };
  return { kind: 'color', color: hex(r.color, DEFAULT_BACKGROUND) };
}

export function normalizeEnvironment(raw: unknown): WorldEnvironment {
  const r = (raw ?? {}) as Partial<{ kind: string; color: string; texture: string }>;
  if (r.kind === 'none') return { kind: 'none' };
  if (r.kind === 'color') return { kind: 'color', color: hex(r.color, '#808080') };
  if (r.kind === 'hdr') return { kind: 'hdr', texture: id(r.texture) };
  return { kind: 'room' };
}

export function normalizeSun(raw: unknown): WorldSun {
  const d = defaultWorld().sun, r = (raw ?? {}) as Partial<WorldSun>;
  return { enabled: r.enabled ?? d.enabled, azimuth: num(r.azimuth, d.azimuth), elevation: num(r.elevation, d.elevation, -90, 90), color: hex(r.color, d.color), strength: num(r.strength, d.strength, 0), shadows: r.shadows ?? d.shadows };
}

export function normalizeEmitters(raw: unknown): WorldEmitters {
  const d = defaultEmitters(), r = (raw ?? {}) as Partial<WorldEmitters>;
  return { enabled: r.enabled ?? d.enabled, probeSpacing: num(r.probeSpacing, d.probeSpacing, 50, 2000), visibility: r.visibility ?? d.visibility, strength: num(r.strength, d.strength, 0) };
}

/** A pixel animation of any shape brought to the current one (docs/17-emitters.md). */
export function normalizeAnimation(raw: Partial<Animation> & { id: Id }): Animation {
  return { id: raw.id, name: raw.name ?? raw.id, texture: id(raw.texture), fps: num(raw.fps, 30, 0.1, 240), frames: Math.max(0, Math.round(num(raw.frames, 0, 0))), width: Math.max(0, Math.round(num(raw.width, 0, 0))) };
}

/** A curve's fixture patch brought to the current shape (docs/17-emitters.md). */
export function normalizePixels(raw: unknown): CurvePixels {
  const r = (raw ?? {}) as Partial<CurvePixels>;
  return { chains: Math.min(3, Math.max(1, Math.round(num(r.chains, 1, 1, 3)))), animation: r.animation ?? null, offset: Math.max(0, Math.round(num(r.offset, 0, 0))), reverse: !!r.reverse };
}

export function defaultPlayback(): Playback {
  return { playing: false, loop: true, start: 0, end: null };
}

/** A stored clock of any shape brought to the current one (docs/22-transport-in-out.md). */
export function normalizePlayback(raw: unknown): Playback {
  const d = defaultPlayback(), r = (raw ?? {}) as Partial<Playback>;
  const start = Math.max(0, num(r.start, d.start));
  const end = r.end == null ? null : Math.max(start + 0.01, num(r.end, start + 1));
  return { playing: !!r.playing, loop: r.loop ?? d.loop, start, end };
}

/** A world of any shape (stored, patched, missing) brought to the current one. */
export function normalizeWorld(raw: unknown): World {
  const d = defaultWorld(), r = (raw ?? {}) as Partial<World>;
  return {
    background: normalizeBackground(r.background ?? d.background),
    environment: normalizeEnvironment(r.environment ?? d.environment),
    strength: num(r.strength, d.strength, 0),
    rotation: num(r.rotation, d.rotation),
    sun: normalizeSun(r.sun ?? d.sun),
    exposure: num(r.exposure, d.exposure, 0),
    emitters: normalizeEmitters(r.emitters ?? d.emitters),
  };
}

/** A patch: nested objects merge one level down; a `kind` change keeps what the new kind can use and fills the rest. */
export interface WorldPatch { background?: Partial<WorldBackground> & { kind?: WorldBackground['kind'] }; environment?: Partial<WorldEnvironment> & { kind?: WorldEnvironment['kind'] }; strength?: number; rotation?: number; sun?: Partial<WorldSun>; exposure?: number; emitters?: Partial<WorldEmitters> }

export function mergeWorld(w: World, patch: WorldPatch): World {
  return normalizeWorld({
    background: patch.background ? { ...w.background, ...patch.background } : w.background,
    environment: patch.environment ? { ...w.environment, ...patch.environment } : w.environment,
    strength: patch.strength ?? w.strength,
    rotation: patch.rotation ?? w.rotation,
    sun: patch.sun ? { ...w.sun, ...patch.sun } : w.sun,
    exposure: patch.exposure ?? w.exposure,
    emitters: patch.emitters ? { ...w.emitters, ...patch.emitters } : w.emitters,
  });
}

/** HDR textures a world uses (background and environment). */
export function worldTextures(w: World): Id[] {
  const out = new Set<Id>();
  if (w.background.kind === 'hdr' && w.background.texture) out.add(w.background.texture);
  if (w.environment.kind === 'hdr' && w.environment.texture) out.add(w.environment.texture);
  return [...out];
}

/** Unit vector from the origin towards the sun. */
export function sunDirection(sun: WorldSun): Vec3 {
  const az = (sun.azimuth * Math.PI) / 180, el = (sun.elevation * Math.PI) / 180;
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: Math.cos(az) * Math.cos(el) };
}

export const HDR_MIMES: Record<string, string> = { hdr: 'image/vnd.radiance', exr: 'image/x-exr' };
export function isHdrMime(mime: string): boolean { return mime === HDR_MIMES.hdr || mime === HDR_MIMES.exr; }

export function describeWorld(w: World, project?: Pick<Project, 'textures'>): string {
  const tex = (tid: Id) => { const t = project?.textures.find((x) => x.id === tid); return project ? (t ? `${tid} "${t.name}"` : `${tid || '?'} (missing)`) : tid; };
  const bg = w.background.kind === 'hdr' ? `HDR ${tex(w.background.texture)}${w.background.blur ? ` blur ${w.background.blur}` : ''}` : w.background.color;
  const env = w.environment.kind === 'none' ? 'none' : w.environment.kind === 'room' ? 'studio room' : w.environment.kind === 'color' ? w.environment.color : `HDR ${tex(w.environment.texture)}`;
  const sun = w.sun.enabled ? `sun ${w.sun.strength} at ${w.sun.azimuth}°/${w.sun.elevation}°${w.sun.shadows ? ' shadows' : ''}` : 'no sun';
  const em = w.emitters.enabled ? ` · emitters ×${w.emitters.strength} (probes ${w.emitters.probeSpacing} mm${w.emitters.visibility ? ', shadows' : ''})` : '';
  return `background ${bg} · environment ${env}${w.environment.kind !== 'none' ? ` ×${w.strength}` : ''}${w.rotation ? ` rot ${w.rotation}°` : ''} · ${sun} · exposure ${w.exposure}${em}`;
}
