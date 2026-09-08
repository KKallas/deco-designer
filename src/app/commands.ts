/**
 * Every change to the project goes through one of these named commands.
 * `live` variants (drags) skip undo history until the final call.
 */
import {
  NO_LOFT_EDGE, clone, defaultPlaneImage, findCurve, findGroup, findLoft, findShape, findPlane, flattenCurve, groupChain, groupOfPlane, groupPlacement, loftEdge, newCurve, newOutlineLayer, newPlane, newShapeLayer, normalizeLoftEdge, normalizeOutlineLayer, normalizeShape, normalizeShapeLayer, normalizePlaneImage, parentOfGroup, placementFor,
  normalizeArray, subtreeGroups, subtreePlanes, uid, uniqueId, vertex, wouldCycle, PLANE_PRESETS,
  type ArrayModifier, type CheckIdLike, type ConstraintType, type CurveObject, type CurveType, type Fill, type Id, type Loft, type LoftEdge, type ObjectGroup, type OutlineLayer, type Placement, type PlaneImage, type PlanePreset, type Shape, type ShapeLayer, type Vec2, type Vec3, type VertexType,
} from '../model/types';
import { fromPlane, groupMatrix, localPlacement, planeMatrix, planeWorld } from '../geometry/placement';
import { fillHandles, mirrorHandle, vec } from '../model/handles';
import { findMaterial, findTexture, slug, type Material, type Profile, type Texture } from '../model/types';
import { cloneProfile } from '../model/profiles';
import { cloneFill } from '../model/fills';
import { mergeCamera, normalizeCamera, type CameraPatch } from '../model/camera';
import { normalizeAnimation, normalizePixels, normalizePlayback, type WorldPatch } from '../model/world';
import { findAnimation, pixelCount, type Animation, type CurvePixels, type Playback } from '../model/types';
import type { Camera, CameraPose, PostProgram } from '../model/types';
import { isPinned, solveConstraints } from '../model/constraints';
import { sampleCurve, splitCurveAt } from '../geometry/curve';
import { cornerJoin, filletCorner, intersections, offsetCurve as offsetCurveGeo, trimPieces } from '../geometry/modify';
import { commitArray as commitArrayCurves } from '../geometry/array';
import { projectCurve } from '../geometry/project';
import { NO_SELECTION, type ArrayHandle, type State, type Store } from './store';
import { insertGroup } from './insert';
import { insertItem } from './archive';

const cv = (store: Store, id: Id): CurveObject => {
  const c = findCurve(store.project, id);
  if (!c) throw new Error(`no curve ${id}`);
  return c;
};
/** A one-id command applied to several at once (docs/35-outliner-multi-edit.md §5). */
const idsOf = (id: Id | Id[]): Id[] => (Array.isArray(id) ? id : [id]);
/** A placement patch: any of the three parts, each part any of its components (the rest stay). */
export type PlacementPatch = { preset?: Placement['preset']; position?: Partial<Vec3>; rotation?: Partial<Vec3> };
const vtx = (c: CurveObject, vid: Id) => c.curve.points.find((v) => v.id === vid) ?? null;
const vidx = (c: CurveObject, vid: Id) => c.curve.points.findIndex((v) => v.id === vid);

export function snapGrid(store: Store, p: Vec2, grid = 10, force?: boolean): Vec2 {
  const snap = force ?? store.state.snap;
  if (!snap) return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
}

// -- planes ------------------------------------------------------------------

export function addPlane(store: Store, preset: PlanePreset): Id {
  const label = PLANE_PRESETS[preset].label.split(' ')[0];
  const plane = newPlane(label, placementFor(preset), store.project.planes.map((p) => p.id));
  plane.name = plane.id === label.toLowerCase() ? label : `${label} ${plane.id.split('-').pop()}`;
  store.update((s) => { s.project.planes.push(plane); s.selection = { ...NO_SELECTION, planeId: plane.id, planeSelected: true }; });
  return plane.id;
}

export function selectPlane(store: Store, planeId: Id | null): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, planeId, planeSelected: planeId !== null }; }, { history: false });
}

export function renamePlane(store: Store, planeId: Id | Id[], name: string): void {
  store.update((s) => { for (const id of idsOf(planeId)) { const p = findPlane(s.project, id); if (p) p.name = name; } });
}

/** Select planes (docs/35 §2): the last is the primary — the active plane, the one the gizmo sits on. None keeps the active plane. */
export function selectPlanes(store: Store, ids: Id[]): void {
  store.update((s) => {
    const planes = ids.filter((id, i) => findPlane(s.project, id) && ids.indexOf(id) === i);
    s.selection = { ...NO_SELECTION, planes, planeId: planes.length ? planes[planes.length - 1] : s.selection.planeId, planeSelected: planes.length > 0 };
  }, { history: false });
}

export function removePlane(store: Store, planeId: Id): void {
  store.update((s) => {
    const gone = new Set(s.project.curves.filter((c) => c.planeId === planeId).map((c) => c.id));
    s.project.planes = s.project.planes.filter((p) => p.id !== planeId);
    s.project.curves = s.project.curves.filter((c) => c.planeId !== planeId);
    dropShapeCurves(s, (curve) => gone.has(curve));
    if (s.selection.planeId === planeId) s.selection = { ...NO_SELECTION };
  });
}

export function setPlanePlacement(store: Store, planeId: Id | Id[], patch: PlacementPatch): void {
  store.update((s) => {
    for (const id of idsOf(planeId)) {
      const p = findPlane(s.project, id);
      if (!p) continue;
      if (patch.position) p.placement.position = { ...p.placement.position, ...patch.position };
      if (patch.rotation) { p.placement.rotation = { ...p.placement.rotation, ...patch.rotation }; p.placement.preset = 'custom'; }
      if (patch.preset && patch.preset !== 'custom') { p.placement.preset = patch.preset; p.placement.rotation = { ...PLANE_PRESETS[patch.preset].rotation }; }
    }
  });
}

export function movePlane(store: Store, planeId: Id, position: Vec3, live: boolean): void {
  store.update((s) => { const p = findPlane(s.project, planeId); if (p) p.placement.position = { ...position }; }, { history: !live });
}

/** The plane's array (docs/26-array.md); `live` (a handle being dragged) waits for the drag to end. */
export function setPlaneModifier(store: Store, planeId: Id, mod: ArrayModifier | null, live = false): void {
  store.update((s) => {
    const p = findPlane(s.project, planeId);
    if (!p) return;
    p.array = normalizeArray(mod);
    if (!p.array) s.selection.arrayHandle = null;
  }, { history: !live });
}

/** Pick one of the array's handles in the viewport (docs/26-array.md §3); the gizmo moves to it. */
export function selectArrayHandle(store: Store, handle: ArrayHandle | null): void {
  store.update((s) => { s.selection.arrayHandle = handle; }, { history: false });
}

/**
 * Bake the plane's array into real curves (docs/26-array.md §4): every copy becomes a
 * curve object on the same plane (spatial when it left the plane), ends meeting within
 * `merge` mm are welded, and the modifier is cleared. One undo step; returns the ids.
 */
export function commitArray(store: Store, planeId: Id, opts: { merge?: number } = {}): Id[] {
  const plane = findPlane(store.project, planeId);
  if (!plane) return [];
  const mine = store.project.curves.filter((c) => c.planeId === planeId);
  const others = store.project.curves.filter((c) => c.planeId !== planeId);
  const result = commitArrayCurves(plane.array, mine, opts.merge ?? 0, others.map((c) => c.id));
  store.update((s) => {
    const p = findPlane(s.project, planeId)!;
    p.array = null;
    // a loft on a curve that was welded away loses an end; `validate` drops it (docs/05-loft.md §2)
    s.project.curves = [...others, ...result];
    s.selection = { ...NO_SELECTION, curves: result.map((c) => c.id), planeId };
  });
  return result.map((c) => c.id);
}

/**
 * The plane's reference image (docs/19-reference-image.md): a patch, or `null` to remove it.
 * On a plane that has none, `texture` starts one with the defaults. `live` (a drag in progress)
 * keeps it out of the undo history until the drag ends.
 */
export function setPlaneImage(store: Store, planeId: Id, patch: (Partial<PlaneImage> & { texture?: Id }) | null, live = false): void {
  store.update((s) => {
    const p = findPlane(s.project, planeId);
    if (!p) return;
    if (!patch) { p.image = null; return; }
    const base = p.image ?? (patch.texture ? defaultPlaneImage(patch.texture) : null);
    if (!base) return;
    p.image = normalizePlaneImage({ ...base, ...patch }, s.project.textures);
  }, { history: !live });
}

// -- objects (groups of planes and of objects — docs/18-nested-objects.md) --------

/** What a new object is made of: planes and objects that share one parent. */
export interface GroupMembers { planes?: Id[]; groups?: Id[]; name?: string }

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scaleAbout = (p: Vec3, pivot: Vec3, k: number): Vec3 => ({ x: pivot.x + (p.x - pivot.x) * k, y: pivot.y + (p.y - pivot.y) * k, z: pivot.z + (p.z - pivot.z) * k });

/** The preset a plane rotation matches, else 'custom'. */
function presetFor(rotation: Vec3): PlanePreset | 'custom' {
  const same = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
  return (Object.keys(PLANE_PRESETS) as PlanePreset[]).find((k) => same(PLANE_PRESETS[k].rotation, rotation)) ?? 'custom';
}

/** World-space bounds centre of everything on these planes and in these objects (their origins when there are no vertices). */
function membersCenter(store: Store, planes: Id[], groups: Id[]): Vector3 {
  const { project } = store;
  const pids = [...planes, ...groups.flatMap((id) => { const g = findGroup(project, id); return g ? subtreePlanes(project, g) : []; })];
  const pts: Vector3[] = [];
  for (const pid of pids) {
    const pl = findPlane(project, pid);
    if (!pl) continue;
    const f = planeWorld(project, pl);
    const verts = project.curves.filter((c) => c.planeId === pid).flatMap((c) => c.curve.points);
    if (verts.length) for (const v of verts) pts.push(fromPlane(f, v));
    else pts.push(f.origin.clone());
  }
  if (!pts.length) return new Vector3();
  const min = pts[0].clone(), max = pts[0].clone();
  for (const p of pts) { min.min(p); max.max(p); }
  return min.add(max).multiplyScalar(0.5);
}

