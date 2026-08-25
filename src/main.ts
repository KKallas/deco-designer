import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { emptyProject } from './domain/types';
import { LED_COLORS } from './domain/catalog';
import { buildPipe } from './geometry/pipe';
import { buildLoft } from './geometry/loft';
import { buildLightString } from './geometry/lights';

// ---------------------------------------------------------------------------
// Renderer (WebGPU, falls back to WebGL2 automatically when unavailable)
// ---------------------------------------------------------------------------
const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);
hud.textContent = `Deco Designer — ${(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'}`;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1f);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 50_000);
camera.position.set(1500, 1200, 2200);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 400, 0);
controls.enableDamping = true;

// Lights & ground (1 unit = 1 mm)
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(2000, 3000, 1500);
sun.castShadow = true;
scene.add(sun);
scene.add(new THREE.GridHelper(4000, 40, 0x444444, 0x2a2a30));

// ---------------------------------------------------------------------------
// Demo project: two arch curves -> round pipes, lofted with golden garland,
// and a 5 m LED string laid along the top arch.
// ---------------------------------------------------------------------------
const project = emptyProject('Demo arch');

const arch = (id: string, z: number, height: number) => ({
  id,
  name: id,
  points: [
    { x: -600, y: 0 },
    { x: -550, y: height * 0.7 },
    { x: 0, y: height },
    { x: 550, y: height * 0.7 },
    { x: 600, y: 0 },
  ],
  closed: false,
  position: { x: 0, y: 0, z },
  rotation: { x: 0, y: 0, z: 0 },
  pipeId: 'round25',
});
project.curves.push(arch('front', 150, 900), arch('back', -150, 900));
project.lofts.push({ id: 'garland', name: 'garland', curveIds: ['front', 'back'], material: 'golden-garland' });
project.lights.push({
  id: 'lights',
  name: 'lights',
  points: project.curves[0].points.map((p) => ({ x: p.x, y: p.y + 30, z: 150 })),
  stringId: 'led5m',
  color: LED_COLORS.warmWhite,
});

const curveMap = new Map(project.curves.map((c) => [c.id, c]));
for (const c of project.curves) scene.add(buildPipe(c));
for (const l of project.lofts) {
  const m = buildLoft(l, curveMap);
  if (m) scene.add(m);
}
for (const l of project.lights) {
  const r = buildLightString(l);
  scene.add(r.group);
  console.info(`[${l.name}] path ${r.pathLength.toFixed(0)} mm, ${r.ledsPlaced} LEDs, lit ${r.litLength} mm${r.tooLong ? ' — TOO LONG for string' : ''}`);
}

// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
