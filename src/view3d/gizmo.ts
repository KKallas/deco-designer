/**
 * Transform gizmo (three.js TransformControls) driving a proxy object.
 *   plane  – full 3D gizmo at the plane origin (world space for move, local for rotate/scale)
 *   curves – 2D gizmo aligned to the plane frame: X/Y move + XY square, Z ring, X/Y/XY scale
 * The viewer reads the proxy after every change and applies it through commands.
 */
import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoKind = 'plane' | 'curves' | 'group' | 'array';

export interface GizmoEvents {
  onStart(): void;
  onChange(): void;
  onEnd(): void;
  onDragging(dragging: boolean): void;
}

export class Gizmo {
  readonly proxy = new THREE.Object3D();
  readonly controls: TransformControls;
  kind: GizmoKind | null = null;
  private currentMode: GizmoMode = 'translate';
  private normalMove = false;

  constructor(camera: THREE.Camera, dom: HTMLElement, scene: THREE.Scene, events: GizmoEvents) {
    scene.add(this.proxy);
    this.controls = new TransformControls(camera, dom);
    this.controls.size = 0.85;
    scene.add(this.controls.getHelper());
    this.controls.addEventListener('dragging-changed', (e) => events.onDragging(!!e.value));
    this.controls.addEventListener('mouseDown', () => events.onStart());
    this.controls.addEventListener('objectChange', () => events.onChange());
    this.controls.addEventListener('mouseUp', () => events.onEnd());
    this.detach();
  }

  set camera(cam: THREE.Camera) { this.controls.camera = cam; }
  get mode(): GizmoMode { return this.currentMode; }
  set mode(m: GizmoMode) { this.currentMode = m; this.controls.setMode(m); this.configure(); }
  get dragging(): boolean { return this.controls.dragging; }
  /** Handle under the pointer / being dragged: 'X' | 'Y' | 'Z' | 'XY' | 'YZ' | 'XZ' | 'XYZ' | 'E' | 'XYZE' | null */
  get axis(): string | null { return this.controls.axis; }

  attachPlane(matrix: THREE.Matrix4): void {
    this.kind = 'plane';
    matrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.controls.attach(this.proxy);
    this.configure();
  }

  /** World-aligned gizmo at an object's pivot. */
  attachGroup(pivotWorld: THREE.Vector3): void {
    this.kind = 'group';
    this.proxy.position.copy(pivotWorld);
    this.proxy.quaternion.identity();
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.controls.attach(this.proxy);
    this.configure();
  }

  /**
   * A handle of the plane's array modifier (docs/26-array.md §3): the plane frame's
   * X / Y / Z arrows and the XY square, whatever mode the rail is in — a point only moves.
   */
  attachArray(frameMatrix: THREE.Matrix4, at: THREE.Vector3): void {
    this.kind = 'array';
    this.proxy.quaternion.setFromRotationMatrix(frameMatrix);
    this.proxy.position.copy(at);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.controls.attach(this.proxy);
    this.configure();
  }

  /** In-plane gizmo; `normalMove` adds the Z arrow in Move mode (vertices of a 3D curve, docs/12-3d-curves.md). */
  attachCurves(frameMatrix: THREE.Matrix4, pivotWorld: THREE.Vector3, normalMove = false): void {
    this.kind = 'curves';
    this.normalMove = normalMove;
    this.proxy.quaternion.setFromRotationMatrix(frameMatrix);
    this.proxy.position.copy(pivotWorld);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld();
    this.controls.attach(this.proxy);
    this.configure();
  }

  detach(): void {
    this.kind = null;
    this.controls.detach();
  }

  setSnapping(on: boolean): void {
    this.controls.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.controls.setScaleSnap(on ? 0.1 : null);
  }

  private configure(): void {
    const c = this.controls;
    const m = this.currentMode;
    c.setMode(this.kind === 'array' ? 'translate' : m);
    if (this.kind === 'array') {
      c.setSpace('local');
      c.showX = c.showY = c.showZ = true;
      c.showXY = true;
      c.showYZ = c.showXZ = false;
    } else if (this.kind === 'curves') {
      c.setSpace('local');
      c.showX = m !== 'rotate';
      c.showY = m !== 'rotate';
      c.showZ = m === 'rotate' || (m === 'translate' && this.normalMove);
      c.showXY = true;
      c.showYZ = false;
      c.showXZ = false;
    } else if (this.kind === 'group') {
      c.setSpace('world');
      c.showX = c.showY = c.showZ = true;
      c.showXY = c.showYZ = c.showXZ = true;
    } else {
      c.setSpace(m === 'translate' ? 'world' : 'local');
      c.showX = c.showY = c.showZ = true;
      c.showXY = c.showYZ = c.showXZ = true;
    }
  }
}
