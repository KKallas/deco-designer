/**
 * A world (docs/16-world.md) applied to a three.js scene: background colour
 * or HDR, environment (none / colour / studio room / HDR) through PMREM,
 * the one sun, and the AgX view transform with the world's exposure.
 * Shared by the viewport and the page previews. `apply` is idempotent —
 * it rebuilds only what the world (or a used HDR's data) changed.
 */
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Id, Texture, World } from '../model/types';
import { defaultWorld, sunDirection, worldTextures } from '../model/world';
import { decodeHdrTexture, hdrDataTexture } from '../materials/hdr';

/** Edit mode draws on a plane: a fixed neutral look, whatever the project's world (no HDR horizon under a drawing). */
export const EDIT_WORLD: World = { ...defaultWorld(), sun: { ...defaultWorld().sun, shadows: false } };

const SUN_DISTANCE = 20_000;

export class WorldRig {
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private room: THREE.Texture | null = null;
  private colorEnvs = new Map<string, THREE.Texture>();
  private hdrs = new Map<Id, { data: string; equirect: THREE.DataTexture | null; pmrem: THREE.Texture | null }>();
  private key = '';
  private color = new THREE.Color();

  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene) {
    this.sun.target.position.set(0, 0, 0);
    const s = this.sun.shadow;
    s.mapSize.set(2048, 2048);
    s.camera.left = s.camera.bottom = -6000; s.camera.right = s.camera.top = 6000;
    s.camera.near = 1000; s.camera.far = SUN_DISTANCE * 2;
    s.bias = -0.0005; s.normalBias = 4;
    scene.add(this.sun, this.sun.target);
    renderer.toneMapping = THREE.AgXToneMapping;
  }

  /** Make the scene show `world`; `textures` are the project's (for HDR ids). */
  apply(world: World, textures: Texture[]): void {
    const used = worldTextures(world).map((id) => textures.find((t) => t.id === id) ?? null);
    const key = JSON.stringify([world, used.map((t) => (t ? [t.id, t.mime, t.data.length, t.data.slice(-48)] : null))]);
    if (key === this.key) return;
    this.key = key;
    for (const [id, e] of this.hdrs) {   // drop what is no longer used or has new data
      const t = used.find((x) => x?.id === id);
      if (t && t.data === e.data) continue;
      e.equirect?.dispose(); e.pmrem?.dispose(); this.hdrs.delete(id);
    }
    const rad = (world.rotation * Math.PI) / 180;

    // background
    const bg = world.background;
    const bgTex = bg.kind === 'hdr' ? this.equirect(bg.texture, used) : null;
    if (bgTex && bg.kind === 'hdr') {
      this.scene.background = bgTex;
      this.scene.backgroundBlurriness = bg.blur;
      this.scene.backgroundRotation.set(0, rad, 0);
    } else {
      this.scene.background = this.color.set(bg.kind === 'color' ? bg.color : '#141416').clone();
      this.scene.backgroundBlurriness = 0;
    }

    // environment
    const env = world.environment;
    let envTex: THREE.Texture | null = null;
    if (env.kind === 'room') envTex = this.roomEnv();
    else if (env.kind === 'color') envTex = this.colorEnv(env.color);
    else if (env.kind === 'hdr') envTex = this.pmrem(env.texture, used);
    this.scene.environment = envTex;
    this.scene.environmentIntensity = world.strength;
    this.scene.environmentRotation.set(0, rad, 0);

    // sun
    const sun = world.sun, d = sunDirection(sun);
    this.sun.position.set(d.x * SUN_DISTANCE, d.y * SUN_DISTANCE, d.z * SUN_DISTANCE);
    this.sun.color.set(sun.color);
    // the light stays in the scene at intensity 0 when it is off: a scene with no light at all takes an
    // unlit path, and then the LEDs (docs/17-emitters.md) would have nothing to add their irradiance to
    this.sun.intensity = sun.enabled ? sun.strength : 0;
    this.sun.castShadow = sun.enabled && sun.shadows;

    // view transform
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = world.exposure;
  }

  private entry(id: Id, used: (Texture | null)[]): { data: string; equirect: THREE.DataTexture | null; pmrem: THREE.Texture | null } | null {
    const t = used.find((x) => x?.id === id);
    if (!t) return null;
    let e = this.hdrs.get(id);
    if (!e) {
      e = { data: t.data, equirect: null, pmrem: null };
      try { e.equirect = hdrDataTexture(decodeHdrTexture(t)); }
      catch (err) { console.warn(`HDR "${t.name}" (${t.id}) could not be decoded — the world falls back to a colour:`, err); }
      this.hdrs.set(id, e);
    }
    return e;
  }

  private equirect(id: Id, used: (Texture | null)[]): THREE.DataTexture | null {
    return this.entry(id, used)?.equirect ?? null;
  }

  private pmrem(id: Id, used: (Texture | null)[]): THREE.Texture | null {
    const e = this.entry(id, used);
    if (!e?.equirect) return null;
    if (!e.pmrem) {
      const gen = new THREE.PMREMGenerator(this.renderer);
      e.pmrem = gen.fromEquirectangular(e.equirect).texture;
      gen.dispose();
    }
    return e.pmrem;
  }

  private roomEnv(): THREE.Texture {
    if (!this.room) {
      const gen = new THREE.PMREMGenerator(this.renderer);
      this.room = gen.fromScene(new RoomEnvironment(), 0.04).texture;
      gen.dispose();
    }
    return this.room;
  }

  /** A uniform environment: a tiny equirect of the colour through PMREM (linear light, so it lights the way the colour reads). */
  private colorEnv(hexColor: string): THREE.Texture {
    let t = this.colorEnvs.get(hexColor);
    if (!t) {
      const c = new THREE.Color(hexColor);
      const data = new Float32Array(4 * 2 * 4);
      for (let i = 0; i < 8; i++) { data[i * 4] = c.r; data[i * 4 + 1] = c.g; data[i * 4 + 2] = c.b; data[i * 4 + 3] = 1; }
      const eq = hdrDataTexture({ width: 4, height: 2, data });
      const gen = new THREE.PMREMGenerator(this.renderer);
      t = gen.fromEquirectangular(eq).texture;
      gen.dispose(); eq.dispose();
      this.colorEnvs.set(hexColor, t);
    }
    return t;
  }

  dispose(): void {
    this.room?.dispose();
    for (const t of this.colorEnvs.values()) t.dispose();
    for (const e of this.hdrs.values()) { e.equirect?.dispose(); e.pmrem?.dispose(); }
    this.hdrs.clear(); this.colorEnvs.clear(); this.room = null; this.key = '';
  }
}