/**
 * Make an object from planes and objects (docs/18-nested-objects.md §3). They must share one
 * parent — the first member's — and the new object takes that parent. Its origin is the bounds
 * centre of its contents and their placements are rebased into it, so nothing moves.
 */
export function addGroup(store: Store, arg: Id[] | GroupMembers): Id | null {
  const { project } = store;
  const req = Array.isArray(arg) ? { planes: arg } : arg;
  const wantPlanes = (req.planes ?? []).filter((id) => findPlane(project, id));
  const wantGroups = (req.groups ?? []).filter((id) => findGroup(project, id));
  if (!wantPlanes.length && !wantGroups.length) return null;
  const parent = wantPlanes.length ? groupOfPlane(project, wantPlanes[0])?.id ?? null : parentOfGroup(project, wantGroups[0])?.id ?? null;
  const planes = wantPlanes.filter((id) => (groupOfPlane(project, id)?.id ?? null) === parent);
  const groups = wantGroups.filter((id) => (parentOfGroup(project, id)?.id ?? null) === parent);
  if (!planes.length && !groups.length) return null;
  const n = project.groups.length + 1;
  const id = uniqueId(`object-${n}`, project.groups.map((g) => g.id));
  const origin = membersCenter(store, planes, groups).applyMatrix4(groupMatrix(project, parent).invert());
  store.update((s) => {
    const g: ObjectGroup = { id, name: req.name ?? `Object ${n}`, planes: [...planes], groups: [...groups], placement: groupPlacement({ x: origin.x, y: origin.y, z: origin.z }), visible: true };
    // the members keep their world position: the new frame has no rotation, so only the origin moves
    for (const pid of planes) { const pl = findPlane(s.project, pid); if (pl) pl.placement.position = sub(pl.placement.position, g.placement.position); }
    for (const gid of groups) { const c = findGroup(s.project, gid); if (c) c.placement.position = sub(c.placement.position, g.placement.position); }
    const p = parent ? findGroup(s.project, parent) : null;
    if (p) { p.planes = p.planes.filter((x) => !planes.includes(x)); p.groups = p.groups.filter((x) => !groups.includes(x)); p.groups.push(id); }
    s.project.groups.push(g);
    s.selection = { ...NO_SELECTION, groups: [id] };
  });
  return id;
}

/**
 * ⌘G: make an object from the selection — the selected objects (they become children), the
 * selected plane, or the planes of the selected curves (docs/18-nested-objects.md §3).
 */
export function groupSelection(store: Store): Id | null {
  const { selection, project } = store.state;
  const planes = selection.planeSelected && selection.planeId
    ? [selection.planeId]
    : [...new Set(selection.curves.map((id) => findCurve(project, id)?.planeId).filter((x): x is Id => !!x))];
  if (!selection.groups.length && !planes.length) return null;
  return addGroup(store, { planes, groups: selection.groups });
}

/** Select objects; `additive` toggles one within the selection. */
export function selectGroup(store: Store, id: Id | null, additive = false): void {
  store.update((s) => {
    if (id === null) { s.selection = { ...NO_SELECTION }; return; }
    const cur = s.selection.groups;
    const groups = !additive ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    s.selection = { ...NO_SELECTION, groups };
  }, { history: false });
}

export function selectGroups(store: Store, ids: Id[]): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, groups: ids.filter((id) => findGroup(s.project, id)) }; }, { history: false });
}

export function renameGroup(store: Store, id: Id | Id[], name: string): void {
  store.update((s) => { for (const gid of idsOf(id)) { const g = findGroup(s.project, gid); if (g) g.name = name; } });
}

/** Show or hide objects (docs/18-nested-objects.md §4); children follow their ancestors. */
export function setGroupVisible(store: Store, ids: Id[], visible: boolean): void {
  store.update((s) => { for (const id of ids) { const g = findGroup(s.project, id); if (g) g.visible = visible; } });
}

/** The object's own frame; everything inside it moves with it. */
export function setGroupPlacement(store: Store, id: Id | Id[], patch: PlacementPatch, live = false): void {
  store.update((s) => {
    for (const gid of idsOf(id)) {
      const g = findGroup(s.project, gid);
      if (!g) continue;
      if (patch.position) g.placement.position = { ...g.placement.position, ...patch.position };
      if (patch.rotation) g.placement.rotation = { ...g.placement.rotation, ...patch.rotation };
    }
  }, { history: !live });
}

/** Move a plane into an object (or out of all objects with null); it keeps its world position. */
export function setPlaneGroup(store: Store, planeId: Id | Id[], groupId: Id | null): void {
  if (Array.isArray(planeId)) { store.batch(() => { for (const id of planeId) setPlaneGroup(store, id, groupId); }); return; }
  const pl = findPlane(store.project, planeId);
  if (!pl) return;
  const world = planeWorld(store.project, pl).matrix.clone();
  store.update((s) => {
    for (const g of s.project.groups) g.planes = g.planes.filter((p) => p !== planeId);
    const g = groupId ? findGroup(s.project, groupId) : null;
    if (g) g.planes.push(planeId);
    const p = findPlane(s.project, planeId);
    if (!p) return;
    const local = localPlacement(groupMatrix(s.project, g?.id ?? null), world);
    p.placement.position = local.position;
    p.placement.rotation = local.rotation;
    p.placement.preset = presetFor(local.rotation);
  });
}

/** Move an object into another one (null = top level); it keeps its world position. Cycles are refused. */
export function setGroupParent(store: Store, id: Id | Id[], parentId: Id | null): void {
  if (Array.isArray(id)) { store.batch(() => { for (const x of id) setGroupParent(store, x, parentId); }); return; }
  const g = findGroup(store.project, id);
  if (!g || (parentId && !findGroup(store.project, parentId)) || wouldCycle(store.project, id, parentId)) return;
  const world = groupMatrix(store.project, id).clone();
  store.update((s) => {
    for (const x of s.project.groups) x.groups = x.groups.filter((c) => c !== id);
    const p = parentId ? findGroup(s.project, parentId) : null;
    if (p) p.groups.push(id);
    const me = findGroup(s.project, id);
    if (!me) return;
    const local = localPlacement(groupMatrix(s.project, p?.id ?? null), world);
    me.placement.position = local.position;
    me.placement.rotation = local.rotation;
  });
}

/** Dissolve the object: its planes and child objects move up into its parent, its placement baked into theirs. */
export function ungroup(store: Store, id: Id): void {
  store.update((s) => {
    const g = findGroup(s.project, id);
    if (!g) return;
    const m = planeMatrix(g.placement);
    const parent = parentOfGroup(s.project, id);
    for (const pid of g.planes) {
      const pl = findPlane(s.project, pid);
      if (!pl) continue;
      const local = localPlacement(new Matrix4(), m.clone().multiply(planeMatrix(pl.placement)));
      pl.placement.position = local.position;
      pl.placement.rotation = local.rotation;
      pl.placement.preset = presetFor(local.rotation);
    }
    for (const cid of g.groups) {
      const c = findGroup(s.project, cid);
      if (!c) continue;
      const local = localPlacement(new Matrix4(), m.clone().multiply(planeMatrix(c.placement)));
      c.placement.position = local.position;
      c.placement.rotation = local.rotation;
    }
    if (parent) {
      parent.groups = parent.groups.filter((x) => x !== id);
      parent.planes.push(...g.planes);
      parent.groups.push(...g.groups);
    }
    s.project.groups = s.project.groups.filter((x) => x.id !== id);
    s.selection.groups = s.selection.groups.filter((x) => x !== id);
  });
}

/** Delete the object with everything in it: its child objects, planes, curves (and so their lofts). */
export function removeGroupContents(store: Store, id: Id): void {
  const g = findGroup(store.project, id);
  if (!g) return;
  const subtree = new Set(subtreeGroups(store.project, g).map((x) => x.id));
  const planes = new Set(subtreePlanes(store.project, g));
  store.update((s) => {
    const gone = new Set(s.project.curves.filter((c) => planes.has(c.planeId)).map((c) => c.id));
    s.project.curves = s.project.curves.filter((c) => !planes.has(c.planeId));
    dropShapeCurves(s, (curve) => gone.has(curve));
    s.project.planes = s.project.planes.filter((p) => !planes.has(p.id));
    s.project.groups = s.project.groups.filter((x) => !subtree.has(x.id));
    for (const x of s.project.groups) x.groups = x.groups.filter((c) => !subtree.has(c));
    s.selection = { ...NO_SELECTION };
  });
}

/** Duplicate the object and everything under it (child objects, planes, curves, constraints, lofts), shifted 200 mm in X. */
export function duplicateGroup(store: Store, id: Id): Id | null {
  const src = findGroup(store.project, id);
  if (!src) return null;
  let rootId: Id | null = null;
  store.update((s) => {
    // the same walk an archive item comes in through (docs/33-object-archive.md §6)
    const r = insertGroup(s.project, s.project, id, { into: parentOfGroup(s.project, id)?.id ?? null, offset: { x: 200 }, name: `${src.name} copy` });
    if (!r) return;
    rootId = r.root;
    s.selection = { ...NO_SELECTION, groups: [r.root] };
  });
  return rootId;
}

/** Bring an archive item (the parsed file) in under `into` — or as a root object — and select it (docs/33-object-archive.md §5). */
export function importItem(store: Store, raw: unknown, opts: { into?: Id | null } = {}): Id | null {
  let rootId: Id | null = null;
  store.update((s) => {
    const r = insertItem(s.project, raw, { into: opts.into ?? null });
    if (!r) return;
    rootId = r.root;
    s.mode = { kind: 'object' };
    s.selection = { ...NO_SELECTION, groups: [r.root] };
  });
  return rootId;
}

/** Drag-start state of the selected objects: their own placements, and everything inside them (for scale, which bakes). */
export interface GroupSnapshot { roots: Id[]; groups: Map<Id, Placement>; planes: Map<Id, Placement>; curves: Map<Id, CurveSnapshot> }

