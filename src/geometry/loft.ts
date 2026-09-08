import * as THREE from 'three/webgpu';
import { checker, color, mix, uv } from 'three/tsl';
import { loftEdge, type CurveObject, type Loft, type LoftEdge } from '../model/types';
import { curvePath } from './curve';

/** Default loft look: a black / white checkerboard of CHECKER_MM squares, painted from the mm uvs (independent of the grid). */
export const CHECKER_MM = 100;
const checkerMaterials = new Map<boolean, THREE.MeshStandardNodeMaterial>();
export function checkerMaterial(selected = false): THREE.MeshStandardNodeMaterial {
  let m = checkerMaterials.get(selected);
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    m.colorNode = mix(color(0x202024), color(0xe8e8ec), checker(uv().div(CHECKER_MM)));
    if (selected) { m.emissive = new THREE.Color(0x4f8cff); m.emissiveIntensity = 0.35; }
    checkerMaterials.set(selected, m);
  }
  return m;
}

/** World-space samples of a curve by equal arc length, given its plane's world matrix. */
function sampleWorld(c: CurveObject, m: THREE.Matrix4, n: number): THREE.Vector3[] {
  return curvePath(c.curve.points, c.curve.closed).getSpacedPoints(n).map((p) => p.applyMatrix4(m));
}

/**
 * One loft edge in world mm: `n + 1` points by equal arc length over the span left by the
 * trim (docs/24-loft-trim.md §2). `trim.start` / `trim.end` are mm cut off each end;
 * **negative extends past the control curve**, straight along that end's tangent. Null when
 * the trims eat the whole curve.
 */
function sampleEdge(c: CurveObject, m: THREE.Matrix4, n: number, trim: LoftEdge): THREE.Vector3[] | null {
  if (!trim.start && !trim.end) return sampleWorld(c, m, n);
  const dense = sampleWorld(c, m, Math.max(4 * n, 256));   // arc-length table to read the trimmed span off
  const l = arcLengths(dense);
  const total = l[l.length - 1];
  const s0 = trim.start, s1 = total - trim.end;
  if (!(total > 0) || !(s1 - s0 > 1e-6)) return null;
  const ends = (i: number, j: number) => dense[i].clone().sub(dense[j]).normalize();   // outward tangent at an end
  const head = ends(0, 1), tail = ends(dense.length - 1, dense.length - 2);
  const at = (s: number): THREE.Vector3 => {
    if (s <= 0) return dense[0].clone().addScaledVector(head, -s);
    if (s >= total) return dense[dense.length - 1].clone().addScaledVector(tail, s - total);
    let i = 1;
    while (i < l.length - 1 && l[i] < s) i++;
    const span = l[i] - l[i - 1];
    return dense[i - 1].clone().lerp(dense[i], span > 0 ? (s - l[i - 1]) / span : 0);
  };
  return Array.from({ length: n + 1 }, (_, i) => at(s0 + ((s1 - s0) * i) / n));
}

/**
 * Move the edges off their control curves (docs/24-loft-trim.md §3), each along one of the
 * band's own directions: `offset` **across the ruling** (+ outwards, away from the other curve)
 * and `lift` **along the loft's normal** (+ out of the front of the surface, - behind it).
 * Both frames are read off the trimmed edges before anything moves, so a parallel band stays
 * parallel and a flat one stays flat. Where the frame degenerates (a ruling of zero length, a
 * ruling running along the band) the offset stays put and the lift falls back to `normal`.
 */
function moveEdges(ra: THREE.Vector3[], rb: THREE.Vector3[], ea: LoftEdge, eb: LoftEdge, normal: THREE.Vector3): void {
  if (!ea.offset && !eb.offset && !ea.lift && !eb.lift) return;
  const n = ra.length;
  const centre = ra.map((p, i) => p.clone().add(rb[i]).multiplyScalar(0.5));   // the band's centreline: its tangent
  const across: THREE.Vector3[] = [], out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const d = new THREE.Vector3().subVectors(rb[i], ra[i]);
    const len = d.length();
    if (len > 1e-6) d.divideScalar(len); else d.set(0, 0, 0);
    const t = new THREE.Vector3().subVectors(centre[Math.min(n - 1, i + 1)], centre[Math.max(0, i - 1)]);
    const nor = new THREE.Vector3().crossVectors(t, d);
    across.push(d);
    out.push(nor.length() > 1e-6 ? nor.normalize() : normal.clone());
  }
  for (let i = 0; i < n; i++) {
    ra[i].addScaledVector(across[i], -ea.offset).addScaledVector(out[i], ea.lift);
    rb[i].addScaledVector(across[i], eb.offset).addScaledVector(out[i], eb.lift);
  }
}

