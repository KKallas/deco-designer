/**
 * The 3D preview of the shapes page: a WebGPU renderer with the project's
 * world (src/view3d/world.ts — background, environment, sun), bloom / lens
 * flare (src/view3d/effects.ts), a grid and orbit controls in a container.
 * `subject` holds what is previewed; `frame()` moves the grid under it.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { el } from './dom';
import { createEffects, fallbackEffects } from '../view3d/effects';
import { WorldRig } from '../view3d/world';
import { defaultCamera } from '../model/camera';
import { defaultPost } from '../model/post-presets';
import { defaultWorld } from '../model/world';
import type { Texture, World } from '../model/types';

export interface Preview {
  scene: THREE.Scene;
  subject: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** resolves false if WebGPU / WebGL2 is unavailable (a note is shown in the container) */
  ready: Promise<boolean>;
  /** bounds of the subject; the grid sits just below it */
  frame(): THREE.Box3;
  /** show the project's world (docs/16-world.md); the default until called */
  setWorld(world: World, textures: Texture[]): void;
}

export function createPreview(container: HTMLElement): Preview {
  const scene = new THREE.Scene();
  let rig: WorldRig | null = null;
  let wanted: { world: World; textures: Texture[] } = { world: defaultWorld(), textures: [] };
  const grid = new THREE.GridHelper(4000, 40, 0x2c2c31, 0x1f1f23);
  grid.position.y = -600;
  scene.add(grid);
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 100000);
  camera.position.set(1300, 900, 1700);
  const subject = new THREE.Group();
  scene.add(subject);

  const ready = (async () => {
    let renderer: THREE.WebGPURenderer;
    try {
      renderer = new THREE.WebGPURenderer({ antialias: true });
      await renderer.init();
    } catch (e) {
      container.append(el('div', { class: 'hint', style: 'padding:12px' }, `3D preview unavailable: ${e instanceof Error ? e.message : String(e)}`));
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(renderer.domElement);
    rig = new WorldRig(renderer, scene);
    rig.apply(wanted.world, wanted.textures);
    let fx;   // the default post preset, so an LED string previews as it renders in the designer
    try { fx = createEffects(renderer, scene, camera, defaultPost(), defaultCamera()); } catch (e) { console.warn(e); fx = fallbackEffects(renderer, scene, camera); }
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.zoomToCursor = true;
    const resize = () => { const w = container.clientWidth, h = container.clientHeight; if (w && h) { renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); } };
    new ResizeObserver(resize).observe(container);
    resize();
    renderer.setAnimationLoop(() => { controls.update(); fx.render(); });
    return true;
  })();

  return {
    scene, subject, camera, ready,
    setWorld(world, textures) { wanted = { world, textures }; rig?.apply(world, textures); },
    frame() {
      const bounds = new THREE.Box3().setFromObject(subject);
      if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-500, -500, -500), new THREE.Vector3(500, 500, 500));
      grid.position.y = bounds.min.y - 60;
      return bounds;
    },
  };
}
