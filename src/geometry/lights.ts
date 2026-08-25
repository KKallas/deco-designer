import * as THREE from 'three/webgpu';
import type { LightString } from '../domain/types';
import { LED_STRINGS, litLength } from '../domain/catalog';

const WIRE = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.8 });
const LED_BODY = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 });

export interface LightBuildResult {
  group: THREE.Group;
  /** Path length of the guide curve. */
  pathLength: number;
  /** Length covered by LEDs on the chosen string. */
  litLength: number;
  /** LEDs actually placed (limited by the string's ledCount). */
  ledsPlaced: number;
  /** True when the guide curve is longer than the string can light. */
  tooLong: boolean;
}

/**
 * Lay an LED string along a 3D guide curve: three twisted 4 mm wires with a
 * 40 mm × Ø8 mm LED every 50 mm, standing perpendicular to the curve.
 */
export function buildLightString(light: LightString): LightBuildResult {
  const spec = LED_STRINGS[light.stringId] ?? LED_STRINGS.led5m;
  const pts = light.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const path = pts.length === 2 ? new THREE.LineCurve3(pts[0], pts[1]) : new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const pathLength = path.getLength();
  const lit = litLength(spec);

  const group = new THREE.Group();
  group.name = light.name;

  // Twisted wire bundle: three tubes offset around the guide, rotating along it.
  const segments = Math.max(32, Math.round(pathLength / 5));
  const frames = path.computeFrenetFrames(segments, false);
  const r = spec.wireDiameter / 2;
  const twistTurnsPerMm = 1 / 60; // one full twist per 60 mm
  for (let w = 0; w < spec.wireCount; w++) {
    const wirePts: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = (w / spec.wireCount) * Math.PI * 2 + t * pathLength * twistTurnsPerMm * Math.PI * 2;
      const p = path.getPointAt(t);
      const n = frames.normals[i], b = frames.binormals[i];
      wirePts.push(p.clone().addScaledVector(n, Math.cos(angle) * r * 1.15).addScaledVector(b, Math.sin(angle) * r * 1.15));
    }
    const wire = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wirePts), segments, r, 6, false), WIRE);
    group.add(wire);
  }

  // LEDs every `pitch` mm, up to ledCount.
  const opaqueH = spec.led.height * spec.led.opaqueFraction;
  const litH = spec.led.height - opaqueH;
  const ledR = spec.led.thickness / 2;
  const bodyGeo = new THREE.CylinderGeometry(ledR, ledR, opaqueH, 12);
  const topGeo = new THREE.CylinderGeometry(ledR, ledR, litH, 12);
  const topMat = new THREE.MeshStandardMaterial({ color: light.color, emissive: light.color, emissiveIntensity: 2 });

  const maxByLength = Math.floor(pathLength / spec.pitch) + 1;
  const count = Math.min(spec.ledCount, maxByLength);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const d = i * spec.pitch;
    const t = Math.min(1, d / pathLength);
    const p = path.getPointAt(t);
    const tangent = path.getTangentAt(t);
    // LED stands "up" relative to the curve: perpendicular to tangent, biased toward world up.
    let dir = up.clone().sub(tangent.clone().multiplyScalar(up.dot(tangent)));
    if (dir.lengthSq() < 1e-6) dir = new THREE.Vector3(0, 0, 1);
    dir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);

    const body = new THREE.Mesh(bodyGeo, LED_BODY);
    body.position.copy(p).addScaledVector(dir, r + opaqueH / 2);
    body.quaternion.copy(q);
    const top = new THREE.Mesh(topGeo, topMat);
    top.position.copy(p).addScaledVector(dir, r + opaqueH + litH / 2);
    top.quaternion.copy(q);
    group.add(body, top);
  }

  return { group, pathLength, litLength: lit, ledsPlaced: count, tooLong: pathLength > lit };
}
