import * as THREE from 'three/webgpu';
import type { Curve2D } from '../domain/types';
import { PIPES } from '../domain/catalog';

/** Build a smooth 3D path from a 2D curve's control points (in its local XY plane). */
export function curvePath(curve: Curve2D): THREE.Curve<THREE.Vector3> {
  const pts = curve.points.map((p) => new THREE.Vector3(p.x, p.y, 0));
  if (pts.length === 2) return new THREE.LineCurve3(pts[0], pts[1]);
  return new THREE.CatmullRomCurve3(pts, curve.closed, 'centripetal');
}

const ALU = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 0.9, roughness: 0.35 });

/** Turn a 2D curve into an aluminium pipe mesh (round tube or square extrusion). */
export function buildPipe(curve: Curve2D): THREE.Mesh {
  const spec = PIPES[curve.pipeId] ?? PIPES.round25;
  const path = curvePath(curve);
  const segments = Math.max(16, Math.round(path.getLength() / 10));

  let geometry: THREE.BufferGeometry;
  if (spec.profile === 'round') {
    geometry = new THREE.TubeGeometry(path, segments, spec.size / 2, 16, curve.closed);
  } else {
    const half = spec.size / 2;
    const shape = new THREE.Shape([
      new THREE.Vector2(-half, -half),
      new THREE.Vector2(half, -half),
      new THREE.Vector2(half, half),
      new THREE.Vector2(-half, half),
    ]);
    geometry = new THREE.ExtrudeGeometry(shape, { extrudePath: path, steps: segments, bevelEnabled: false });
  }

  const mesh = new THREE.Mesh(geometry, ALU);
  mesh.name = curve.name;
  mesh.position.set(curve.position.x, curve.position.y, curve.position.z);
  mesh.rotation.set(curve.rotation.x, curve.rotation.y, curve.rotation.z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
