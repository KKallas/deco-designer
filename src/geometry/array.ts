/**
 * The plane's array modifier (docs/26-array.md): the transform of every copy,
 * and committing those copies to real curve objects, welding ends that meet.
 * Pure — no store, no scene.
 */
import * as THREE from 'three/webgpu';
import { clone, uid, uniqueId, type ArrayModifier, type CurveObject, type Id, type Vec3, type Vertex, type VertexType, outlineKey } from '../model/types';

const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
const out3 = (p: THREE.Vector3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

/** The axis a circular array turns about, normalised; the plane normal when it is degenerate. */
export function arrayAxis(mod: ArrayModifier & { type: 'circular' }): THREE.Vector3 {
  const a = v3(mod.axis);
  return a.lengthSq() > 1e-12 ? a.normalize() : new THREE.Vector3(0, 0, 1);
}

/** Plane-local transforms of every copy (the first is the identity). */
export function instanceMatrices(mod: ArrayModifier | null): THREE.Matrix4[] {
  const out = [new THREE.Matrix4()];
  if (!mod) return out;
  const count = Math.min(200, Math.max(1, Math.round(mod.count)));
  if (mod.type === 'linear') {
    for (let i = 1; i < count; i++) {
      out.push(new THREE.Matrix4().makeTranslation(mod.offset.x * i, mod.offset.y * i, mod.offset.z * i));
    }
  } else {
    const full = Math.abs(mod.angle) >= 360 - 1e-6;
    const step = count > 1 ? ((mod.angle * Math.PI) / 180) / (full ? count : count - 1) : 0;
    const axis = arrayAxis(mod);
    const c = v3(mod.center);
    const toCenter = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z);
    const back = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
    for (let i = 1; i < count; i++) {
      out.push(new THREE.Matrix4().multiplyMatrices(toCenter, new THREE.Matrix4().makeRotationAxis(axis, step * i)).multiply(back));
    }
  }
  return out;
}

// -- commit ------------------------------------------------------------------

const EPS = 1e-6;

/** A copy of the curve moved by `m` (plane-local): points, handles, pins and the curve type follow. */
function transformCurve(src: CurveObject, m: THREE.Matrix4, name: string, taken: Id[]): CurveObject {
  const c = clone(src);
  c.id = uniqueId(`${src.id}-copy`, taken);
  c.name = name;
  const rot = new THREE.Matrix4().extractRotation(m);
  const map = new Map<Id, Id>();
  for (const v of c.curve.points) {
    const nid = uid();
    map.set(v.id, nid);
    v.id = nid;
    Object.assign(v, out3(v3(v).applyMatrix4(m)));
    v.in = out3(v3(v.in).applyMatrix4(rot));
    v.out = out3(v3(v.out).applyMatrix4(rot));
  }
  for (const k of c.constraints) {
    k.id = uid();
    k.a = map.get(k.a) ?? k.a;
    if (k.b) k.b = map.get(k.b) ?? k.b;
    if (k.at) k.at = out3(v3(k.at).applyMatrix4(m));
  }
  return c;
}

/** A curve that left its plane has to carry the offsets (docs/12-3d-curves.md). */
function retype(c: CurveObject): CurveObject {
  if (c.type === 'planar' && c.curve.points.some((v) => Math.abs(v.z) > EPS || Math.abs(v.in.z) > EPS || Math.abs(v.out.z) > EPS)) c.type = 'spatial';
  return c;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/** Reverse a strand: the point order and every vertex's in/out handles swap. */
function reversed(points: Vertex[]): Vertex[] {
  return [...points].reverse().map((v) => ({ ...v, in: v.out, out: v.in }));
}

/** The one vertex two welded ends become: midway, the outer handles kept. */
function weldVertex(a: Vertex, b: Vertex): Vertex {
  const type: VertexType = a.type === 'free' || b.type === 'free' ? 'free' : a.type === 'equal' || b.type === 'equal' ? 'equal' : 'polygon';
  return { ...a, ...mid(a, b), type, in: a.in, out: b.out };
}

const ends = (c: CurveObject) => ({ first: c.curve.points[0], last: c.curve.points[c.curve.points.length - 1] });

/**
 * Weld ends that meet within `merge` mm: two ends of different curves become one
 * curve (the shared vertex kept once, halfway between them), the two ends of one
 * curve close it. Only open curves of the same profile weld.
 */
export function weldCurves(list: CurveObject[], merge: number): CurveObject[] {
  const out = list.map((c) => clone(c));
  if (!(merge > 0)) return out;
  const open = (c: CurveObject) => !c.curve.closed && c.curve.points.length >= 2;

  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (!open(a)) continue;
    // keep pulling the nearest matching end onto this strand until nothing is close enough
    for (;;) {
      let best: { j: number; d: number; ra: boolean; rb: boolean } | null = null;
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const b = out[j];
        if (!open(b) || outlineKey(b) !== outlineKey(a)) continue;
        const ea = ends(a), eb = ends(b);
        const options: { d: number; ra: boolean; rb: boolean }[] = [
          { d: dist(ea.last, eb.first), ra: false, rb: false },
          { d: dist(ea.last, eb.last), ra: false, rb: true },
          { d: dist(ea.first, eb.first), ra: true, rb: false },
          { d: dist(ea.first, eb.last), ra: true, rb: true },
        ];
        for (const o of options) if (o.d <= merge && (!best || o.d < best.d)) best = { j, ...o };
      }
      if (!best) break;
      const b = out[best.j];
      const pa = best.ra ? reversed(a.curve.points) : a.curve.points;
      const pb = best.rb ? reversed(b.curve.points) : b.curve.points;
      a.curve.points = [...pa.slice(0, -1), weldVertex(pa[pa.length - 1], pb[0]), ...pb.slice(1)];
      a.constraints = [...a.constraints, ...b.constraints];
      if (b.type === 'spatial') a.type = 'spatial';
      out.splice(best.j, 1);
      if (best.j < i) i--;
    }
    // its own two ends meeting closes the curve
    const e = ends(a);
    if (a.curve.points.length >= 3 && dist(e.first, e.last) <= merge) {
      a.curve.points = [weldVertex(e.last, e.first), ...a.curve.points.slice(1, -1)];
      a.curve.closed = true;
    }
  }
  return out;
}

/**
 * The curves a plane ends up with when its array is committed (docs/26-array.md §4):
 * every copy becomes a real curve on the same plane — the first keeps the source
 * curve — and ends that meet within `merge` mm are welded. Pure; the panel's count
 * preview and `cmd.commitArray` call this.
 */
export function commitArray(mod: ArrayModifier | null, curves: CurveObject[], merge: number, taken: Iterable<Id> = []): CurveObject[] {
  const mats = instanceMatrices(mod);
  const ids = [...taken, ...curves.map((c) => c.id)];
  const copies: CurveObject[] = [];
  for (const c of curves) {
    if (!c.curve.points.length) { copies.push(clone(c)); continue; }
    copies.push(retype(clone(c)));
    for (let i = 1; i < mats.length; i++) {
      const copy = retype(transformCurve(c, mats[i], `${c.name} · ${i + 1}`, ids));
      ids.push(copy.id);
      copies.push(copy);
    }
  }
  return weldCurves(copies, merge);
}
