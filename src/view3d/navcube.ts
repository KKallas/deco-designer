/**
 * Navigation cube: a small labelled cube drawn in the corner of the viewport.
 * Its faces, edges and corners are click zones that snap the main camera to
 * that view direction.
 */
import * as THREE from 'three/webgpu';

export interface CubeZone {
  kind: 'face' | 'edge' | 'corner';
  dir: THREE.Vector3;
  up: THREE.Vector3;
  mesh: THREE.Mesh;
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2b2b31';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#4a4a54';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, 125, 125);
  ctx.fillStyle = '#cfcfd6';
  ctx.font = '600 21px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;   // drawn without output conversion (see viewer.frameLoop): the sRGB pixels pass through as they are
  return t;
}

export class NavCube {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  /** Size of the cube viewport in CSS px. */
  readonly size = 110;
  readonly margin = 12;
  /** Top of the cube in the viewport — the status bar became the right rail (docs/23-toolbar-rails.md). */
  readonly top = 12;
  /** How far the right toolbar rail pushes the cube left (docs/23 §4); set by the app. */
  rightInset = 0;
  private zones: CubeZone[] = [];
  private hovered: CubeZone | null = null;
  private raycaster = new THREE.Raycaster();

  constructor() {
    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
    const faces = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'].map((t) => new THREE.MeshBasicMaterial({ map: labelTexture(t) }));
    this.scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), faces));
    const axes = new THREE.AxesHelper(0.9);
    axes.position.set(-0.7, -0.7, -0.7);
    this.scene.add(axes);

    for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
      const nz = Math.abs(sx) + Math.abs(sy) + Math.abs(sz);
      if (nz === 0) continue;
      const size = (s: number) => (s === 0 ? 0.62 : 0.24);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size(sx), size(sy), size(sz)),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHex(0x4f8cff, THREE.LinearSRGBColorSpace), transparent: true, opacity: 0, depthTest: false }),
      );
      mesh.position.set(sx * 0.5, sy * 0.5, sz * 0.5);
      mesh.renderOrder = 1;
      const dir = new THREE.Vector3(sx, sy, sz).normalize();
      const up = sy !== 0 && sx === 0 && sz === 0 ? new THREE.Vector3(0, 0, -sy) : new THREE.Vector3(0, 1, 0);
      this.zones.push({ kind: nz === 1 ? 'face' : nz === 2 ? 'edge' : 'corner', dir, up, mesh });
      this.scene.add(mesh);
    }
  }

  /** Keep the cube's view direction in sync with the main camera. */
  sync(mainCamera: THREE.Camera, target: THREE.Vector3): void {
    const dir = mainCamera.position.clone().sub(target);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
    this.camera.position.copy(dir.normalize().multiplyScalar(3.6));
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);
  }

  /** Top-left corner of the cube rect within the viewport (CSS px). */
  rect(width: number): { x: number; y: number; w: number; h: number } {
    return { x: width - this.size - this.margin - this.rightInset, y: this.top, w: this.size, h: this.size };
  }

  contains(width: number, px: number, py: number): boolean {
    const r = this.rect(width);
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  /** Zone under the pointer; px/py are viewport CSS px. */
  hitTest(width: number, px: number, py: number): CubeZone | null {
    const r = this.rect(width);
    const ndc = new THREE.Vector2(((px - r.x) / r.w) * 2 - 1, -((py - r.y) / r.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.zones.map((z) => z.mesh), false);
    if (!hits.length) return null;
    return this.zones.find((z) => z.mesh === hits[0].object) ?? null;
  }

  setHover(zone: CubeZone | null): void {
    if (this.hovered === zone) return;
    if (this.hovered) (this.hovered.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
    this.hovered = zone;
    if (zone) (zone.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55;
  }
}
