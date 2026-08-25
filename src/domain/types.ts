/**
 * Project model. A design is a set of 2D curves (turned into pipes),
 * optional lofts between curves (filled with material), and LED light
 * strings laid along 3D curves on top of the finished structure.
 * All coordinates are in millimetres.
 */
import type { FillMaterial } from './catalog';

export type Id = string;

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

/** A 2D curve drawn in a plane; becomes an aluminium pipe. */
export interface Curve2D {
  id: Id;
  name: string;
  /** Control points; the curve is interpolated smoothly through them. */
  points: Vec2[];
  closed: boolean;
  /** Transform placing the 2D plane in 3D space. */
  position: Vec3;
  /** Euler rotation in radians. */
  rotation: Vec3;
  /** Pipe catalog id (see catalog.PIPES). */
  pipeId: string;
}

/** A surface lofted between two or more pipe curves, filled with material. */
export interface Loft {
  id: Id;
  name: string;
  /** Ordered curve ids used as loft guides. */
  curveIds: Id[];
  material: FillMaterial;
}

/** A 3D curve on top of the design, used as a guide for an LED string. */
export interface LightString {
  id: Id;
  name: string;
  points: Vec3[];
  /** LED string catalog id (see catalog.LED_STRINGS). */
  stringId: string;
  /** Hex colour of the LED top. */
  color: number;
}

export interface DecoProject {
  version: 1;
  name: string;
  curves: Curve2D[];
  lofts: Loft[];
  lights: LightString[];
}

export function emptyProject(name = 'Untitled'): DecoProject {
  return { version: 1, name, curves: [], lofts: [], lights: [] };
}