export interface LoftBuild { mesh: THREE.Mesh; samples: number; flipped: boolean }

/** Cumulative chord length (mm) of a polyline, one entry per point, starting at 0. */
function arcLengths(pts: THREE.Vector3[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return out;
}

/**
 * Loft UVs are in **millimetres** (docs/05-loft.md §2): `u` = distance along the
 * curve, `v` = distance across from curve A. Make `texture` tile every
 * `tileMm` × `tileMm` mm of surface (aspect ratio via `tileMmV`).
 */
export function fitTextureToLoft<T extends THREE.Texture>(texture: T, tileMm: number, tileMmV = tileMm): T {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / tileMm, 1 / tileMmV);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Surface between two curves: both **trimmed** by their edge settings (docs/24-loft-trim.md) and
 * resampled to `resolution × max(vertices)`
 * points, ruling i→i, `strips` rows across; the default material paints a
 * 100 mm checkerboard from the uvs (`material` overrides it). Rulings crossing (opposite directions) is avoided by picking
 * the orientation with the shorter total ruling length, unless `flip` is set.
 * UVs are millimetres of surface (`u` along the band — the mean of the two
 * edges' arc lengths at each ruling, `v` across the ruling) so a material keeps
 * its physical size and its grid follows the rulings — see fitTextureToLoft.
 */
/** `matrixA` / `matrixB` are the **world** matrices of the two curves' planes (nested objects included — docs/18-nested-objects.md §2). */
export function buildLoft(loft: Loft, a: CurveObject, b: CurveObject, matrixA: THREE.Matrix4, matrixB: THREE.Matrix4, selected = false, material?: THREE.Material): LoftBuild | null {
  if (a.curve.points.length < 2 || b.curve.points.length < 2) return null;
  const n = Math.max(2, Math.round(Math.max(1, loft.resolution) * Math.max(a.curve.points.length, b.curve.points.length)));
  const strips = Math.max(1, Math.round(loft.strips));
  // each curve is trimmed first, so the direction choice, the rulings and the uvs all see the trimmed edges
  const ea = loftEdge(loft, 'a'), eb = loftEdge(loft, 'b');
  const ra = sampleEdge(a, matrixA, n, ea);
  let rb = sampleEdge(b, matrixB, n, eb);
  if (!ra || !rb) return null;
  const total = (q: THREE.Vector3[]) => ra.reduce((s, p, i) => s + p.distanceTo(q[i]), 0);
  const reversed = [...rb].reverse();
  let flipped = total(reversed) < total(rb);
  if (loft.flip) flipped = !flipped;
  if (flipped) rb = reversed;
  moveEdges(ra, rb, ea, eb, new THREE.Vector3().setFromMatrixColumn(matrixA, 2).normalize());   // curve A's plane normal is the fallback

  const positions: number[] = [];
  const uvs: number[] = [];
  // uv in mm: u = mean arc length of the two edges at the ruling (constant along it, so iso-lines follow the
  // rulings — a fan between two arcs reads as sun rays), v = distance across the ruling from curve A
  const la = arcLengths(ra), lb = arcLengths(rb);
  const at = (i: number, s: number) => {
    const t = s / strips;
    return { p: ra[i].clone().lerp(rb[i], t), u: (la[i] + lb[i]) / 2, v: t * ra[i].distanceTo(rb[i]) };
  };
  const push = (q: { p: THREE.Vector3; u: number; v: number }) => { positions.push(q.p.x, q.p.y, q.p.z); uvs.push(q.u, q.v); };
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < strips; s++) {
      const p00 = at(i, s), p10 = at(i + 1, s), p01 = at(i, s + 1), p11 = at(i + 1, s + 1);
      push(p00); push(p10); push(p11);
      push(p00); push(p11); push(p01);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material ?? checkerMaterial(selected));
  mesh.userData = { loftId: loft.id, cachedMaterial: true };
  mesh.castShadow = mesh.receiveShadow = true;
  return { mesh, samples: n, flipped };
}
