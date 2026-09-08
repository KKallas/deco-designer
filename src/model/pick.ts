/**
 * Selection filter (docs/08-selection-filter.md). Pure: which thing a click in
 * the viewport selects, given what the ray hit and which levels are enabled.
 * Levels from lowest to highest: curve · surface (lofts and shapes) · plane · object.
 */
import { findShape, findCurve, groupOfPlane, rootGroupOf, shapePlane, type Id, type ObjectGroup, type Project } from './types';

export type PickLevel = 'curve' | 'loft' | 'plane' | 'object';
export const PICK_LEVELS: PickLevel[] = ['curve', 'loft', 'plane', 'object'];

export type PickFilter = Record<PickLevel, boolean>;
export const ALL_LEVELS: PickFilter = { curve: true, loft: true, plane: true, object: true };

/** What the ray hit first: a curve's tube, a loft's surface or a shape's layer (docs/30-outline-and-shape-layers.md). */
export interface PickHit { curveId: Id | null; loftId: Id | null; shapeId?: Id | null }

export type PickTarget =
  | { kind: 'curve'; id: Id }
  | { kind: 'loft'; id: Id }
  | { kind: 'shape'; id: Id }
  | { kind: 'plane'; id: Id; curveId: Id }
  | { kind: 'object'; id: Id; curveId: Id | null };

/** The outermost object a plane sits in (docs/18-nested-objects.md §3: a click selects the root, a double-click steps in). */
function objectOfPlane(project: Project, planeId: Id): ObjectGroup | null {
  const g = groupOfPlane(project, planeId);
  return g ? rootGroupOf(project, g.id) : null;
}

/**
 * The lowest enabled level the hit belongs to, or null (the click then acts as
 * a click on empty space). A curve belongs to itself, its plane and its
 * object; a loft to itself and to the object that contains both its curves; a
 * shape to itself and to the object of the plane it is built on. The `loft` level is
 * the surface level: it covers shapes too (docs/28 §5).
 */
export function resolvePick(project: Project, filter: PickFilter, hit: PickHit): PickTarget | null {
  if (hit.curveId) {
    const c = findCurve(project, hit.curveId);
    if (!c) return null;
    if (filter.curve) return { kind: 'curve', id: c.id };
    if (filter.plane) return { kind: 'plane', id: c.planeId, curveId: c.id };
    const g = filter.object ? objectOfPlane(project, c.planeId) : null;
    return g ? { kind: 'object', id: g.id, curveId: c.id } : null;
  }
  if (hit.shapeId) {
    if (filter.loft) return { kind: 'shape', id: hit.shapeId };
    if (!filter.object) return null;
    const sh = findShape(project, hit.shapeId);
    const pl = sh && shapePlane(project, sh);
    const g = pl ? objectOfPlane(project, pl.id) : null;
    return g ? { kind: 'object', id: g.id, curveId: null } : null;
  }
  if (hit.loftId) {
    if (filter.loft) return { kind: 'loft', id: hit.loftId };
    if (!filter.object) return null;
    const l = project.lofts.find((x) => x.id === hit.loftId);
    const a = l && findCurve(project, l.a), b = l && findCurve(project, l.b);
    if (!a || !b) return null;
    const g = objectOfPlane(project, a.planeId);
    return g && objectOfPlane(project, b.planeId)?.id === g.id ? { kind: 'object', id: g.id, curveId: null } : null;
  }
  return null;
}