export function snapshotGroups(store: Store, ids: Id[]): GroupSnapshot | null {
  const { project } = store;
  // an object whose ancestor is selected too moves with it — transforming both would double the move
  const wanted = ids.filter((id) => findGroup(project, id));
  const roots = wanted.filter((id) => !groupChain(project, id).some((g) => g.id !== id && wanted.includes(g.id)));
  if (!roots.length) return null;
  const groups = new Map<Id, Placement>(), planes = new Map<Id, Placement>();
  for (const id of roots) {
    const g = findGroup(project, id)!;
    for (const x of subtreeGroups(project, g)) groups.set(x.id, clone(x.placement));
    for (const pid of subtreePlanes(project, g)) { const p = findPlane(project, pid); if (p) planes.set(pid, clone(p.placement)); }
  }
  const curves = project.curves.filter((c) => planes.has(c.planeId)).map((c) => c.id);
  return { roots, groups, planes, curves: snapshotCurves(store, curves) };
}

export function snapshotGroup(store: Store, id: Id): GroupSnapshot | null {
  return snapshotGroups(store, [id]);
}

/**
 * Transform whole objects from their drag-start snapshot (docs/18-nested-objects.md §3).
 * Move and rotate write the object's **own placement** (`world' = T · R(pivot) · world`), so
 * nothing inside it is touched. Uniform scale has no place in a rigid frame and is **baked**:
 * the contents move about the pivot and the curves scale with them.
 */
export function transformGroup(store: Store, snap: GroupSnapshot, t: { pivot: Vec3; translation: Vec3; rotation: { x: number; y: number; z: number; w: number }; scale: number }, live: boolean): void {
  const q = new Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
  const pivot = new Vector3(t.pivot.x, t.pivot.y, t.pivot.z);
  const T = new Matrix4().makeTranslation(t.translation.x, t.translation.y, t.translation.z)
    .multiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
    .multiply(new Matrix4().makeRotationFromQuaternion(q))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  store.update((s) => {
    // start every live frame from the drag-start state
    for (const [pid, pl] of snap.planes) { const p = findPlane(s.project, pid); if (p) p.placement = clone(pl); }
    for (const [gid, pl] of snap.groups) { const g = findGroup(s.project, gid); if (g && !snap.roots.includes(gid)) g.placement = clone(pl); }
    for (const [cid, cs] of snap.curves) { const c = findCurve(s.project, cid); if (c) { c.curve.points = clone(cs.points); c.constraints = clone(cs.constraints); } }

    for (const rootId of snap.roots) {
      const g = findGroup(s.project, rootId);
      const base = snap.groups.get(rootId);
      if (!g || !base) continue;
      const parentM = groupMatrix(s.project, parentOfGroup(s.project, rootId)?.id ?? null);
      const world = parentM.clone().multiply(planeMatrix(base));
      const local = localPlacement(parentM, T.clone().multiply(world));
      g.placement.position = local.position;
      g.placement.rotation = local.rotation;
      if (t.scale === 1) continue;
      // scale: about the pivot in the object's own frame for its direct contents, about each deeper frame's origin below
      const pivotLocal = pivot.clone().applyMatrix4(world.clone().invert());
      const inside = (x: ObjectGroup, about: Vec3): void => {
        for (const pid of x.planes) {
          const p = findPlane(s.project, pid), b = snap.planes.get(pid);
          if (p && b) p.placement.position = scaleAbout(b.position, about, t.scale);
        }
        for (const cid of x.groups) {
          const c = findGroup(s.project, cid), b = snap.groups.get(cid);
          if (!c || !b) continue;
          c.placement.position = scaleAbout(b.position, about, t.scale);
          inside(c, ZERO);
        }
      };
      inside(g, { x: pivotLocal.x, y: pivotLocal.y, z: pivotLocal.z });
    }
    // the curves scale with the object (it stays similar); their normal offsets too
    if (t.scale !== 1) for (const [cid, cs] of snap.curves) { const c = findCurve(s.project, cid); if (c) transformCurve(c, cs, { pivot: { x: 0, y: 0 }, angle: 0, sx: t.scale, sy: t.scale, sz: t.scale, tx: 0, ty: 0 }); }
  }, { history: !live });
}

// -- lofts ---------------------------------------------------------------------

/** Loft between two curves (auto direction). */
export function addLoft(store: Store, a: Id, b: Id): Id | null {
  if (a === b || !findCurve(store.project, a) || !findCurve(store.project, b)) return null;
  const n = store.project.lofts.length + 1;
  const id = uniqueId(`loft-${n}`, store.project.lofts.map((l) => l.id));
  store.update((s) => {
    s.project.lofts.push({ id, name: `Loft ${n}`, a, b, resolution: 2, strips: 4, flip: false, materialId: null, edgeA: { ...NO_LOFT_EDGE }, edgeB: { ...NO_LOFT_EDGE } });
    s.selection = { ...NO_SELECTION, loftId: id };
  });
  return id;
}

export function setLoftMaterial(store: Store, id: Id | Id[], materialId: Id | null): void {
  store.update((s) => { for (const lid of idsOf(id)) { const l = findLoft(s.project, lid); if (l) l.materialId = materialId; } });
}

// -- shapes: a surface over curves, with fill layers (docs/30-outline-and-shape-layers.md §4) ---

/**
 * A shape over the curves (all of them in one shape; those on the first curve's plane count),
 * with one Sheet layer when the project has a fill. Returns the id, null when no curve exists.
 */
export function addShape(store: Store, curves: Id | Id[], init: { name?: string; layers?: boolean } = {}): Id | null {
  const ids = [...new Set((Array.isArray(curves) ? curves : [curves]).filter((id) => findCurve(store.project, id)))];
  if (!ids.length) return null;
  let made: Id | null = null;
  store.update((s) => {
    const n = s.project.shapes.length + 1;
    const id = uniqueId(`shape-${n}`, s.project.shapes.map((p) => p.id));
    const fill = s.project.fills.find((f) => f.id === 'sheet') ?? s.project.fills[0];
    const layers = init.layers === false || !fill ? [] : [newShapeLayer(fill.id, [], 'sheet')];
    s.project.shapes.push({ id, name: init.name ?? `Shape ${n}`, curves: ids, expand: 0, resolution: 2, layers });
    s.selection = { ...NO_SELECTION, shapeId: id };
    made = id;
  });
  return made;
}

export function selectShape(store: Store, id: Id | null): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, shapeId: id }; }, { history: false });
}

/** Select shapes (docs/35 §2); the last is the primary. */
export function selectShapes(store: Store, ids: Id[]): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, shapes: ids.filter((id, i) => findShape(s.project, id) && ids.indexOf(id) === i) }; }, { history: false });
}

/** `expand` = mm in the plane (+ every loop bigger), `resolution` the boundary sampling, `curves` the list (first = the plane). */
export function updateShape(store: Store, id: Id | Id[], patch: Partial<Pick<Shape, 'name' | 'curves' | 'expand' | 'resolution'>>): void {
  store.update((s) => { for (const sid of idsOf(id)) { const p = findShape(s.project, sid); if (p) Object.assign(p, normalizeShape({ ...p, ...patch })); } });
}

export function removeShape(store: Store, id: Id): void {
  store.update((s) => { s.project.shapes = s.project.shapes.filter((p) => p.id !== id); if (s.selection.shapeId === id) s.selection.shapeId = null; });
}

/** Add a fill layer on top of a shape (the Sheet by default). Returns the layer id, null without a fill or a shape. */
export function addShapeLayer(store: Store, id: Id, init: Partial<Omit<ShapeLayer, 'id'>> = {}): Id | null {
  const sh = findShape(store.project, id);
  const fill = store.project.fills.find((f) => f.id === (init.fillId ?? 'sheet')) ?? store.project.fills[0];
  if (!sh || !fill) return null;
  const layer = normalizeShapeLayer({ ...newShapeLayer(fill.id, sh.layers.map((l) => l.id), fill.id), ...init, id: uniqueId(fill.id, sh.layers.map((l) => l.id)), fillId: fill.id });
  store.update((s) => { findShape(s.project, id)?.layers.push(layer); });
  return layer.id;
}

/** Change a layer: fill, params (`null` clears all overrides), material, offset, visibility. */
export function updateShapeLayer(store: Store, id: Id, layerId: Id, patch: Partial<Omit<ShapeLayer, 'id' | 'params'>> & { params?: Record<string, number | null> | null }): void {
  store.update((s) => {
    const l = findShape(s.project, id)?.layers.find((x) => x.id === layerId);
    if (!l) return;
    const { params, ...rest } = patch;
    if (rest.fillId && !s.project.fills.some((f) => f.id === rest.fillId)) delete rest.fillId;
    Object.assign(l, normalizeShapeLayer({ ...l, ...rest, id: l.id, fillId: rest.fillId ?? l.fillId }));
    if (params !== undefined) l.params = mergeParams(l.params, params);
  });
}

export function removeShapeLayer(store: Store, id: Id, layerId: Id): void {
  store.update((s) => { const sh = findShape(s.project, id); if (sh) sh.layers = sh.layers.filter((l) => l.id !== layerId); });
}

export function moveShapeLayer(store: Store, id: Id, layerId: Id, index: number): void {
  store.update((s) => { const sh = findShape(s.project, id); if (sh) moveInList(sh.layers, layerId, index); });
}

/** Fill layer `index` of every shape in `ids` (docs/35 §5) — the shape-side mirror of `updateOutlineLayers`; a shape without that layer is skipped. */
export function updateShapeLayers(store: Store, ids: Id[], index: number, patch: Parameters<typeof updateShapeLayer>[3]): void {
  store.batch(() => { for (const id of ids) { const l = findShape(store.project, id)?.layers[index]; if (l) updateShapeLayer(store, id, l.id, patch); } });
}

export function removeShapeLayers(store: Store, ids: Id[], index: number): void {
  store.batch(() => { for (const id of ids) { const l = findShape(store.project, id)?.layers[index]; if (l) removeShapeLayer(store, id, l.id); } });
}

export function moveShapeLayers(store: Store, ids: Id[], index: number, to: number): void {
  store.batch(() => { for (const id of ids) { const l = findShape(store.project, id)?.layers[index]; if (l) moveShapeLayer(store, id, l.id, to); } });
}

/** Take curves that are going away out of every shape (docs/30 §4); a shape left with none goes too, and the selection with it. */
function dropShapeCurves(s: State, gone: (curve: Id) => boolean): void {
  for (const sh of s.project.shapes) sh.curves = sh.curves.filter((id) => !gone(id));
  const kept = s.project.shapes.filter((sh) => sh.curves.length);
  if (kept.length !== s.project.shapes.length && !kept.some((p) => p.id === s.selection.shapeId)) s.selection.shapeId = null;
  s.project.shapes = kept;
}

