import * as THREE from 'three/webgpu';
import type { Curve2D, Loft } from '../domain/types';
import { FILL_MATERIALS } from '../domain/catalog';
import { curvePath } from './pipe';

/**
 * Loft a surface between two or more pipe curves and fill it with material.
 * Each guide curve is sampled at N points (in world space) and consecutive
 * curves are stitched with quads.
 */
export function buildLoft(loft: Loft, curves: Map<string, Curve2D>, samples = 64): THREE.Mesh | null {
  const guides = loft.curveIds.map((id) => curves.get(id)).filter((c): c is Curve2D => !!c);
  if (guides.length < 2) return null;

  const rows: THREE.Vector3[][] = guides.map((c) => {
    const path = curvePath(c);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(c.position.x, c.position.y, c.position.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(c.rotation.x, c.rotation.y, c.rotation.z)),
      new THREE.Vector3(1, 1, 1),
    );
    return path.getSpacedPoints(samples).map((p) => p.applyMatrix4(m));
  });

  const positions: number[] = [];
  const indices: number[] = [];
  for (const row of rows) for (const p of row) positions.push(p.x, p.y, p.z);
  const w = samples + 1;
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < samples; i++) {
      const a = r * w + i, b = a + 1, c = a + w, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const fill = FILL_MATERIALS[loft.material];
  const material = new THREE.MeshStandardMaterial({
    color: fill.color,
    side: THREE.DoubleSide,
    metalness: loft.material === 'golden-garland' ? 0.8 : 0.0,
    roughness: loft.material === 'golden-garland' ? 0.4 : 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = loft.name;
  return mesh;
}
