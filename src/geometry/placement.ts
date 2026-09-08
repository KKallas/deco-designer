import * as THREE from 'three/webgpu';
import { groupChain, groupOfPlane, type Id, type Placement, type Plane, type Project, type Vec2, type Vec3 } from '../model/types';

const DEG = Math.PI / 180;

export function planeEuler(pl: Placement): THREE.Euler {
  return new THREE.Euler(pl.rotation.x * DEG, pl.rotation.y * DEG, pl.rotation.z * DEG);
}

export function planeMatrix(pl: Placement): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pl.position.x, pl.position.y, pl.position.z),
    new THREE.Quaternion().setFromEuler(planeEuler(pl)),
    new THREE.Vector3(1, 1, 1),
  );
}

/** World-space frame of a placement: origin, in-plane axes, normal, and both matrices. */
export interface PlaneFrame {
  origin: THREE.Vector3;
  x: THREE.Vector3;
  y: THREE.Vector3;
  normal: THREE.Vector3;
  matrix: THREE.Matrix4;
  inverse: THREE.Matrix4;
  plane: THREE.Plane;
}

export function planeFrame(pl: Placement): PlaneFrame {
  const matrix = planeMatrix(pl);
  const origin = new THREE.Vector3().setFromMatrixPosition(matrix);
  const x = new THREE.Vector3(1, 0, 0).transformDirection(matrix);
  const y = new THREE.Vector3(0, 1, 0).transformDirection(matrix);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
  return { origin, x, y, normal, matrix, inverse: matrix.clone().invert(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin) };
}

/**
 * World matrix of an object's frame: the placements of its ancestor chain, outermost first
 * (docs/18-nested-objects.md §2). Identity for a top-level object or none.
 */
export function groupMatrix(project: Project, groupId: Id | null): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  for (const g of groupChain(project, groupId)) m.multiply(planeMatrix(g.placement));
  return m;
}

/** World matrix of whatever contains this plane (identity when it is top level). */
export function planeParentMatrix(project: Project, planeId: Id): THREE.Matrix4 {
  return groupMatrix(project, groupOfPlane(project, planeId)?.id ?? null);
}

/** World frame of a plane: the objects it sits in, then its own placement. */
export function planeWorld(project: Project, plane: Plane): PlaneFrame {
  const parent = planeParentMatrix(project, plane.id);
  const m = parent.multiply(planeMatrix(plane.placement));
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const x = new THREE.Vector3(1, 0, 0).transformDirection(m);
  const y = new THREE.Vector3(0, 1, 0).transformDirection(m);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(m);
  return { origin, x, y, normal, matrix: m, inverse: m.clone().invert(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin) };
}

/** A rigid world matrix expressed in `parent`'s coordinates, as a placement's position + rotation (degrees). */
export function localPlacement(parent: THREE.Matrix4, world: THREE.Matrix4): { position: Vec3; rotation: Vec3 } {
  const local = parent.clone().invert().multiply(world);
  const position = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  local.decompose(position, quat, scale);
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  const DEG = 180 / Math.PI, r = (n: number) => Math.round(n * 100) / 100;
  return { position: { x: position.x, y: position.y, z: position.z }, rotation: { x: r(e.x * DEG), y: r(e.y * DEG), z: r(e.z * DEG) } };
}

/** A world-space direction (a drag delta) in `parent`'s coordinates. */
export function localDelta(parent: THREE.Matrix4, delta: THREE.Vector3): Vec3 {
  const d = delta.clone().applyMatrix4(new THREE.Matrix4().extractRotation(parent).transpose());
  return { x: d.x, y: d.y, z: d.z };
}

/** World point → plane-local 2D (the component along the normal is dropped). */
export function toPlane(frame: PlaneFrame, world: THREE.Vector3): Vec2 {
  const p = world.clone().applyMatrix4(frame.inverse);
  return { x: p.x, y: p.y };
}

/** World point → plane-local 3D (x, y in the plane, z along the normal). */
export function toPlane3(frame: PlaneFrame, world: THREE.Vector3): Vec3 {
  const p = world.clone().applyMatrix4(frame.inverse);
  return { x: p.x, y: p.y, z: p.z };
}

/** Plane-local → world; a vertex brings its own normal offset `z` (docs/12-3d-curves.md), `z` overrides it. */
export function fromPlane(frame: PlaneFrame, p: Vec2 & { z?: number }, z = p.z ?? 0): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, z).applyMatrix4(frame.matrix);
}

/** The plane parallel to the frame's plane at normal offset `z` (where a raised vertex is dragged). */
export function offsetPlane(frame: PlaneFrame, z: number): THREE.Plane {
  return new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, frame.origin.clone().addScaledVector(frame.normal, z));
}