/** Param overrides merged: `null` clears every override, a `null` value clears one. */
function mergeParams(current: Record<string, number>, patch: Record<string, number | null> | null): Record<string, number> {
  if (!patch) return {};
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) { if (v === null || !Number.isFinite(v)) delete out[k]; else out[k] = v; }
  return out;
}

// -- fills = programs over a surface (docs/30 §4) ----------------------------------------------

/** Add a fill (id from its label, made unique). Returns the id. */
export function addFill(store: Store, x: Omit<Fill, 'id' | 'metalness' | 'roughness'> & Partial<Pick<Fill, 'metalness' | 'roughness'>> & { id?: Id }): Id {
  const id = uniqueId(x.id ?? slug(x.label), store.project.fills.map((f) => f.id));
  store.update((s) => { s.project.fills.push(cloneFill({ metalness: 0, roughness: 0.5, ...x, id })); });
  return id;
}

export function updateFill(store: Store, id: Id, patch: Partial<Pick<Fill, 'label' | 'code' | 'params' | 'color' | 'metalness' | 'roughness'>>): void {
  store.update((s) => { const x = s.project.fills.find((f) => f.id === id); if (x) Object.assign(x, patch); });
}

/** Remove a fill; layers running it move to the first remaining one. The last fill stays. */
export function removeFill(store: Store, id: Id): boolean {
  if (store.project.fills.length < 2 || !store.project.fills.some((f) => f.id === id)) return false;
  store.update((s) => {
    s.project.fills = s.project.fills.filter((f) => f.id !== id);
    for (const sh of s.project.shapes) for (const l of sh.layers) if (l.fillId === id) l.fillId = s.project.fills[0].id;
  });
  return true;
}

export function duplicateFill(store: Store, id: Id): Id | null {
  const x = store.project.fills.find((f) => f.id === id);
  if (!x) return null;
  const { id: _own, ...rest } = x;
  const copy = addFill(store, { ...rest, label: `${x.label} copy` });
  store.update((s) => {
    const list = s.project.fills, from = list.findIndex((y) => y.id === copy), to = list.findIndex((y) => y.id === id) + 1;
    if (from > to) list.splice(to, 0, ...list.splice(from, 1));
  });
  return copy;
}

export function moveFill(store: Store, id: Id, index: number): void {
  store.update((s) => { moveInList(s.project.fills, id, index); });
}

// -- materials (docs/10-materials.md) ----------------------------------------------------

/** Add a material to the project (id from its name, made unique). Returns the id. */
export function addMaterial(store: Store, m: Omit<Material, 'id'> & { id?: Id }): Id {
  const id = uniqueId(m.id ?? slug(m.name), store.project.materials.map((x) => x.id));
  store.update((s) => { s.project.materials.push({ id, name: m.name, code: m.code, source: m.source ?? '', warnings: m.warnings ?? [] }); });
  return id;
}

export function updateMaterial(store: Store, id: Id, patch: Partial<Pick<Material, 'name' | 'code' | 'warnings'>>): void {
  store.update((s) => { const m = findMaterial(s.project, id); if (m) Object.assign(m, patch); });
}

/** Remove a material; curves and lofts using it go back to their default look. */
export function removeMaterial(store: Store, id: Id): void {
  store.update((s) => { s.project.materials = s.project.materials.filter((m) => m.id !== id); });
}

/** Copy a material ("<name> copy"). Returns the new id. */
export function duplicateMaterial(store: Store, id: Id): Id | null {
  const m = findMaterial(store.project, id);
  if (!m) return null;
  const copy = addMaterial(store, { name: `${m.name} copy`, code: m.code, source: m.source, warnings: m.warnings });
  store.update((s) => {
    const list = s.project.materials, from = list.findIndex((x) => x.id === copy), to = list.findIndex((x) => x.id === id) + 1;
    if (from > to) list.splice(to, 0, ...list.splice(from, 1));
  });
  return copy;
}

/** Move a material to `index` in the project list (the dropdown order) — docs/13-material-editor.md. */
export function moveMaterial(store: Store, id: Id, index: number): void {
  store.update((s) => { moveInList(s.project.materials, id, index); });
}

function moveInList<T extends { id: Id }>(list: T[], id: Id, index: number): void {
  const from = list.findIndex((x) => x.id === id);
  if (from < 0) return;
  const [item] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, index)), 0, item);
}

/** Copy a library material into the project together with the textures it carries (missing ids only). Returns the material id. */
export function addLibraryMaterial(store: Store, m: Omit<Material, 'id'> & { id?: Id; textures?: Texture[] }): Id {
  for (const t of m.textures ?? []) if (!findTexture(store.project, t.id)) addTexture(store, t);
  return addMaterial(store, m);
}

// -- profiles = shape programs (docs/14-shapes.md) ------------------------------------------

/** Add a profile (id from its label, made unique). Returns the id. */
export function addProfile(store: Store, x: Omit<Profile, 'id'> & { id?: Id }): Id {
  const id = uniqueId(x.id ?? slug(x.label), store.project.profiles.map((p) => p.id));
  store.update((s) => { s.project.profiles.push(cloneProfile({ ...x, id })); });
  return id;
}

export function updateProfile(store: Store, id: Id, patch: Partial<Pick<Profile, 'label' | 'code' | 'params' | 'color' | 'limits'>>): void {
  store.update((s) => { const x = s.project.profiles.find((p) => p.id === id); if (x) Object.assign(x, patch); });
}

/** Remove a profile; curves bent from it move to the first remaining one. The last profile stays. */
export function removeProfile(store: Store, id: Id): boolean {
  if (store.project.profiles.length < 2 || !store.project.profiles.some((p) => p.id === id)) return false;
  store.update((s) => {
    s.project.profiles = s.project.profiles.filter((p) => p.id !== id);
    for (const c of s.project.curves) for (const l of c.outline) if (l.profileId === id) l.profileId = s.project.profiles[0].id;
  });
  return true;
}

export function duplicateProfile(store: Store, id: Id): Id | null {
  const x = store.project.profiles.find((p) => p.id === id);
  if (!x) return null;
  const { id: _own, ...rest } = x;
  const copy = addProfile(store, { ...rest, label: `${x.label} copy` });
  store.update((s) => {
    const list = s.project.profiles, from = list.findIndex((y) => y.id === copy), to = list.findIndex((y) => y.id === id) + 1;
    if (from > to) list.splice(to, 0, ...list.splice(from, 1));
  });
  return copy;
}

export function moveProfile(store: Store, id: Id, index: number): void {
  store.update((s) => { moveInList(s.project.profiles, id, index); });
}

/** Override profile parameters on outline layer `layer` (an index, the first by default) of curves (`null` clears every override; a `null` value clears one). */
export function setCurveParams(store: Store, ids: Id[], patch: Record<string, number | null> | null, layer = 0): void {
  store.update((s) => {
    for (const c of s.project.curves) {
      const l = ids.includes(c.id) ? c.outline[layer] : null;
      if (l) l.params = mergeParams(l.params, patch);
    }
  });
}

// -- camera and post-processing (docs/15-camera.md) -------------------------------------------

/** Add a camera object (id from its name); defaults for anything not given. Returns the id. */
export function addCamera(store: Store, c: Partial<Camera> & { name: string }): Id {
  const id = uniqueId(c.id ?? slug(c.name), store.project.cameras.map((x) => x.id));
  store.update((s) => { s.project.cameras.push(normalizeCamera({ ...c, id })); });
  return id;
}

/**
 * Film back / lens / depth of field / frame / name / pose / world of a camera; nested patches merge — a world patch
 * merges onto the camera's world (docs/16-world.md, docs/36-camera-world.md).
 */
export function updateCamera(store: Store, id: Id | Id[], patch: CameraPatch): void {
  store.update((s) => { for (const cid of idsOf(id)) { const i = s.project.cameras.findIndex((c) => c.id === cid); if (i >= 0) s.project.cameras[i] = mergeCamera(s.project.cameras[i], patch); } });
}

/** The camera's pose as the view moves — no undo step (a drag is not an edit). */
export function setCameraPose(store: Store, id: Id, pose: CameraPose): void {
  store.update((s) => { const c = s.project.cameras.find((x) => x.id === id); if (c) c.pose = { position: { ...pose.position }, target: { ...pose.target } }; }, { history: false });
}

/** Remove a camera — never the last one (the viewport always looks through a camera, docs/36); removing the one looked through looks through its neighbour. */
export function removeCamera(store: Store, id: Id): void {
  const i = store.project.cameras.findIndex((c) => c.id === id);
  if (i < 0 || store.project.cameras.length < 2) return;
  store.update((s) => {
    s.project.cameras = s.project.cameras.filter((c) => c.id !== id);
    if (s.project.activeCamera === id) s.project.activeCamera = s.project.cameras[Math.max(0, i - 1)].id;
  });
}

export function duplicateCamera(store: Store, id: Id): Id | null {
  const c = store.project.cameras.find((x) => x.id === id);
  if (!c) return null;
  const { id: _own, ...rest } = c;
  const copy = addCamera(store, { ...rest, name: `${c.name} copy` });
  store.update((s) => {
    const list = s.project.cameras, from = list.findIndex((y) => y.id === copy), to = list.findIndex((y) => y.id === id) + 1;
    if (from > to) list.splice(to, 0, ...list.splice(from, 1));
  });
  return copy;
}

export function moveCamera(store: Store, id: Id, index: number): void {
  store.update((s) => { moveInList(s.project.cameras, id, index); });
}

/** Look through a camera (there is no free view, docs/36-camera-world.md: an unknown id is a no-op). */
export function setActiveCamera(store: Store, id: Id): void {
  if (!store.project.cameras.some((c) => c.id === id) || store.project.activeCamera === id) return;
  store.update((s) => { s.project.activeCamera = id; });
}

/** Select a camera in the outliner (its properties show in the panel). */
export function selectCamera(store: Store, id: Id | null): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, cameraId: id && s.project.cameras.some((c) => c.id === id) ? id : null }; }, { history: false });
}

/** Select cameras (docs/35 §2); the last is the primary. */
export function selectCameras(store: Store, ids: Id[]): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, cameras: ids.filter((id, i) => s.project.cameras.some((c) => c.id === id) && ids.indexOf(id) === i) }; }, { history: false });
}

/** The post-processing editor: the panel shows the script, the viewport previews the draft until it is committed. */
export function enterPostEdit(store: Store): void {
  store.update((s) => { if (s.mode.kind === 'edit') return; s.mode = { kind: 'post' }; }, { history: false });
}

