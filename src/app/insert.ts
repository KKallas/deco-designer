/**
 * Copying an object subtree into a project — within it (⌘D) or in from an
 * archive item (docs/33-object-archive.md §6). One walk: groups, planes,
 * curves, lofts and shapes, every id remapped against the target, every
 * cross-reference rewritten. Asset ids (profiles, fills, materials, textures,
 * animations) are *not* touched — the caller merges those first
 * (src/app/archive.ts), so within one project this is a plain copy.
 */
import {
  clone, findGroup, findPlane, loftsOfGroup, shapesOfGroup, subtreeGroups, uid, uniqueId,
  type CurveObject, type Id, type ObjectGroup, type Project, type Shape, type Vec3,
} from '../model/types';

export interface InsertResult {
  /** the copied root object in the target */
  root: Id;
  groups: Map<Id, Id>;
  planes: Map<Id, Id>;
  curves: Map<Id, Id>;
}

export interface InsertOpts {
  /** the object to put the copy in; null = a root object (default) */
  into?: Id | null;
  /** added to the root's own placement, e.g. the 200 mm ⌘D shift */
  offset?: Partial<Vec3>;
  /** the copy's name (the source's by default) */
  name?: string;
}

/** A deep copy of the curve with a free id and fresh vertex / constraint ids. */
export function copyCurveInto(src: CurveObject, taken: Iterable<Id>, dx = 0): CurveObject {
  const copy = clone(src);
  copy.id = uniqueId(src.id, taken);
  const map = new Map<Id, Id>();
  for (const v of copy.curve.points) { const nid = uid(); map.set(v.id, nid); v.id = nid; v.x += dx; }
  for (const k of copy.constraints) { k.id = uid(); k.a = map.get(k.a) ?? k.a; if (k.b) k.b = map.get(k.b) ?? k.b; if (k.at) k.at = { ...k.at, x: k.at.x + dx }; }
  return copy;
}

/**
 * Copy the object `groupId` of `source` (with everything under it) into
 * `target`, which is mutated. `source` may be `target` itself (duplicate).
 * Returns the new ids, or null if there is no such object.
 */
export function insertGroup(target: Project, source: Project, groupId: Id, opts: InsertOpts = {}): InsertResult | null {
  const src = findGroup(source, groupId);
  if (!src) return null;
  const subtree = subtreeGroups(source, src);
  const takenGroups = target.groups.map((g) => g.id);
  const groups = new Map<Id, Id>();
  for (const g of subtree) { const nid = uniqueId(g.id, takenGroups); takenGroups.push(nid); groups.set(g.id, nid); }
  const root = groups.get(src.id)!;
  const planes = new Map<Id, Id>(), curves = new Map<Id, Id>();
  const takenPlanes = target.planes.map((p) => p.id), takenCurves = target.curves.map((c) => c.id);

  for (const g of subtree) {
    const copy: ObjectGroup = {
      id: groups.get(g.id)!,
      name: g.id === src.id ? opts.name ?? g.name : g.name,
      planes: [],
      groups: g.groups.map((c) => groups.get(c)).filter((x): x is Id => !!x),
      placement: clone(g.placement),
      visible: g.visible,
    };
    if (g.id === src.id && opts.offset) {
      const p = copy.placement.position, o = opts.offset;
      copy.placement.position = { x: p.x + (o.x ?? 0), y: p.y + (o.y ?? 0), z: p.z + (o.z ?? 0) };
    }
    for (const pid of g.planes) {
      const srcPlane = findPlane(source, pid);
      if (!srcPlane) continue;
      const plane = clone(srcPlane);
      plane.id = uniqueId(srcPlane.id, takenPlanes);
      takenPlanes.push(plane.id);
      planes.set(pid, plane.id);
      copy.planes.push(plane.id);
      target.planes.push(plane);
      for (const c of source.curves.filter((x) => x.planeId === pid)) {
        const cc = copyCurveInto(c, takenCurves);
        cc.planeId = plane.id;
        takenCurves.push(cc.id);
        curves.set(c.id, cc.id);
        target.curves.push(cc);
      }
    }
    target.groups.push(copy);
  }

  const takenLofts = target.lofts.map((l) => l.id);
  for (const l of loftsOfGroup(source, src)) {
    const a = curves.get(l.a), b = curves.get(l.b);
    if (!a || !b) continue;
    const copy = { ...clone(l), id: uniqueId(l.id, takenLofts), a, b };
    takenLofts.push(copy.id);
    target.lofts.push(copy);
  }

  // shapes come along with their curves (docs/30 §4), each with its layers
  const takenShapes = target.shapes.map((sh) => sh.id);
  for (const sh of shapesOfGroup(source, src)) {
    const list = sh.curves.map((id) => curves.get(id)).filter((id): id is Id => !!id);
    if (!list.length) continue;
    const copy: Shape = { ...clone(sh), id: uniqueId(sh.id, takenShapes), curves: list };
    takenShapes.push(copy.id);
    target.shapes.push(copy);
  }

  const parent = opts.into ? findGroup(target, opts.into) : null;
  if (parent && !parent.groups.includes(root)) parent.groups.push(root);
  return { root, groups, planes, curves };
}
