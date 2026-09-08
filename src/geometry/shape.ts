/**
 * Shape programs (docs/14-shapes.md): a profile's code `(three, curve,
 * params) => BufferGeometry` run on a curve. The curve is handed over in
 * plane-local mm with its Bézier path, samples and frames; `three` is the
 * three.js namespace plus `sweep` / `rect` / `circle` / `mergeGeometries`.
 * The result is checked (normals computed if missing, uv reported).
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color as tslColor, vec3 } from 'three/tsl';
import type { Curve, CurveObject, Profile, Vertex } from '../model/types';
import { curvePath, sampleCurve, type CurveSampling, type Sample } from './curve';
import { circle, rect, sweep } from './sweep';

/** What a shape program receives as `curve`. */
export interface ShapeCurve {
  id: string;
  name: string;
  /** control vertices with handles, plane-local mm */
  points: Vertex[];
  closed: boolean;
  /** the cubic Bézier path: getPointAt(t) / getTangentAt(t) / getLength() */
  path: THREE.CurvePath<THREE.Vector3>;
  /** mm */
  length: number;
  /** every ~5 mm along the curve */
  samples: Sample[];
  /** parallel-transport frames at `steps` + 1 points along the path */
  frames: (steps: number) => { points: THREE.Vector3[]; tangents: THREE.Vector3[]; normals: THREE.Vector3[]; binormals: THREE.Vector3[] };
  /** the plane's normal in curve space (+Z) — sections that stay flat to the plane use it */
  planeNormal: THREE.Vector3;
}

export type ShapeParams = Record<string, number>;

/** The `three` a program sees. */
export const THREE_SCOPE = { ...THREE, mergeGeometries, sweep, rect, circle };

/** Build the input for a curve (sampling is reused when given). */
export function shapeInput(c: Pick<CurveObject, 'id' | 'name' | 'curve'>, sampling?: CurveSampling): ShapeCurve | null {
  const curve: Curve = c.curve;
  if (curve.points.length < 2) return null;
  const s = sampling && sampling.path ? sampling : sampleCurve(curve);
  const path = s.path ?? curvePath(curve.points, curve.closed);
  if (!(s.length > 0)) return null;
  const closed = curve.closed && curve.points.length > 2;
  return {
    id: c.id, name: c.name, points: curve.points, closed, path, length: s.length, samples: s.samples,
    frames: (steps) => {
      const n = Math.max(1, Math.round(steps));
      const f = path.computeFrenetFrames(n, closed);
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) points.push(path.getPointAt(i / n));
      if (closed) mitreSeam(points, f.tangents, f.normals, f.binormals, n);
      return { points, tangents: f.tangents, normals: f.normals, binormals: f.binormals };
    },
    planeNormal: new THREE.Vector3(0, 0, 1),
  };
}

/**
 * A closed curve's seam sits on a control vertex, and three clamps the tangent
 * at t = 0 / 1 to one side of it — so a corner there gets two half sections
 * crossing at the turn instead of the mitre every other corner gets (the
 * tangent inside the path is the chord across the corner). Give both ends the
 * same mitred frame: the bisector of the incoming and outgoing tangents.
 */
function mitreSeam(points: THREE.Vector3[], tangents: THREE.Vector3[], normals: THREE.Vector3[], binormals: THREE.Vector3[], n: number): void {
  const t = tangents[0].clone().add(tangents[n]);
  if (t.lengthSq() < 1e-10) return;                       // a fold back on itself: nothing to bisect
  t.normalize();
  const nrm = normals[0].clone().addScaledVector(t, -normals[0].dot(t));
  if (nrm.lengthSq() > 1e-10) nrm.normalize(); else nrm.copy(normals[0]);
  points[n].copy(points[0]);
  for (const i of [0, n]) {
    tangents[i].copy(t);
    normals[i].copy(nrm);
    binormals[i].crossVectors(t, nrm);
  }
}

export interface ShapeInfo { vertices: number; triangles: number; hasUv: boolean; ms: number }

/** Compile the program (comments stripped like material code) — throws on a syntax error. */
export function compileShape(code: string): (three: typeof THREE_SCOPE, curve: ShapeCurve, params: ShapeParams) => unknown {
  const body = code.replace(/^\s*\/\/.*$/gm, '').trim();
  return new Function('three', 'curve', 'params', `"use strict"; return (${body})(three, curve, params);`) as (t: typeof THREE_SCOPE, c: ShapeCurve, p: ShapeParams) => unknown;
}

/** Run a shape on a curve. Throws with the JS error if the code is broken or returns no geometry. */
export function buildShapeGeometry(code: string, curve: ShapeCurve, params: ShapeParams): { geometry: THREE.BufferGeometry; info: ShapeInfo } {
  const t0 = performance.now();
  const out = compileShape(code)(THREE_SCOPE, curve, { ...params });
  if (!(out instanceof THREE.BufferGeometry)) throw new Error('the code must return a three.BufferGeometry');
  const pos = out.getAttribute('position');
  if (!pos || pos.count === 0) throw new Error('the geometry has no vertices');
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  const idx = out.getIndex();
  return { geometry: out, info: { vertices: pos.count, triangles: Math.floor((idx ? idx.count : pos.count) / 3), hasUv: !!out.getAttribute('uv'), ms: performance.now() - t0 } };
}

/** The mesh of a curve bent from a profile with `params` (the profile's own by default); throws like buildShapeGeometry. */
export function curveGeometry(c: Pick<CurveObject, 'id' | 'name' | 'curve'>, profile: Profile, params: Record<string, number> = profile.params, sampling?: CurveSampling): THREE.BufferGeometry | null {
  const input = shapeInput(c, sampling);
  return input ? buildShapeGeometry(profile.code, input, { ...profile.params, ...params }).geometry : null;
}

/**
 * The default look of a mesh whose program wrote `color` / `emissive` vertex attributes (an LED string's
 * lit tips): a node material reading them, with an optional selection glow added. null when the geometry
 * has neither (the caller uses its plain material).
 */
export function attributeMaterial(color: string, geo: THREE.BufferGeometry, glow: { color: number; intensity: number } | null): THREE.MeshStandardNodeMaterial | null {
  const hasColor = geo.hasAttribute('color'), hasEmissive = geo.hasAttribute('emissive');
  if (!hasColor && !hasEmissive) return null;
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.15, roughness: 0.55 });
  const attr = (name: string) => vec3(attribute(name, 'vec3') as unknown as THREE.Node<'vec3'>);
  m.colorNode = hasColor ? attr('color') : tslColor(color);
  const own = hasEmissive ? attr('emissive') : null;
  const g = glow ? tslColor(glow.color).mul(glow.intensity) : null;
  const e = own && g ? own.add(g) : own ?? g;
  if (e) m.emissiveNode = e as THREE.Node;
  return m;
}

/** What a curve shows when its program fails: a thin Ø8 tube. */
export function fallbackGeometry(curve: ShapeCurve): THREE.BufferGeometry {
  return new THREE.TubeGeometry(curve.path, Math.min(600, Math.max(8, Math.round(curve.length / 10))), 4, 8, curve.closed);
}
