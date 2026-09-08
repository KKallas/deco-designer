/**
 * Example products built through the commands API (docs/07-headless-api.md).
 * Used by the toolbar ("Examples") and by the tests; everything is appended
 * to the open project as one undo step per command and grouped into an object.
 */
import type { Store } from './store';
import { addCurve, addGroup, addLoft, addPlane, addVertex, exitEdit, renameCurve, renameGroup, renamePlane, setCurveProfile, setPlanePlacement, updateLoft } from './commands';
import { DEFAULT_PROFILES } from '../model/defaults';
import type { Id, Vec2, Vec3 } from '../model/types';

export interface PostOptions { width?: number; height?: number; origin?: Vec3; name?: string }
export interface Post { group: Id; planes: Record<'bottom' | 'top' | 'front' | 'back', Id>; edges: Record<string, Id>; walls: Record<string, Id> }

export const POST_VERTICAL_EDGES = ['front-left', 'front-right', 'back-left', 'back-right'];

/** The project's round tube profile (added from the defaults if the project has none). */
function roundTubeProfile(store: Store): Id {
  const existing = store.project.profiles.find((p) => p.id === 'round15');
  if (existing) return existing.id;
  const def = DEFAULT_PROFILES.find((p) => p.id === 'round15')!;
  store.update((s) => { s.project.profiles.push({ ...def, params: { ...def.params }, limits: { ...def.limits } }); });
  return def.id;
}

/**
 * Square post: `width` × `width` footprint, `height` tall, standing on y = 0 at
 * `origin`. All twelve outline edges are straight round tubes (one open
 * two-vertex curve each — welded corners, so no bend limit applies); the four
 * side walls are lofts between their vertical edges. Everything is grouped.
 */
export function buildPost(store: Store, opts: PostOptions = {}): Post {
  const W = opts.width ?? 400, H = opts.height ?? 3000, o = opts.origin ?? { x: 0, y: 0, z: 0 };
  const tubeProfile = roundTubeProfile(store);

  // Planes: two horizontal (Top preset, normal +Y) for the bottom / top outlines,
  // two vertical (Front preset, normal +Z) at z = ±W/2 carrying the vertical edges.
  const plane = (preset: 'top' | 'front', name: string, at: Vec3): Id => {
    const id = addPlane(store, preset);
    renamePlane(store, id, name);
    setPlanePlacement(store, id, { position: { x: o.x + at.x, y: o.y + at.y, z: o.z + at.z } });
    return id;
  };
  const bottom = plane('top', 'Bottom', { x: 0, y: 0, z: 0 });
  const top = plane('top', 'Top', { x: 0, y: H, z: 0 });
  const front = plane('front', 'Front', { x: 0, y: 0, z: W / 2 });
  const back = plane('front', 'Back', { x: 0, y: 0, z: -W / 2 });

  // One straight tube = one open two-vertex curve.
  const tube = (planeId: Id, name: string, a: Vec2, b: Vec2): Id => {
    const id = addCurve(store, planeId);
    renameCurve(store, id, name);
    setCurveProfile(store, id, tubeProfile);
    addVertex(store, id, a);
    addVertex(store, id, b);
    exitEdit(store);
    return id;
  };
  const h = W / 2;
  // Top-preset planes map local (x, y) → world (x, 0, −y): local −y is world +z (front).
  const outline = (planeId: Id, prefix: string) => ({
    [`${prefix.toLowerCase()}-front`]: tube(planeId, `${prefix} front`, { x: -h, y: -h }, { x: h, y: -h }),
    [`${prefix.toLowerCase()}-back`]: tube(planeId, `${prefix} back`, { x: -h, y: h }, { x: h, y: h }),
    [`${prefix.toLowerCase()}-left`]: tube(planeId, `${prefix} left`, { x: -h, y: -h }, { x: -h, y: h }),
    [`${prefix.toLowerCase()}-right`]: tube(planeId, `${prefix} right`, { x: h, y: -h }, { x: h, y: h }),
  });
  const edges: Record<string, Id> = {
    ...outline(bottom, 'Bottom'),
    ...outline(top, 'Top'),
    'front-left': tube(front, 'Front left', { x: -h, y: 0 }, { x: -h, y: H }),
    'front-right': tube(front, 'Front right', { x: h, y: 0 }, { x: h, y: H }),
    'back-left': tube(back, 'Back left', { x: -h, y: 0 }, { x: -h, y: H }),
    'back-right': tube(back, 'Back right', { x: h, y: 0 }, { x: h, y: H }),
  };

  // Side walls: a loft between the two vertical edges of each face.
  const wall = (name: string, a: Id, b: Id): Id => {
    const id = addLoft(store, a, b);
    if (!id) throw new Error(`loft ${name} failed`);
    updateLoft(store, id, { name });
    return id;
  };
  const walls = {
    front: wall('Front wall', edges['front-left'], edges['front-right']),
    back: wall('Back wall', edges['back-left'], edges['back-right']),
    left: wall('Left wall', edges['front-left'], edges['back-left']),
    right: wall('Right wall', edges['front-right'], edges['back-right']),
  };

  const group = addGroup(store, [bottom, top, front, back]);
  if (!group) throw new Error('group failed');
  renameGroup(store, group, opts.name ?? 'Post');
  return { group, planes: { bottom, top, front, back }, edges, walls };
}