export function exitPostEdit(store: Store): void {
  store.update((s) => { if (s.mode.kind === 'post') s.mode = { kind: 'object' }; }, { history: false });
}

/** The post-processing script: enabled / label / code / params (params replace as a whole). */
export function setPost(store: Store, patch: Partial<PostProgram>): void {
  store.update((s) => { s.project.post = { ...s.project.post, ...patch, params: patch.params ? { ...patch.params } : s.project.post.params }; });
}

// -- world (docs/16-world.md, docs/36-camera-world.md) ----------------------------------------

/** The world of the camera looked through: background, environment, sun, exposure — nested patches merge. */
export function setWorld(store: Store, patch: WorldPatch): void {
  updateCamera(store, store.project.activeCamera, { world: patch });
}

// -- pixel animations and fixtures (docs/17-emitters.md) -------------------------------

/** Add a pixel animation over a PNG texture (x = LED id, y = frame). Returns the id. */
export function addAnimation(store: Store, a: Omit<Animation, 'id'> & { id?: Id }): Id {
  const id = uniqueId(a.id ?? slug(a.name), store.project.animations.map((x) => x.id));
  store.update((s) => { s.project.animations.push(normalizeAnimation({ ...a, id })); });
  return id;
}

export function updateAnimation(store: Store, id: Id, patch: Partial<Omit<Animation, 'id'>>): void {
  store.update((s) => { const i = s.project.animations.findIndex((a) => a.id === id); if (i >= 0) s.project.animations[i] = normalizeAnimation({ ...s.project.animations[i], ...patch, id }); });
}

/** Remove an animation; the fixtures playing it go back to their own colour. */
export function removeAnimation(store: Store, id: Id): void {
  store.update((s) => {
    s.project.animations = s.project.animations.filter((a) => a.id !== id);
    for (const c of s.project.curves) for (const l of c.outline) if (l.pixels?.animation === id) l.pixels.animation = null;
  });
}

export function moveAnimation(store: Store, id: Id, index: number): void {
  store.update((s) => { moveInList(s.project.animations, id, index); });
}

/**
 * Patch curves as LED fixtures (docs/17-emitters.md): `patch` merges onto their fixture (creating one from the
 * defaults), `null` un-patches them. Returns nothing; `pixelCount` says how many pixels each carries.
 */
export function setCurvePixels(store: Store, ids: Id[], patch: Partial<CurvePixels> | null, layer = 0): void {
  store.update((s) => {
    for (const c of s.project.curves) {
      const l = ids.includes(c.id) ? c.outline[layer] : null;
      if (!l) continue;
      if (patch === null) { l.pixels = null; continue; }
      const next = normalizePixels({ ...(l.pixels ?? normalizePixels({})), ...patch });
      l.pixels = next.animation && !findAnimation(s.project, next.animation) ? { ...next, animation: null } : next;
    }
  });
}

/** Give every fixture in `ids` (outline layer `layer` of each curve) its own block of an animation's columns, in order (chain after chain). */
export function chainCurvePixels(store: Store, ids: Id[], animation: Id | null, layer = 0): void {
  store.update((s) => {
    let offset = 0;
    for (const id of ids) {
      const l = s.project.curves.find((x) => x.id === id)?.outline[layer];
      if (!l) continue;
      l.pixels = normalizePixels({ ...(l.pixels ?? {}), animation, offset });
      offset += pixelCount(l.pixels);
    }
  });
}

/** The playback clock: running or held, its range and whether it loops (docs/22-transport-in-out.md). The current time is viewer state. */
export function setPlayback(store: Store, patch: Partial<Playback>): void {
  store.update((s) => {
    s.project.playback = normalizePlayback({ ...s.project.playback, ...patch });
  }, { history: false });
}

// -- textures (docs/13-material-editor.md) ----------------------------------------------

/** Add an image texture (id from its name, made unique). Returns the id. */
export function addTexture(store: Store, t: Omit<Texture, 'id'> & { id?: Id }): Id {
  const id = uniqueId(t.id ?? slug(t.name), store.project.textures.map((x) => x.id));
  store.update((s) => { s.project.textures.push({ id, name: t.name, mime: t.mime, data: t.data, width: t.width, height: t.height, source: t.source ?? '' }); });
  return id;
}

export function updateTexture(store: Store, id: Id, patch: Partial<Omit<Texture, 'id'>>): void {
  store.update((s) => { const t = findTexture(s.project, id); if (t) Object.assign(t, patch); });
}

/** Remove a texture; materials sampling it get the grey placeholder. */
export function removeTexture(store: Store, id: Id): void {
  store.update((s) => { s.project.textures = s.project.textures.filter((t) => t.id !== id); });
}

export function moveTexture(store: Store, id: Id, index: number): void {
  store.update((s) => { moveInList(s.project.textures, id, index); });
}

/** Assign a project material (or null = default) to outline layer `layer` (an index, the first by default) of curves. */
export function setCurveMaterial(store: Store, ids: Id[], materialId: Id | null, layer = 0): void {
  store.update((s) => { for (const c of s.project.curves) { const l = ids.includes(c.id) ? c.outline[layer] : null; if (l) l.materialId = materialId; } });
}

export function selectLoft(store: Store, id: Id | null): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, loftId: id }; }, { history: false });
}

/** Select lofts (docs/35 §2); the last is the primary. */
export function selectLofts(store: Store, ids: Id[]): void {
  store.update((s) => { s.selection = { ...NO_SELECTION, lofts: ids.filter((id, i) => findLoft(s.project, id) && ids.indexOf(id) === i) }; }, { history: false });
}

export function updateLoft(store: Store, id: Id | Id[], patch: Partial<Pick<Loft, 'name' | 'a' | 'b' | 'resolution' | 'strips' | 'flip' | 'edgeA' | 'edgeB'>>): void {
  store.update((s) => { for (const lid of idsOf(id)) { const l = findLoft(s.project, lid); if (l) Object.assign(l, patch); } });
}

/** Trim / offset one edge of a loft before it is built — mm, negative start / end go past the curve (docs/24-loft-trim.md). */
export function setLoftEdge(store: Store, id: Id | Id[], which: 'a' | 'b', patch: Partial<LoftEdge>): void {
  store.update((s) => {
    for (const lid of idsOf(id)) {
      const l = findLoft(s.project, lid);
      if (!l) continue;
      const edge = normalizeLoftEdge({ ...loftEdge(l, which), ...patch });
      if (which === 'a') l.edgeA = edge; else l.edgeB = edge;
    }
  });
}

export function removeLoft(store: Store, id: Id): void {
  store.update((s) => { s.project.lofts = s.project.lofts.filter((l) => l.id !== id); if (s.selection.loftId === id) s.selection.loftId = null; });
}

// -- curve objects -------------------------------------------------------------

/** New empty curve on the plane (creates a Front plane if there is none) and enter Edit mode. */
export function addCurve(store: Store, planeId?: Id | null, preset: PlanePreset = 'front'): Id {
  let pid = planeId ?? store.activePlane()?.id ?? store.project.planes[0]?.id ?? null;
  if (!pid) pid = addPlane(store, preset);
  const n = store.project.curves.length + 1;
  const c = newCurve(`Curve ${n}`, pid, store.project.profiles[0].id, store.project.curves.map((x) => x.id));
  store.update((s) => {
    s.project.curves.push(c);
    s.mode = { kind: 'edit', curveId: c.id };
    s.selection = { ...NO_SELECTION, curves: [c.id], planeId: pid };
  });
  return c.id;
}

export function duplicateCurves(store: Store, ids: Id[]): Id[] {
  const out: Id[] = [];
  store.update((s) => {
    for (const id of ids) {
      const src = findCurve(s.project, id);
      if (!src) continue;
      const copy = copyCurve(src, s.project.curves.map((x) => x.id), 200);
      s.project.curves.push(copy);
      out.push(copy.id);
    }
    s.selection = { ...NO_SELECTION, curves: out, planeId: s.selection.planeId };
  });
  return out;
}

/** Copy a curve object with fresh ids, shifted by `dx` along the plane's X. */
function copyCurve(src: CurveObject, taken: Iterable<Id>, dx: number): CurveObject {
  const copy = clone(src);
  copy.id = uniqueId(src.id, taken);
  copy.name = `${src.name} copy`;
  const map = new Map<Id, Id>();
  for (const v of copy.curve.points) { const nid = uid(); map.set(v.id, nid); v.id = nid; v.x += dx; }
  for (const k of copy.constraints) { k.id = uid(); k.a = map.get(k.a) ?? k.a; if (k.b) k.b = map.get(k.b) ?? k.b; if (k.at) k.at = { ...k.at, x: k.at.x + dx }; }
  return copy;
}

/** Duplicate a plane with everything on it (placement, modifier, curves), shifted 200 mm along its X. */
export function duplicatePlane(store: Store, planeId: Id): Id | null {
  const src = findPlane(store.project, planeId);
  if (!src) return null;
  const plane = clone(src);
  plane.id = uniqueId(src.id, store.project.planes.map((p) => p.id));
  plane.name = `${src.name} copy`;
  // the placement is local to the object the plane sits in, so the copy joins it (docs/18-nested-objects.md §2)
  const parent = groupOfPlane(store.project, planeId)?.id ?? null;
  store.update((s) => {
    s.project.planes.push(plane);
    const g = parent ? findGroup(s.project, parent) : null;
    if (g) g.planes.push(plane.id);
    const taken = s.project.curves.map((x) => x.id);
    for (const c of s.project.curves.filter((x) => x.planeId === planeId)) {
      const copy = copyCurve(c, taken, 200);
      copy.name = c.name;
      copy.planeId = plane.id;
      taken.push(copy.id);
      s.project.curves.push(copy);
    }
    s.selection = { ...NO_SELECTION, planeId: plane.id, planeSelected: true };
  });
  return plane.id;
}

/** Duplicate whatever is selected: the plane (with its curves) or the selected curves. */
export function duplicateSelection(store: Store): void {
  const { selection } = store.state;
  if (selection.groups.length) { for (const id of selection.groups) duplicateGroup(store, id); }
  else if (selection.planes.length) store.batch(() => { for (const id of [...selection.planes]) duplicatePlane(store, id); });
  else if (selection.curves.length) duplicateCurves(store, selection.curves);
}

