/**
 * Camera settings (docs/15-camera.md): film back, sensor fit, lens and depth
 * of field, and the field of view they give the viewport's perspective camera.
 */
import type { Camera, CameraPose, CameraSettings, FilmBack, Project, Vec3 } from './types';
import { mergeWorld, normalizeWorld, type WorldPatch } from './world';

export const FILM_BACKS: { id: string; label: string; width: number; height: number }[] = [
  { id: 'full-frame', label: 'Full frame 36 × 24', width: 36, height: 24 },
  { id: 'aps-c', label: 'APS-C 23.6 × 15.7', width: 23.6, height: 15.7 },
  { id: 'm43', label: 'Micro 4/3 17.3 × 13', width: 17.3, height: 13 },
  { id: 'phone', label: 'Phone 1/1.7″ 7.6 × 5.7', width: 7.6, height: 5.7 },
  { id: 'medium', label: 'Medium format 43.8 × 32.9', width: 43.8, height: 32.9 },
];
export const LENSES = [14, 18, 24, 35, 50, 85, 135, 200];
export const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];

export function defaultCamera(): CameraSettings {
  return { filmBack: { width: 36, height: 24 }, focalLength: 50, dof: { enabled: false, focusDistance: 3000, fStop: 2.8 }, frame: { show: true, passepartout: 0.5 } };
}

export const DEFAULT_POSE: CameraPose = { position: { x: 2200, y: 1600, z: 3000 }, target: { x: 0, y: 400, z: 0 } };

/**
 * The camera looked through (docs/36-camera-world.md): the viewport always looks through one, so this never returns
 * null — the first camera when `activeCamera` is stale, a default camera on a (transient) project without any.
 */
export function activeCameraOf(project: Pick<Project, 'cameras' | 'activeCamera'>): Camera {
  return project.cameras.find((c) => c.id === project.activeCamera) ?? project.cameras[0] ?? normalizeCamera({ id: 'camera-1', name: 'Camera 1' });
}

/** A camera object with defaults for anything missing (also how stored ones are read); a missing world is the default world. */
export function normalizeCamera(raw: Partial<Camera> & { id: string }): Camera {
  const d = defaultCamera();
  const v3 = (v: Partial<Vec3> | undefined, def: Vec3): Vec3 => ({ x: v?.x ?? def.x, y: v?.y ?? def.y, z: v?.z ?? def.z });
  return {
    id: raw.id, name: raw.name ?? raw.id,
    filmBack: { ...d.filmBack, ...(raw.filmBack ?? {}) }, focalLength: raw.focalLength ?? d.focalLength,
    dof: { ...d.dof, ...(raw.dof ?? {}) }, frame: { ...d.frame, ...(raw.frame ?? {}) },
    pose: { position: v3(raw.pose?.position, DEFAULT_POSE.position), target: v3(raw.pose?.target, DEFAULT_POSE.target) },
    world: normalizeWorld(raw.world),
  };
}

const deg = (rad: number) => (rad * 180) / Math.PI;
const filmAspect = (film: FilmBack) => Math.max(1, film.width) / Math.max(1, film.height);

/** The camera's own field of view (degrees): the frame shows exactly this. */
export function cameraFov(cam: CameraSettings): { horizontal: number; vertical: number } {
  const f = Math.max(1, cam.focalLength);
  return { horizontal: deg(2 * Math.atan(Math.max(1, cam.filmBack.width) / (2 * f))), vertical: deg(2 * Math.atan(Math.max(1, cam.filmBack.height) / (2 * f))) };
}

/**
 * The camera frame inside a viewport of `width × height` px: the film-back aspect inscribed (full height on a
 * wider viewport, full width on a taller one) — Blender's camera view. What lies outside is extra.
 */
export function frameRect(cam: CameraSettings, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const film = filmAspect(cam.filmBack);
  if (width / Math.max(1, height) >= film) { const w = height * film; return { x: (width - w) / 2, y: 0, w, h: height }; }
  const h = width / film; return { x: 0, y: (height - h) / 2, w: width, h };
}

/** Vertical field of view (degrees) of the viewport camera so that the frame shows the camera's own view. */
export function verticalFov(cam: CameraSettings, aspect: number): number {
  const width = 1000 * Math.max(0.01, aspect), height = 1000;
  const frame = frameRect(cam, width, height);
  const half = Math.tan((cameraFov(cam).vertical * Math.PI) / 360) * (height / frame.h);
  return deg(2 * Math.atan(half));
}

/** Horizontal field of view (degrees) of the viewport camera. */
export function horizontalFov(cam: CameraSettings, aspect: number): number {
  return deg(2 * Math.atan(Math.tan((verticalFov(cam, aspect) * Math.PI) / 360) * aspect));
}

/**
 * Depth-of-field blur range (mm) for three's dof node: the distance from the focus plane at which the
 * circle of confusion reaches `blurCoc` on the sensor (thin lens, the sensor scaled from full frame).
 */
export function dofRange(cam: CameraSettings, blurCoc = 0.03 * 6): number {
  const f = Math.max(1, cam.focalLength), N = Math.max(0.7, cam.dof.fStop), D = Math.max(f + 1, cam.dof.focusDistance);
  const c = blurCoc * (Math.max(1, cam.filmBack.height) / 24);
  return Math.max(10, (D * (D - f) * N * c) / (f * f));
}

/**
 * The size of a still (docs/32-render-on-demand.md): `width` px wide (256..8192, default 3840), the film-back
 * aspect of the looked-through camera — or the viewport's aspect while the view is orthographic (`cam` null).
 */
export function stillSize(cam: CameraSettings | null, viewportAspect: number, width = 3840): { width: number; height: number } {
  const w = Math.round(Math.min(8192, Math.max(256, Number.isFinite(width) ? width : 3840)));
  const aspect = cam ? filmAspect(cam.filmBack) : Math.max(0.05, viewportAspect || 1.5);
  return { width: w, height: Math.max(1, Math.round(w / aspect)) };
}

export function describeCamera(cam: CameraSettings): string {
  const fov = cameraFov(cam);
  const dof = cam.dof.enabled ? ` · DOF focus ${Math.round(cam.dof.focusDistance)} mm f/${cam.dof.fStop}` : '';
  return `${cam.focalLength} mm on ${cam.filmBack.width}×${cam.filmBack.height} · ${fov.horizontal.toFixed(1)}°×${fov.vertical.toFixed(1)}°${dof}${cam.frame.show ? ` · frame ${Math.round(cam.frame.passepartout * 100)}%` : ' · no frame'}`;
}

/** `world`: a patch merged onto the camera's world (docs/36-camera-world.md; `null` — the old "back to the project's" — is ignored). */
export interface CameraPatch { name?: string; filmBack?: Partial<FilmBack>; focalLength?: number; dof?: Partial<CameraSettings['dof']>; frame?: Partial<CameraSettings['frame']>; pose?: Partial<CameraPose>; world?: WorldPatch | null }

/** A camera patch merged onto a camera (nested objects merge one level down). */
export function mergeCamera(cam: Camera, patch: CameraPatch): Camera {
  return {
    ...cam,
    name: patch.name ?? cam.name,
    filmBack: { ...cam.filmBack, ...(patch.filmBack ?? {}) },
    focalLength: patch.focalLength ?? cam.focalLength,
    dof: { ...cam.dof, ...(patch.dof ?? {}) },
    frame: { ...cam.frame, ...(patch.frame ?? {}) },
    pose: { position: patch.pose?.position ?? cam.pose.position, target: patch.pose?.target ?? cam.pose.target },
    world: patch.world ? mergeWorld(cam.world, patch.world) : cam.world,
  };
}