export function removeCurves(store: Store, ids: Id[]): void {
  const set = new Set(ids);
  store.update((s) => {
    s.project.curves = s.project.curves.filter((c) => !set.has(c.id));
    dropShapeCurves(s, (curve) => set.has(curve));
    s.selection = { ...NO_SELECTION, planeId: s.selection.planeId };
  });
}

export function renameCurve(store: Store, id: Id | Id[], name: string): void {
  store.update(() => { for (const cid of idsOf(id)) cv(store, cid).name = name; });
}

/** Select a curve object (Object mode); `additive` toggles it within the selection. */
export function selectCurve(store: Store, id: Id | null, additive = false): void {
  store.update((s) => {
    if (id === null) { s.selection = { ...NO_SELECTION, planeId: s.selection.planeId }; return; }
    const c = findCurve(s.project, id);
    if (!c) return;
    const cur = s.selection.curves;
    let curves: Id[];
    if (!additive) curves = [id];
    else if (cur.includes(id)) curves = cur.filter((x) => x !== id);
    else curves = [...cur, id];
    s.selection = { ...NO_SELECTION, curves, planeId: c.planeId };
  }, { history: false });
}

/** Replace (or, additively, extend) the curve selection with `ids` (box select). */
export function selectCurves(store: Store, ids: Id[], additive = false): void {
  store.update((s) => {
    const valid = ids.filter((id) => findCurve(s.project, id));
    const cur = additive ? s.selection.curves.filter((id) => !valid.includes(id)) : [];
    const curves = [...cur, ...valid];
    const last = curves.length ? findCurve(s.project, curves[curves.length - 1]) : null;
    s.selection = { ...NO_SELECTION, curves, planeId: last?.planeId ?? s.selection.planeId };
  }, { history: false });
}

/**
 * Bend outline layer `layer` (an index, the first by default) of curves from another profile. A curve
 * without that layer gets one when the index is the next free one — so a construction line takes a profile.
 */
export function setCurveProfile(store: Store, id: Id | Id[], profileId: Id, layer = 0): void {
  const ids = Array.isArray(id) ? id : [id];
  store.update((s) => {
    if (!s.project.profiles.some((p) => p.id === profileId)) return;
    for (const c of s.project.curves) {
      if (!ids.includes(c.id)) continue;
      const l = c.outline[layer];
      if (l) l.profileId = profileId;
      else if (layer === c.outline.length) c.outline.push(newOutlineLayer(profileId, c.outline.map((x) => x.id), layer ? 'layer' : 'base'));
    }
  });
}

// -- outline layers (docs/30-outline-and-shape-layers.md §3) --------------------------------

/**
 * Add a layer on top of the outline of one curve or several (the first profile on the line unless
 * `init` says otherwise: profileId, offset, lift, params, materialId, pixels, visible). Returns the
 * new layer id (one per curve for a list); null / [] when nothing was added.
 */
export function addOutlineLayer(store: Store, curve: Id, init?: Partial<Omit<OutlineLayer, 'id'>>): Id | null;
export function addOutlineLayer(store: Store, curves: Id[], init?: Partial<Omit<OutlineLayer, 'id'>>): Id[];
export function addOutlineLayer(store: Store, curves: Id | Id[], init: Partial<Omit<OutlineLayer, 'id'>> = {}): Id | Id[] | null {
  const ids = (Array.isArray(curves) ? curves : [curves]).filter((id) => findCurve(store.project, id));
  const made: Id[] = [];
  if (ids.length && store.project.profiles.length) store.update((s) => {
    for (const id of ids) {
      const c = findCurve(s.project, id)!;
      const taken = c.outline.map((l) => l.id);
      const profileId = s.project.profiles.some((p) => p.id === init.profileId) ? init.profileId! : s.project.profiles[0].id;
      const layer = normalizeOutlineLayer({ ...newOutlineLayer(profileId, taken, c.outline.length ? 'layer' : 'base'), ...init, id: uniqueId(profileId, taken), profileId }, s.project.profiles);
      c.outline.push(layer);
      made.push(layer.id);
    }
  });
  return Array.isArray(curves) ? made : made[0] ?? null;
}

/** Change one layer of one curve: profile, offset, lift, material, pixels, visibility; `params` merges (`null` clears all overrides, a `null` value one). */
export function updateOutlineLayer(store: Store, curveId: Id, layerId: Id, patch: Partial<Omit<OutlineLayer, 'id' | 'params'>> & { params?: Record<string, number | null> | null }): void {
  store.update((s) => {
    const l = findCurve(s.project, curveId)?.outline.find((x) => x.id === layerId);
    if (!l) return;
    const { params, ...rest } = patch;
    if (rest.profileId && !s.project.profiles.some((p) => p.id === rest.profileId)) delete rest.profileId;
    Object.assign(l, normalizeOutlineLayer({ ...l, ...rest, id: l.id }, s.project.profiles));
    if (params !== undefined) l.params = mergeParams(l.params, params);
  });
}

/** The same change on layer index `index` of several curves at once (the panel with a multi-selection) — one undo step. */
export function updateOutlineLayers(store: Store, ids: Id[], index: number, patch: Partial<Omit<OutlineLayer, 'id' | 'params'>> & { params?: Record<string, number | null> | null }): void {
  store.update((s) => {
    for (const c of s.project.curves) {
      const l = ids.includes(c.id) ? c.outline[index] : null;
      if (!l) continue;
      const { params, ...rest } = patch;
      if (rest.profileId && !s.project.profiles.some((p) => p.id === rest.profileId)) delete rest.profileId;
      Object.assign(l, normalizeOutlineLayer({ ...l, ...rest, id: l.id }, s.project.profiles));
      if (params !== undefined) l.params = mergeParams(l.params, params);
    }
  });
}

export function removeOutlineLayer(store: Store, curveId: Id, layerId: Id): void {
  store.update((s) => { const c = findCurve(s.project, curveId); if (c) c.outline = c.outline.filter((l) => l.id !== layerId); });
}

export function moveOutlineLayer(store: Store, curveId: Id, layerId: Id, index: number): void {
  store.update((s) => { const c = findCurve(s.project, curveId); if (c) moveInList(c.outline, layerId, index); });
}

/** Planar ↔ 3D (docs/12-3d-curves.md). Going planar flattens the curve back onto its plane (z = 0). */
export function setCurveType(store: Store, id: Id | Id[], type: CurveType): void {
  const cs = idsOf(id).map((x) => cv(store, x)).filter((c) => c.type !== type);
  if (!cs.length) return;
  store.update(() => { for (const c of cs) { c.type = type; if (type === 'planar') flattenCurve(c); } });
}

/** Move curves to another plane, keeping their plane-local drawing. */
export function setCurvePlane(store: Store, id: Id | Id[], planeId: Id): void {
  store.update((s) => { if (findPlane(s.project, planeId)) { for (const cid of idsOf(id)) cv(store, cid).planeId = planeId; s.selection.planeId = planeId; } });
}

/** Offset whole curves within their plane (incremental delta in plane coordinates). */
export function translateCurves(store: Store, ids: Id[], delta: Vec2, live: boolean): void {
  if (!delta.x && !delta.y) return;
  store.update(() => {
    for (const id of ids) {
      const c = findCurve(store.project, id);
      if (!c) continue;
      for (const v of c.curve.points) { v.x += delta.x; v.y += delta.y; }
      for (const k of c.constraints) if (k.at) k.at = { ...k.at, x: k.at.x + delta.x, y: k.at.y + delta.y };
    }
  }, { history: !live });
}

/** Join two open curves on the same plane: the nearest ends are connected. */
export function joinEnds(store: Store, aId: Id, bId: Id): boolean {
  const a = cv(store, aId), b = cv(store, bId);
  if (a === b || a.planeId !== b.planeId || a.curve.closed || b.curve.closed || a.curve.points.length < 2 || b.curve.points.length < 2) return false;
  const pa = a.curve.points, pb = b.curve.points;
  const d = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  // candidates: a.end→b.start, a.end→b.end(reversed), a.start→b.start (a reversed), a.start→b.end (both reversed)
  const options = [
    { dist: d(pa[pa.length - 1], pb[0]), ra: false, rb: false },
    { dist: d(pa[pa.length - 1], pb[pb.length - 1]), ra: false, rb: true },
    { dist: d(pa[0], pb[0]), ra: true, rb: false },
    { dist: d(pa[0], pb[pb.length - 1]), ra: true, rb: true },
  ].sort((x, y) => x.dist - y.dist)[0];
  store.update((s) => {
    const rev = (pts: typeof pa) => pts.reverse().map((v) => ({ ...v, in: v.out, out: v.in }));
    const first = options.ra ? rev([...pa]) : [...pa];
    const second = options.rb ? rev([...pb]) : [...pb];
    a.curve.points = [...first, ...second];
    a.constraints = [...a.constraints, ...b.constraints];
    if (b.type === 'spatial') a.type = 'spatial';
    s.project.curves = s.project.curves.filter((c) => c.id !== bId);
    s.selection = { ...NO_SELECTION, curves: [aId], planeId: a.planeId };
  });
  return true;
}

export function enterEdit(store: Store, id: Id): void {
  const c = findCurve(store.project, id);
  if (!c) return;
  store.update((s) => { s.mode = { kind: 'edit', curveId: id }; s.selection = { ...NO_SELECTION, curves: [id], planeId: c.planeId }; }, { history: false });
}

export function exitEdit(store: Store): void {
  store.update((s) => {
    const id = s.mode.kind === 'edit' ? s.mode.curveId : null;
    s.mode = { kind: 'object' };
    const c = id ? findCurve(s.project, id) : null;
    s.selection = { ...NO_SELECTION, curves: c ? [c.id] : [], planeId: c?.planeId ?? s.selection.planeId };
    if (c && c.curve.points.length < 2) { s.project.curves = s.project.curves.filter((x) => x.id !== c.id); s.selection.curves = []; }
  });
}

export function toggleEdit(store: Store): void {
  if (store.mode.kind === 'edit') exitEdit(store);
  else if (store.primaryCurveId) enterEdit(store, store.primaryCurveId);
}

export function toggleSnap(store: Store): void { store.update((s) => { s.snap = !s.snap; }, { history: false }); }
export function toggleAlignSnap(store: Store): void { store.update((s) => { s.alignSnap = !s.alignSnap; }, { history: false }); }

export function setLimit(store: Store, profileId: Id, check: CheckIdLike, value: number): void {
  store.update((s) => { const p = s.project.profiles.find((x) => x.id === profileId); if (p) p.limits[check] = value; });
}

// -- vertices (Edit mode) ---------------------------------------------------------

/** Select a vertex; `additive` toggles it within the current selection. */
export function selectVertex(store: Store, id: Id, vid: Id, additive = false): void {
  store.update((s) => {
    const cur = s.selection.vertices;
    if (!additive) s.selection.vertices = [vid];
    else if (cur.includes(vid)) s.selection.vertices = cur.filter((v) => v !== vid);
    else s.selection.vertices = [...cur, vid];
    void id;
  }, { history: false });
}

export function selectVertices(store: Store, vids: Id[], additive = false): void {
  store.update((s) => {
    const cur = additive ? s.selection.vertices.filter((v) => !vids.includes(v)) : [];
    s.selection.vertices = [...cur, ...vids];
  }, { history: false });
}

export function selectAllVertices(store: Store): void {
  const c = store.editingCurve();
  if (c) selectVertices(store, c.curve.points.map((v) => v.id));
}

/** Append a vertex; `z` (normal offset) is kept only on a 3D curve. */
export function addVertex(store: Store, id: Id, p: Vec2 & { z?: number }): Id {
  const c = cv(store, id);
  const v = vertex(p.x, p.y, 'polygon', c.type === 'spatial' ? p.z ?? 0 : 0);
  store.update((s) => { c.curve.points.push(v); s.selection.vertices = [v.id]; });
  return v.id;
}

/** Insert a vertex on the curve at arc length `s` without changing the shape. */
export function insertVertexAt(store: Store, id: Id, s: number): Id | null {
  const c = cv(store, id);
  const ev = store.evals.get(id);
  if (!ev) return null;
  const split = splitCurveAt(c.curve, ev.sampling, s);
  if (!split) return null;
  store.update((st) => {
    const pts = c.curve.points;
    const n = pts.length;
    const prev = pts[(split.index - 1 + n) % n], next = pts[split.index % n];
    if (prev.type !== 'polygon') prev.out = split.prevOut;   // a polygon neighbour keeps its straight sides
    if (next.type !== 'polygon') next.in = split.nextIn;
    pts.splice(split.index, 0, split.vertex);
    st.selection.vertices = [split.vertex.id];
  });
  return split.vertex.id;
}

/**
 * Move several vertices: only the given components change (`z` = normal offset,
 * ignored on planar curves); constraints solved with all of them fixed. Pinned vertices stay.
 */
export function moveVertices(store: Store, id: Id, moves: { vid: Id; p: Partial<Vec3> }[], live: boolean): void {
  const c = cv(store, id);
  const applied = moves.filter((m) => !isPinned(c.constraints, m.vid));
  if (!applied.length) return;
  const spatial = c.type === 'spatial';
  store.update(() => {
    for (const m of applied) {
      const v = vtx(c, m.vid);
      if (!v) continue;
      if (m.p.x !== undefined) v.x = m.p.x;
      if (m.p.y !== undefined) v.y = m.p.y;
      if (m.p.z !== undefined && spatial) v.z = m.p.z;
    }
    solveConstraints(c.curve, c.constraints, applied.map((m) => m.vid));
  }, { history: !live });
}

/** Offset the vertices (and pins) along the plane normal by `dz` from `original` z values (Alt-drag / gizmo Z). */
export function offsetVertices(store: Store, id: Id, originals: Map<Id, number>, dz: number, live: boolean): void {
  moveVertices(store, id, [...originals].map(([vid, z]) => ({ vid, p: { z: z + dz } })), live);
}

/** Drag a handle to an absolute plane point (z optional: kept when absent). An equal vertex keeps the other handle collinear; a polygon one has no handles. */
export function moveHandle(store: Store, id: Id, vid: Id, which: 'in' | 'out', abs: Vec2 & { z?: number }, live: boolean): void {
  const c = cv(store, id);
  store.update(() => {
    const i = vidx(c, vid);
    if (i < 0) return;
    const v = c.curve.points[i];
    if (v.type === 'polygon') return;
    const z = c.type === 'spatial' ? (abs.z !== undefined ? abs.z - v.z : v[which].z) : 0;
    const rel = { x: abs.x - v.x, y: abs.y - v.y, z };
    v[which] = rel;
    if (v.type === 'equal') {
      const other = which === 'in' ? 'out' : 'in';
      v[other] = mirrorHandle(rel, vec.len(v[other]) || vec.len(rel));
    }
  }, { history: !live });
}

export function setVertexType(store: Store, id: Id, vids: Id[], type: VertexType): void {
  const c = cv(store, id);
  store.update(() => {
    for (const vid of vids) {
      const i = vidx(c, vid);
      if (i < 0) continue;
      const v = c.curve.points[i];
      if (v.type === type) continue;
      if (type !== 'polygon') fillHandles(c.curve, i);  // a straight vertex gains handles from its neighbours
      v.type = type;
    }
  });
}

const ORDER: VertexType[] = ['polygon', 'equal', 'free'];
export function cycleVertexType(store: Store, id: Id, vids: Id[]): void {
  const c = cv(store, id);
  const first = vids.length ? vtx(c, vids[0]) : null;
  if (!first) return;
  setVertexType(store, id, vids, ORDER[(ORDER.indexOf(first.type) + 1) % ORDER.length]);
}

export function deleteVertices(store: Store, id: Id, vids: Id[]): void {
  const set = new Set(vids);
  store.update((s) => {
    const c = cv(store, id);
    c.curve.points = c.curve.points.filter((v) => !set.has(v.id));
    c.constraints = c.constraints.filter((k) => !set.has(k.a) && !(k.b && set.has(k.b)));
    s.selection.vertices = [];
  });
}

export function toggleClosed(store: Store, id: Id): void {
  store.update(() => { const c = cv(store, id); if (c.curve.points.length >= 3) c.curve.closed = !c.curve.closed; });
}

/** Delete the selected vertices (Edit) or curves / plane (Object). */
export function deleteSelection(store: Store): void {
  const { selection, mode } = store.state;
  if (mode.kind === 'edit') { if (selection.vertices.length) deleteVertices(store, mode.curveId, selection.vertices); return; }
  if (selection.groups.length) { for (const id of [...selection.groups]) removeGroupContents(store, id); }
  else if (selection.lofts.length) store.batch(() => { for (const id of [...selection.lofts]) removeLoft(store, id); });
  else if (selection.shapes.length) store.batch(() => { for (const id of [...selection.shapes]) removeShape(store, id); });
  else if (selection.curves.length) removeCurves(store, selection.curves);
  else if (selection.planeSelected && selection.planeId) removePlane(store, selection.planeId);
}

/**
 * Break the curve at the selected vertices into separate curves on the same
 * plane. Returns the ids of all pieces (the edited curve keeps the first).
 */
export function breakApart(store: Store, id: Id, vids: Id[]): Id[] {
  const c = cv(store, id);
  const pts = c.curve.points;
  const n = pts.length;
  const cut = pts.map((v, i) => (vids.includes(v.id) && (c.curve.closed || (i > 0 && i < n - 1)) ? i : -1)).filter((i) => i >= 0);
  if (!cut.length || n < 3) return [id];
  const pieces: (typeof pts)[] = [];
  if (c.curve.closed) {
    // rotate so the first cut is at index 0, then split at the others; the loop closes back to the start copy
    const rot = [...pts.slice(cut[0]), ...pts.slice(0, cut[0])];
    const cuts = cut.map((i) => (i - cut[0] + n) % n).slice(1);
    let start = 0;
    for (const k of [...cuts, n]) {
      const seg = rot.slice(start, k + 1).map((v, j) => (j === 0 && start > 0 ? { ...v, id: uid() } : v));
      if (k === n) seg[seg.length - 1] = { ...rot[0], id: uid() };
      pieces.push(seg);
      start = k;
    }
  } else {
    let start = 0;
    for (const k of [...cut, n - 1]) {
      const seg = pts.slice(start, k + 1).map((v, j) => (j === 0 && start > 0 ? { ...v, id: uid() } : v));
      pieces.push(seg);
      start = k;
    }
  }
  const ids: Id[] = [id];
  store.update((s) => {
    c.curve = { points: pieces[0], closed: false };
    const keep = new Set(pieces[0].map((v) => v.id));
    const others = c.constraints.filter((k) => !(keep.has(k.a) && (!k.b || keep.has(k.b))));
    c.constraints = c.constraints.filter((k) => keep.has(k.a) && (!k.b || keep.has(k.b)));
    pieces.slice(1).forEach((seg, i) => {
      const piece = newCurve(`${c.name} ${i + 2}`, c.planeId, null, s.project.curves.map((x) => x.id));
      piece.type = c.type;
      piece.outline = clone(c.outline);
      piece.curve = { points: seg, closed: false };
      const mine = new Set(seg.map((v) => v.id));
      piece.constraints = others.filter((k) => mine.has(k.a) && (!k.b || mine.has(k.b)));
      s.project.curves.push(piece);
      ids.push(piece.id);
    });
    s.selection.vertices = [];
  });
  return ids;
}

// -- offset, trim, fillet on a plane (docs/29-offset-trim-fillet.md) ---------------------

/**
 * A parallel copy of a planar curve `d` mm to the side — `+` outwards on a closed curve,
 * the left of travel on an open one — as a new curve on the same plane, selected. Null on
 * a spatial curve or a zero distance.
 */
export function offsetCurve(store: Store, id: Id, d: number): Id | null {
  const c = cv(store, id);
  const ev = store.evals.get(id);
  if (c.type === 'spatial' || !ev || !d) return null;
  const curve = offsetCurveGeo(c.curve, d, ev.sampling);
  if (!curve) return null;
  const copy = newCurve(`${c.name} offset`, c.planeId, null, store.project.curves.map((x) => x.id));
  copy.curve = curve;
  copy.outline = clone(c.outline);
  store.update((s) => {
    s.project.curves.push(copy);
    s.selection = { ...NO_SELECTION, curves: [copy.id], planeId: c.planeId };
  });
  return copy.id;
}

/** Arc lengths along curve `id` where the other planar curves on its plane (or just `cutters`) cross it. */
export function cutsOn(store: Store, id: Id, cutters?: Id[]): number[] {
  const c = cv(store, id);
  const ev = store.evals.get(id);
  if (!ev) return [];
  const out: number[] = [];
  for (const o of store.project.curves) {
    if (o.id === id || o.planeId !== c.planeId || o.type === 'spatial' || (cutters && !cutters.includes(o.id))) continue;
    const oe = store.evals.get(o.id);
    if (oe) for (const x of intersections(ev.sampling, oe.sampling)) out.push(x.sa);
  }
  return out;
}

/**
 * Trim: remove the piece of the curve around arc length `s`, between the nearest crossings
 * with the other curves on its plane (or the curve's ends). Returns the ids that remain — the
 * curve keeps the first piece, a cut-out middle makes a second curve, `[]` when nothing is
 * left — or null when there was no crossing to trim against.
 */
export function trimCurve(store: Store, id: Id, s: number, cutters?: Id[]): Id[] | null {
  const c = cv(store, id);
  const ev = store.evals.get(id);
  if (c.type === 'spatial' || !ev) return null;
  const res = trimPieces(c.curve, ev.sampling, s, cutsOn(store, id, cutters));
  if (!res) return null;
  const ids: Id[] = [];
  store.update((st) => {
    if (!res.pieces.length) {
      st.project.curves = st.project.curves.filter((x) => x.id !== id);
      dropShapeCurves(st, (curve) => curve === id);
      st.selection = { ...NO_SELECTION, planeId: c.planeId };
      return;
    }
    const all = c.constraints;
    const own = (seg: typeof res.pieces[number]) => { const m = new Set(seg.map((v) => v.id)); return all.filter((k) => m.has(k.a) && (!k.b || m.has(k.b))); };
    const [first, ...rest] = res.pieces;
    c.curve = { points: first, closed: false };
    c.constraints = own(first);
    ids.push(id);
    rest.forEach((seg, i) => {
      const piece = newCurve(`${c.name} ${i + 2}`, c.planeId, null, st.project.curves.map((x) => x.id));
      piece.outline = clone(c.outline);
      piece.curve = { points: seg, closed: false };
      piece.constraints = own(seg);
      st.project.curves.push(piece);
      ids.push(piece.id);
    });
    st.selection = { ...NO_SELECTION, curves: ids, planeId: c.planeId };
  });
  return ids;
}

/** Round the corner at vertex `vid` with radius `r` mm (docs/29 §4.1). False when it is not a corner or `r` does not fit. */
export function filletVertex(store: Store, id: Id, vid: Id, r: number): boolean {
  const c = cv(store, id);
  const ev = store.evals.get(id);
  const i = vidx(c, vid);
  if (c.type === 'spatial' || !ev || i < 0) return false;
  const res = filletCorner(c.curve, ev.sampling, i, r);
  if (!res) return false;
  store.update((s) => {
    c.curve = res.curve;
    const gone = new Set(res.removed);
    c.constraints = c.constraints.filter((k) => !gone.has(k.a) && !(k.b && gone.has(k.b)));
    s.selection.vertices = [];
  });
  return true;
}

/**
 * Two open curves on one plane become one at their corner (docs/29 §4.2): the nearest ends
 * trimmed back to where the curves cross, or extended straight to where their end tangents
 * meet, then rounded with `r` (0 = the sharp corner). Curve `a` keeps its id, name and
 * material; `b` goes. Null when the ends are parallel, the corner lies behind an end, or a
 * radius > 0 does not fit.
 */
export function filletCurves(store: Store, aId: Id, bId: Id, r: number): Id | null {
  const a = cv(store, aId), b = cv(store, bId);
  if (a === b || a.planeId !== b.planeId || a.type === 'spatial' || b.type === 'spatial') return null;
  const join = cornerJoin(a.curve, b.curve);
  if (!join) return null;
  let curve = join.curve;
  const removed = new Set(join.removed);
  if (r > 0) {
    const f = filletCorner(curve, sampleCurve(curve), curve.points.findIndex((v) => v.id === join.corner), r);
    if (!f) return null;
    curve = f.curve;
    for (const x of f.removed) removed.add(x);
  }
  store.update((s) => {
    a.curve = curve;
    a.constraints = [...a.constraints, ...b.constraints].filter((k) => !removed.has(k.a) && !(k.b && removed.has(k.b)));
    s.project.curves = s.project.curves.filter((x) => x.id !== bId);
    dropShapeCurves(s, (curve) => curve === bId);
    s.selection = { ...NO_SELECTION, curves: [aId], planeId: a.planeId };
  });
  return aId;
}

// -- project onto another plane (docs/34-project.md) ---------------------------------------

/**
 * Each curve's shadow on plane `planeId`, cast along that plane's normal, as a new planar
 * curve there (same outline stack, no constraints, named `<name> on <plane>`), all selected
 * in one undo step. Returns the new ids; a curve whose projection collapses is skipped.
 */
export function projectCurves(store: Store, ids: Id[], planeId: Id): Id[] {
  const target = findPlane(store.project, planeId);
  if (!target) throw new Error(`no plane ${planeId}`);
  const to = planeWorld(store.project, target);
  const taken = store.project.curves.map((x) => x.id);
  const made: CurveObject[] = [];
  for (const id of ids) {
    const c = cv(store, id);
    const curve = projectCurve(c.curve, planeWorld(store.project, store.planeOf(c)), to);
    if (!curve) continue;
    const copy = newCurve(`${c.name} on ${target.name}`, planeId, null, taken);
    taken.push(copy.id);
    copy.curve = curve;
    copy.outline = clone(c.outline);
    made.push(copy);
  }
  if (!made.length) return [];
  store.update((s) => {
    s.project.curves.push(...made);
    s.selection = { ...NO_SELECTION, curves: made.map((m) => m.id), planeId };
  });
  return made.map((m) => m.id);
}

// -- constraints ---------------------------------------------------------------

/** Add a constraint between vertices a (kept in place) and b (moved to satisfy it). */
export function addConstraint(store: Store, id: Id, type: ConstraintType, a: Id, b?: Id, value?: number): Id | null {
  const c = cv(store, id);
  const va = vtx(c, a), vb = b ? vtx(c, b) : null;
  if (!va || (type !== 'pin' && !vb)) return null;
  const cid = uid();
  store.update(() => {
    if (type === 'pin') {
      if (isPinned(c.constraints, a)) return;
      c.constraints.push({ id: cid, type, a, at: { x: va.x, y: va.y, z: va.z } });
      return;
    }
    c.constraints = c.constraints.filter((k) => !(k.type === type && ((k.a === a && k.b === b) || (k.a === b && k.b === a))));
    c.constraints.push({ id: cid, type, a, b, value: type === 'distance' ? (value ?? Math.hypot(vb!.x - va.x, vb!.y - va.y, vb!.z - va.z)) : undefined });
    solveConstraints(c.curve, c.constraints, [a]);
  });
  return cid;
}

export function togglePin(store: Store, id: Id, vid: Id): void {
  const c = cv(store, id);
  const pin = c.constraints.find((k) => k.type === 'pin' && k.a === vid);
  if (pin) removeConstraint(store, id, pin.id);
  else addConstraint(store, id, 'pin', vid);
}

export function removeConstraint(store: Store, id: Id, cid: Id): void {
  store.update(() => { const c = cv(store, id); c.constraints = c.constraints.filter((k) => k.id !== cid); });
}

export function setConstraintValue(store: Store, id: Id, cid: Id, value: number): void {
  store.update(() => {
    const c = cv(store, id);
    const k = c.constraints.find((x) => x.id === cid);
    if (!k) return;
    k.value = value;
    solveConstraints(c.curve, c.constraints, [k.a]);
  });
}

/** Record the current state as an undo step (end of a live drag that used incremental updates). */
export function commit(store: Store): void {
  store.update(() => undefined);
}

// -- transforms (gizmos, drags) ----------------------------------------------------

import { snapshotCurve, transformCurve, type Affine2, type CurveSnapshot } from '../model/transform';
import { findPlane as _findPlane } from '../model/types';
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

export function snapshotCurves(store: Store, ids: Id[]): Map<Id, CurveSnapshot> {
  const out = new Map<Id, CurveSnapshot>();
  for (const id of ids) { const c = findCurve(store.project, id); if (c) out.set(id, snapshotCurve(c)); }
  return out;
}

/** Re-apply an affine transform (plane coordinates) to curves from their drag-start snapshots. */
export function transformCurves(store: Store, originals: Map<Id, CurveSnapshot>, a: Affine2, live: boolean): void {
  store.update(() => {
    for (const [id, snap] of originals) { const c = findCurve(store.project, id); if (c) transformCurve(c, snap, a); }
  }, { history: !live });
}

/**
 * Re-apply an affine transform (plane coordinates) to the selected vertices of one
 * curve from its drag-start snapshot (Edit-mode gizmo): positions and handles of
 * `vids` change, pinned vertices stay, the other vertices are solved around them.
 */
export function transformVertices(store: Store, id: Id, original: CurveSnapshot, vids: Id[], a: Affine2, live: boolean): void {
  const c = cv(store, id);
  const moved = vids.filter((v) => !isPinned(c.constraints, v));
  if (!moved.length) return;
  const set = new Set(moved);
  store.update(() => {
    const scratch: CurveObject = { ...c, curve: { ...c.curve }, constraints: c.constraints };
    transformCurve(scratch, original, a);
    const byId = new Map(scratch.curve.points.map((v) => [v.id, v]));
    c.curve.points = original.points.map((v) => (set.has(v.id) ? byId.get(v.id)! : { ...v }));
    solveConstraints(c.curve, c.constraints, moved);
  }, { history: !live });
}

/** Set a plane's position and (optionally) rotation in degrees. */
export function setPlaneTransform(store: Store, planeId: Id, position: Vec3, rotation: Vec3 | null, live: boolean): void {
  store.update((s) => {
    const p = _findPlane(s.project, planeId);
    if (!p) return;
    p.placement.position = { ...position };
    if (rotation) {
      const r = { x: Math.round(rotation.x * 100) / 100, y: Math.round(rotation.y * 100) / 100, z: Math.round(rotation.z * 100) / 100 };
      const same = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
      p.placement.rotation = r;
      const preset = (Object.keys(PLANE_PRESETS) as PlanePreset[]).find((k) => same(PLANE_PRESETS[k].rotation, r));
      p.placement.preset = preset ?? 'custom';
    }
  }, { history: !live });
}
