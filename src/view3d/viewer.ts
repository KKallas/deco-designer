/**
 * The single viewport: renders every plane's curves (with the plane's array
 * instances), the active plane, and – for the edited curve – vertices,
 * handles, constraints, guides and violations. Object mode: pick / multi-
 * select / drag curves or a whole plane. Edit mode: in-plane curve editing
 * with box select, multi-vertex drag, alignment snapping and a context menu.
 * All state changes go through src/app/commands.ts.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ArrayHandle, Store } from '../app/store';
import * as cmd from '../app/commands';
import { findGroup, groupChain, groupOfPlane, planeVisible, playbackRange, subtreePlanes, type ArrayModifier, type CurveObject, type Id, type Plane, type Vec2, type Vec3, type VertexType, type World } from '../model/types';
import { fromPlane, groupMatrix, localDelta, localPlacement, offsetPlane, planeWorld, toPlane, type PlaneFrame } from '../geometry/placement';
import { arrayAxis, instanceMatrices } from '../geometry/array';
import { buildMaterial, hostForObjects, type MaterialHost } from '../materials/runtime';
import { TextureCache } from '../materials/textures';
import { color as tslColor } from 'three/tsl';
import { fillOf, findMaterial, paramsOf, type Material, type Shape } from '../model/types';
import { attributeMaterial, buildShapeGeometry, fallbackGeometry, shapeInput } from '../geometry/shape';
import type { LayerEval } from '../app/store';
import { buildLoft, checkerMaterial } from '../geometry/loft';
import { buildFillGeometry, shapeCurves, surfaceInput, type SurfaceInput } from '../geometry/surface';
import { CHECKER_COLOR } from '../model/fills';
import { curveBounds, sampleCurve, samplesBetween } from '../geometry/curve';
import { offsetCurve as offsetGeo, signedDistance, trimSpan, turnAt, windingOf } from '../geometry/modify';
import { absoluteHandles } from '../model/handles';
import { alignSnap, type Guide } from '../model/snap';
import { CHECKS } from '../checks';
import { NavCube } from './navcube';
import { createEffects, fallbackEffects, type Effects } from './effects';
import { EDIT_WORLD, WorldRig } from './world';
import { PixelBuffer, PixelMaps, lampsOf, type Lamps } from './pixels';
import { EmitterRig, type LampPlacement } from './emitters';
import { activeCameraOf, cameraFov, frameRect, stillSize, verticalFov } from '../model/camera';
import type { CameraSettings, PostProgram } from '../model/types';
import { showContextMenu, type MenuItem } from '../ui/contextmenu';
import { deleteSelectionAsked, projectSelectionAsked } from '../ui/confirm';
import { Gizmo, type GizmoMode } from './gizmo';
import { ALL_LEVELS, resolvePick, type PickFilter, type PickHit, type PickLevel, type PickTarget } from '../model/pick';
import { snapshotCurve, translation, type Affine2, type CurveSnapshot } from '../model/transform';

const ACCENT = 0x4f8cff;
const PINK = 0xff4fd8;
const TEAL = 0x4fd1c5;
const RED = 0xff5c5c;
const GRID = 10;
const POINT_PX = 9;
const HANDLE_PX = 8;
/** the reference image lies this far behind the plane, so the bars drawn on it stay in front */
const IMAGE_Z = -8;
const IMAGE_CORNER_PX = 10;
const ARRAY_HANDLE_PX = 11;
/** the array modifier's handles (docs/26-array.md §3) */
const AMBER = 0xffb14f;

type Drag =
  | { kind: 'vertices'; id: Id; vid: Id; originals: Map<Id, Vec2>; moved: boolean }
  /** Alt-drag on a vertex of a 3D curve: move the selection along the plane normal (docs/12-3d-curves.md §4). `dir` = screen px per mm of normal, null when the normal points at the camera. */
  | { kind: 'vertexZ'; id: Id; originals: Map<Id, number>; origin: THREE.Vector3; dir: Vec2 | null; moved: boolean }
  | { kind: 'handle'; id: Id; vid: Id; which: 'in' | 'out'; moved: boolean }
  | { kind: 'box'; additive: boolean; addAt: (Vec2 & { z: number }) | null; moved: boolean }
  | { kind: 'curves'; ids: Id[]; frame: PlaneFrame; start: Vec2; originals: Map<Id, CurveSnapshot>; anchor0: Vec2 | null; candidates: Vec2[]; moved: boolean }
  | { kind: 'plane'; planeId: Id; frame: PlaneFrame; start: THREE.Vector3; origin: Vec3; anchor0: THREE.Vector3 | null; candidates: THREE.Vector3[]; moved: boolean }
  | { kind: 'group'; groupIds: Id[]; frame: PlaneFrame; start: THREE.Vector3; snap: cmd.GroupSnapshot; pivot: THREE.Vector3; anchor0: THREE.Vector3 | null; candidates: THREE.Vector3[]; moved: boolean }
  /** the plane's reference image (docs/19-reference-image.md), only while it is unlocked */
  | { kind: 'image'; planeId: Id; frame: PlaneFrame; start: Vec2; center0: Vec2; moved: boolean }
  | { kind: 'imageScale'; planeId: Id; frame: PlaneFrame; anchor: Vec2; center0: Vec2; width0: number; d0: number; moved: boolean }
  /** the offset tool (docs/29-offset-trim-fillet.md): dragging from a curve sets the side and the distance */
  | { kind: 'offset'; id: Id; frame: PlaneFrame; d: number; moved: boolean }
  | { kind: 'none'; moved: boolean };

type GizmoDrag =
  /** a handle of the plane's array modifier (docs/26-array.md §3) */
  | { kind: 'array'; planeId: Id; handle: ArrayHandle; frame: PlaneFrame }
  | { kind: 'group'; groupIds: Id[]; snap: cmd.GroupSnapshot; pivot: THREE.Vector3; anchor0: THREE.Vector3 | null; candidates: THREE.Vector3[] }
  | { kind: 'plane'; planeId: Id; /** world origin at drag start */ origin: Vec3; originals: Map<Id, CurveSnapshot>; anchor0: THREE.Vector3 | null; candidates: THREE.Vector3[] }
  | { kind: 'curves'; frame: PlaneFrame; pivot: Vec2; originals: Map<Id, CurveSnapshot>; anchor0: Vec2 | null; candidates: Vec2[] }
  | { kind: 'vertices'; id: Id; frame: PlaneFrame; pivot: Vec2; pivotZ: number; original: CurveSnapshot; vids: Id[]; anchor0: Vec2 | null; candidates: Vec2[] };

/** Edit-mode tool on the rail: the transform gizmo (select / move vertices) or the add-points tool (A). */
export type EditTool = 'select' | 'add';
/** Object-mode tools between curves on one plane (docs/29-offset-trim-fillet.md). */
export type PlaneTool = 'offset' | 'trim' | 'fillet';

const axisMask = (axis: string | null) => ({ x: !axis || axis.includes('X'), y: !axis || axis.includes('Y'), z: !axis || axis.includes('Z') });

type Visual = 'normal' | 'selected' | 'editing';
interface Billboard { mesh: THREE.Mesh; px: number; aspect: number; diamond?: boolean }

const labelCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${color}|${text}`;
  let t = labelCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 160; c.height = 48;
  const ctx = c.getContext('2d')!;
  ctx.font = '600 24px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = Math.min(150, ctx.measureText(text).width + 16);
  ctx.fillStyle = 'rgba(20,20,22,0.85)';
  ctx.beginPath(); ctx.roundRect(80 - w / 2, 6, w, 36, 8); ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 80, 25);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  labelCache.set(key, t);
  return t;
}

/** The cache / pixel-block key of one layer of a curve or a shape. */
const layerKey = (owner: Id, layer: Id): string => `${owner}/${layer}`;

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly persp = new THREE.PerspectiveCamera(45, 1, 1, 200_000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -200_000, 200_000);
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  readonly controls: OrbitControls;
  readonly navcube = new NavCube();

  private content = new THREE.Group();
  private helpers = new THREE.Group();
  private width = 1;
  private height = 1;
  private frame: PlaneFrame | null = null;
  private pointsWorld: THREE.Vector3[] = [];
  private pointIds: Id[] = [];
  private handlesWorld: { in: THREE.Vector3; out: THREE.Vector3 } | null = null;
  private samplesWorld: THREE.Vector3[] = [];
  private billboards: Billboard[] = [];
  private geomCache = new Map<Id, { key: string; geo: THREE.BufferGeometry }>();
  private matCache = new Map<string, THREE.Material>();
  /** compiled project materials: `${id}|${visual}` → material (invalidated when the code changes) */
  private nodeMatCache = new Map<string, { code: string; material: THREE.Material }>();
  private host: MaterialHost | null = null;
  /** project textures as three.js textures, images swapped in place (docs/13-material-editor.md) */
  private textures = new TextureCache();
  private badMaterials = new Set<string>();
  /** profile builds that threw (curve/layer | key) — warned once, drawn as a thin tube — and fill builds that threw (drawn as nothing) */
  private badShapes = new Set<string>();
  /** a shape's surface and its layers' fills, keyed by shape id (docs/30 §4) */
  private surfaceCache = new Map<Id, { key: string; input: SurfaceInput | null }>();
  private fillCache = new Map<string, { key: string; geo: THREE.BufferGeometry }>();
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private down: Vec2 | null = null;
  /** A press on the navigation cube: dragging it spins the view like a ball, a click without movement snaps (docs/21-navcube-drag.md). */
  private cubeDrag: { last: Vec2; moved: boolean } | null = null;
  private hoverPoint: number | null = null;
  /** world-space corners of the active plane's reference image while it is unlocked (drag to scale) */
  private imageCorners: THREE.Vector3[] = [];
  /** world points of the selected plane's array handles, in `arrayHandleKinds` order (docs/26-array.md §3) */
  private arrayHandles: THREE.Vector3[] = [];
  private arrayHandleKinds: ArrayHandle[] = [];
  /** "Set scale…" (docs/19-reference-image.md): click two points on the image, then type the distance */
  imageCalibrate: { planeId: Id; first: Vec2 | null } | null = null;
  private snapCandidates: Vec2[] = [];
  private guides: Guide[] = [];
  private anim: { pos0: THREE.Vector3; pos1: THREE.Vector3; up0: THREE.Vector3; up1: THREE.Vector3; t0: number } | null = null;
  private lastMode: 'object' | 'edit' | 'post' = 'object';
  private squareGeo = new THREE.PlaneGeometry(1, 1);
  private circleGeo = new THREE.CircleGeometry(0.5, 16);
  private boxEl: HTMLDivElement;
  /** the camera frame (docs/15-camera.md): outline + darkened passepartout, a DOM overlay */
  private frameEl: HTMLDivElement;
  readonly gizmo: Gizmo;
  private gizmoDrag: GizmoDrag | null = null;
  private snapTarget: THREE.Vector3 | null = null;
  private guideAnchor: Vec2 | null = null;
  private shiftHeld = false;
  /** A modifier-click (Shift / ⌘) that OrbitControls is handling; resolved as a click on pointerup if the pointer did not move. */
  private navClick: { shift: boolean } | null = null;
  /** Edit mode tool (docs/11-navigation-edit-gizmo.md). */
  editTool: EditTool = 'select';
  /** Focus tool (docs/15-camera.md): a click on geometry sets the depth-of-field focus there. */
  focusTool = false;
  private focusMarker: THREE.Mesh | null = null;
  /** Plane tools (docs/29-offset-trim-fillet.md): offset / trim / fillet between curves on one plane, Object mode only. */
  planeTool: PlaneTool | null = null;
  /** the tools' numbers in mm: the offset distance (signed: + outwards / left) and the fillet radius (0 = not chosen yet) */
  toolValues = { offset: 20, fillet: 0 };
  /** what the tool bar reports under its hint: the last result, or why a click did nothing */
  toolMessage = '';
  /** the first of the two open curves the fillet tool joins */
  filletFirst: Id | null = null;
  /** the tools' hover previews: the offset copy, the piece a trim removes, the corner a fillet rounds */
  private toolGroup = new THREE.Group();
  /** every visible planar curve's sampled points in world mm — the tools pick on these, not through the filter */
  private curveSamples: { id: Id; world: THREE.Vector3[]; s: number[] }[] = [];
  /** every corner a fillet could round, in world mm */
  private corners: { id: Id; vid: Id; world: THREE.Vector3 }[] = [];
  /** where the other curves on the plane cross a curve, per curve, until the next sync */
  private cutsCache = new Map<Id, number[]>();
  /** Called when a plane tool, its number or its message changes (the tool bar under the label). */
  onToolChange: () => void = () => undefined;
  /** the projection of the view (the cube's dropdown, docs/36 §1): orthographic is a detour that leaves the camera's pose alone */
  projection: 'perspective' | 'orthographic' = 'perspective';
  /** which camera object the view was last moved to */
  private appliedCameraId: Id | null | undefined = undefined;
  private lastPose: { position: Vec3; target: Vec3 } = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } };
  private stillSince = 0;
  /** background, environment lighting, sun and exposure (src/view3d/world.ts, docs/16-world.md) */
  private world: WorldRig;
  /** the live colour of every LED (src/view3d/pixels.ts, docs/17-emitters.md) */
  readonly pixels = new PixelBuffer();
  private maps = new PixelMaps();
  /** lamps per curve/layer, alongside the geometry cache */
  private lampCache = new Map<string, { key: string; lamps: Lamps }>();
  /** light from the LEDs (src/view3d/emitters.ts, docs/17-emitters.md) */
  readonly emitters = new EmitterRig();
  /** the playback clock (docs/17-emitters.md): seconds since the animation started, viewer state */
  private clockSeconds = 0;
  /** how fast the viewport is actually drawing (docs/22-transport-in-out.md §2), sampled twice a second */
  private fps = 0;
  // -- frames on demand (docs/32-render-on-demand.md) --
  /** something asked for a frame: a store change, the camera, an input event, the clock, the bake */
  private needsFrame = true;
  /** until when the viewport counts as being interacted with (the camera moving, a button held) — half the pixels */
  private interactUntil = 0;
  private readonly ratioFull = Math.min(window.devicePixelRatio || 1, 2);
  private ratioNow = this.ratioFull;
  /** frames actually drawn — the bridge reads it to prove the viewport idles */
  renderCount = 0;
  /** the camera as last drawn / as of the last tick: motion is judged on screen, in pixels (§2 of docs/32) */
  private drawnPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private tickPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  /** the floor grid, hidden in a still */
  private floor = new THREE.GridHelper(6000, 60, 0x2c2c31, 0x1f1f23);
  private fpsFrames = 0;
  private fpsSince = 0;
  private clockLast = 0;
  /** the lamps need their colours written again (a map arrived, the content changed, the clock moved) */
  private pixelsDirty = true;
  /** set when the pixel / emitter work threw: it is not tried again until the page is reloaded */
  private pixelsBroken = false;
  /** the irradiance the probes give, as one lighting node shared by every lit material */
  private irradiance: THREE.IrradianceNode | null = null;
  /** the project's post-processing script as a pipeline (src/view3d/effects.ts, docs/15-camera.md) */
  private fx: Effects | null = null;
  /** what the pipeline was built for: JSON of post + camera + which camera */
  private fxKey = '';
  /** the last script error (null = the script built fine) — the post editor shows it */
  postError: string | null = null;
  /** a draft post script previewed instead of the project's (the panel's post editor, docs/15-camera.md) */
  private postPreview: PostProgram | null = null;
  private ringGeo = new THREE.RingGeometry(0.3, 0.5, 24);
  /** Called when the gizmo mode or the selection filter changes (UI rail / filter bar). */
  onUiChange: () => void = () => undefined;
  /** Selection filter (docs/08-selection-filter.md): which levels a click may select. */
  pickFilter: PickFilter = { ...ALL_LEVELS };

  static async create(container: HTMLElement, store: Store): Promise<Viewer> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
    return new Viewer(container, renderer, store);
  }

  private constructor(private container: HTMLElement, private renderer: THREE.WebGPURenderer, private store: Store) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'box-select';
    this.boxEl.style.display = 'none';
    container.appendChild(this.boxEl);
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'camera-frame';
    container.appendChild(this.frameEl);

    // the world (docs/16-world.md) is the only light: background, environment, sun, exposure — applied in applyLook
    this.world = new WorldRig(renderer, this.scene);
    this.scene.add(this.floor);
    this.scene.add(this.content, this.helpers, this.toolGroup);

    this.persp.position.set(2200, 1600, 3000);
    this.controls = new OrbitControls(this.persp, renderer.domElement);
    this.controls.target.set(0, 400, 0);
    this.controls.enableDamping = true;
    this.controls.zoomToCursor = true;
    // left button: box select; Shift+left orbits, ⌘+left pans (set per press in onPointerDown), middle orbits, right pans, wheel / pinch zooms
    this.controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };

    const el = renderer.domElement;
    el.tabIndex = 0;
    this.gizmo = new Gizmo(this.persp, el, this.scene, {
      onDragging: (d) => { this.controls.enabled = !d; },
      onStart: () => this.gizmoStart(),
      onChange: () => this.gizmoChange(),
      onEnd: () => this.gizmoEnd(),
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Shift') this.shiftHeld = true; });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.shiftHeld = false; });
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // frames on demand (docs/32): every input over the viewport is worth a frame; a held button or a wheel is a gesture
    el.addEventListener('pointerdown', () => this.touch(true));
    el.addEventListener('pointermove', (e) => this.touch(e.buttons !== 0));
    el.addEventListener('pointerup', () => this.touch(true));
    el.addEventListener('dblclick', () => this.touch());
    el.addEventListener('wheel', () => this.touch(true), { passive: true });
    window.addEventListener('keydown', () => this.touch());
    window.addEventListener('keyup', () => this.touch());
    window.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.applyLook();
    renderer.setAnimationLoop(() => this.frameLoop());
    this.sync();
  }

  get isWebGPU(): boolean {
    return !!(this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  }

  get backendName(): string {
    return this.isWebGPU ? 'WebGPU' : 'WebGL2';
  }

  // -- scene sync --------------------------------------------------------------

  /** Rebuild the scene from the store. */
  sync(): void {
    const { project, mode, selection } = this.store.state;
    this.needsFrame = true;
    if (mode.kind !== this.lastMode) { this.lastMode = mode.kind; this.onModeChange(mode.kind); }
    const editingId = mode.kind === 'edit' ? mode.curveId : null;
    this.textures.sync(project.textures);
    this.maps.sync(project, () => { this.pixelsDirty = true; });
    this.applyLook();
    this.layoutPixels();

    const placements: LampPlacement[] = [];
    const occluders: THREE.Mesh[] = [];
    const emitterKey: string[] = [];

    this.disposeGroup(this.content);
    this.disposeGroup(this.helpers);
    this.billboards = [];
    this.arrayHandles = [];
    this.arrayHandleKinds = [];
    this.pointsWorld = [];
    this.pointIds = [];
    this.handlesWorld = null;
    this.samplesWorld = [];
    this.frame = null;
    this.curveSamples = [];
    this.corners = [];
    this.cutsCache.clear();
    this.clearToolPreview();

    const selectedPlanes = this.planesOfGroups(selection.groups);
    for (const plane of project.planes) {
      if (!planeVisible(project, plane.id)) continue;
      const frame = this.frameOf(plane);
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(frame.matrix);
      const refImage = this.imageMesh(plane);
      if (refImage) group.add(refImage);
      const planeSel = selection.planes.includes(plane.id) || selectedPlanes.has(plane.id);
      const instances = instanceMatrices(plane.array);
      // the key must follow the *world* matrix: moving an object the plane sits in changes nothing local (docs/18-nested-objects.md §2)
      emitterKey.push(plane.id, frame.matrix.toArray().map((n) => Math.round(n * 1e4) / 1e4).join(','), JSON.stringify(plane.array));
      for (const c of project.curves) {
        if (c.planeId !== plane.id) continue;
        const ev = this.store.evals.get(c.id)!;
        const visual: Visual = c.id === editingId ? 'editing' : planeSel || selection.curves.includes(c.id) ? 'selected' : 'normal';
        // the outline (docs/30 §3): one mesh per visible layer, each on its own offset curve
        for (const le of ev.layers) {
          if (!le.layer.visible) continue;
          const key = layerKey(c.id, le.layer.id);
          const geo = this.layerGeo(c, le);
          if (!geo) continue;
          const lamps = this.layerLamps(key, geo);
          if (lamps) emitterKey.push(key, String(this.geomCache.get(key)?.key.length ?? 0), String(lamps.count));
          for (const m of instances) {
            const mesh = new THREE.Mesh(geo, this.projectMaterial(findMaterial(project, le.layer.materialId), visual) ?? this.material(le.layer.color ?? le.profile.color, visual, geo, key));
            mesh.applyMatrix4(m);
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.userData = { curveId: c.id, layerId: le.layer.id, cached: true, cachedMaterial: true };
            group.add(mesh);
            if (lamps?.count) placements.push({ lamps, base: this.pixels.baseOf(key), matrix: frame.matrix.clone().multiply(m) });
            else occluders.push(mesh);
          }
        }
        if (this.planeTool && c.type !== 'spatial' && ev.sampling.samples.length >= 2) {
          this.curveSamples.push({ id: c.id, world: ev.sampling.samples.map((s) => fromPlane(frame, s)), s: ev.sampling.samples.map((s) => s.s) });
          c.curve.points.forEach((v, i) => { const turn = turnAt(c.curve.points, c.curve.closed, i); if (turn !== null && turn > 0.5 * Math.PI / 180) this.corners.push({ id: c.id, vid: v.id, world: fromPlane(frame, v) }); });
        }
        if (ev.sampling.samples.length >= 2) {
          // the line itself — all a construction line (no visible layer) shows, so it is drawn a little stronger then
          const bare = !ev.layers.some((le) => le.layer.visible);
          const pts = ev.sampling.samples.map((s) => new THREE.Vector3(s.x, s.y, s.z));
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: visual === 'normal' ? (bare ? 0xb0b0b8 : 0x8a8a92) : ACCENT, depthTest: visual === 'normal', transparent: true, opacity: visual === 'normal' ? (bare ? 0.9 : 0.5) : 1 }));
          line.userData = { curveId: c.id };
          line.renderOrder = 2;
          group.add(line);
        }
      }
      this.content.add(group);
    }

    for (const loft of project.lofts) {
      const a = project.curves.find((c) => c.id === loft.a), b = project.curves.find((c) => c.id === loft.b);
      if (!a || !b) continue;
      if (!planeVisible(project, a.planeId) || !planeVisible(project, b.planeId)) continue;
      const inGroup = selectedPlanes.has(a.planeId) && selectedPlanes.has(b.planeId);
      const sel = selection.lofts.includes(loft.id) || inGroup;
      const built = buildLoft(loft, a, b, this.frameOfCurve(a).matrix, this.frameOfCurve(b).matrix, sel, this.projectMaterial(findMaterial(project, loft.materialId), sel ? 'selected' : 'normal') ?? this.lit(checkerMaterial(sel)));
      if (built) { this.content.add(built.mesh); occluders.push(built.mesh); emitterKey.push(loft.id, String(loft.resolution), String(loft.strips), JSON.stringify([loft.edgeA, loft.edgeB])); }
    }

    // shapes (docs/30 §4): the surface over their curves, one mesh per visible fill layer, on the curves' plane
    for (const shape of project.shapes) {
      const curves = shapeCurves(shape, project.curves);
      const c = curves[0];
      if (!c || !planeVisible(project, c.planeId)) continue;
      const sel = selection.shapes.includes(shape.id) || selectedPlanes.has(c.planeId);
      const visual: Visual = sel ? 'selected' : 'normal';
      const surface = this.surfaceOf(shape, curves);
      if (!surface) continue;
      const frame = this.frameOfCurve(c);
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(frame.matrix);
      for (const layer of shape.layers) {
        if (!layer.visible) continue;
        const fill = fillOf(project, layer);
        if (!fill) continue;
        const geo = this.fillGeo(shape, layer.id, surface.key, surface.input, fill.code, paramsOf(fill, layer));
        if (!geo) continue;
        const color = layer.color ?? fill.color;
        const mat = this.projectMaterial(findMaterial(project, layer.materialId), visual) ?? (color === CHECKER_COLOR ? this.lit(checkerMaterial(sel)) : this.fillMaterial({ color, metalness: fill.metalness, roughness: fill.roughness }, visual));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = layer.offset;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData = { shapeId: shape.id, layerId: layer.id, cached: true, cachedMaterial: true };
        group.add(mesh);
        occluders.push(mesh);
        emitterKey.push(shape.id, layer.id, String(this.fillCache.get(layerKey(shape.id, layer.id))?.key.length ?? 0), String(layer.offset));
      }
      this.content.add(group);
    }

    this.emitters.setContent(emitterKey.join('|'), placements, occluders, this.activeWorld().emitters);
    this.pixelsDirty = true;

    const plane = this.store.activePlane();
    if (plane) this.buildActiveHelpers(plane, this.store.activeCurve(), editingId !== null);
    if (this.snapTarget) this.billboard(this.ringGeo, PINK, 22, this.snapTarget);
    if (this.filletFirst) { const first = this.curveSamples.find((x) => x.id === this.filletFirst); if (first) this.toolGroup.add(this.line(first.world, ACCENT)); else this.filletFirst = null; }
    this.syncGizmo();
  }

  /** The world in force: the camera looked through carries it (docs/16-world.md, docs/36); edit mode keeps a neutral fixed look. */
  private activeWorld(): World {
    const { project, mode } = this.store.state;
    if (mode.kind === 'edit') return EDIT_WORLD;
    return activeCameraOf(project).world;
  }

  /** Give every curve's lamps their slots in the pixel buffer (docs/17-emitters.md) — before any material reads a base. */
  private layoutPixels(): void {
    const { project } = this.store.state;
    this.pixels.beginLayout();
    for (const c of project.curves) {
      const ev = this.store.evals.get(c.id);
      if (!ev) continue;
      for (const le of ev.layers) {
        if (!le.layer.visible) continue;
        const key = layerKey(c.id, le.layer.id);
        const lamps = this.layerLamps(key, this.layerGeo(c, le));
        if (lamps?.count) this.pixels.addFixture(key, lamps);
      }
    }
    this.pixels.endLayout();
    for (const key of this.lampCache.keys()) this.pixels.baseUniform(key);
  }

  /**
   * The playback clock and the lamps' colours; the probes follow when anything changed (docs/17-emitters.md).
   * A throw here would repeat every frame, so it switches the pixels off instead and says so once.
   */
  private tickPixels(now: number): void {
    if (this.pixelsBroken) return;
    try { this.tickPixelsUnsafe(now); }
    catch (e) { this.pixelsBroken = true; console.error('pixel animations / emitters switched off after an error:', e); }
  }

  private tickPixelsUnsafe(now: number): void {
    const { project } = this.store.state;
    const dt = this.clockLast ? Math.min(0.25, (now - this.clockLast) / 1000) : 0;
    this.clockLast = now;
    if (project.playback.playing) { this.clockSeconds = this.advanceClock(this.clockSeconds + dt); this.pixelsDirty = true; }
    if (!this.pixelsDirty && !this.emitters.baking) return;
    const changed = this.pixels.fill(project, this.maps, this.clockSeconds);
    this.pixelsDirty = false;
    if (this.emitters.baking) this.emitters.bakeSlice();
    if (changed || this.emitters.baking) { this.emitters.update(this.pixels.colours); this.needsFrame = true; }
  }

  /**
   * Keep the clock inside the transport's range (docs/22-transport-in-out.md): looping
   * it wraps back to *in*, held it stops at *out*.
   */
  private advanceClock(t: number): number {
    const { start, end } = playbackRange(this.store.state.project);
    const span = Math.max(0.01, end - start);
    if (t < start) return start;
    if (t <= end) return t;
    return this.store.state.project.playback.loop ? start + ((t - start) % span) : end;
  }

  /** Frames the viewport drew per second, over the last half second (0 until the first sample). */
  get renderFps(): number { return this.fps; }

  private sampleFps(now: number): void {
    this.fpsFrames++;
    if (!this.fpsSince) { this.fpsSince = now; return; }
    const dt = now - this.fpsSince;
    if (dt < 500) return;
    this.fps = (this.fpsFrames * 1000) / dt;
    this.fpsFrames = 0;
    this.fpsSince = now;
  }

  /** Where the playback clock stands, in seconds. */
  get playbackSeconds(): number { return this.clockSeconds; }
  setPlaybackSeconds(seconds: number): void { this.clockSeconds = this.advanceClock(seconds); this.pixelsDirty = true; }

  /** How many lamps an outline layer's profile actually makes (docs/17-emitters.md) — the whole curve's without a layer; 0 when none. */
  lampCount(curveId: Id, layerId?: Id): number {
    if (layerId) return this.lampCache.get(layerKey(curveId, layerId))?.lamps.count ?? 0;
    let n = 0;
    for (const [key, hit] of this.lampCache) if (key.startsWith(`${curveId}/`)) n += hit.lamps.count;
    return n;
  }

  // -- gizmo -------------------------------------------------------------------

  get gizmoMode(): GizmoMode { return this.gizmo.mode; }

  setPickFilter(f: Partial<PickFilter>): void {
    this.pickFilter = { ...this.pickFilter, ...f };
    this.onUiChange();
  }

  togglePickLevel(level: PickLevel): void { this.setPickFilter({ [level]: !this.pickFilter[level] }); }

  setGizmoMode(m: GizmoMode): void {
    this.gizmo.mode = m;
    this.editTool = 'select';
    this.focusTool = false;
    this.showFocusMarker(null);
    if (this.planeTool) this.setPlaneTool(null);
    this.onUiChange();
    this.syncGizmo();
  }

  setFocusTool(on: boolean): void {
    this.focusTool = on;
    if (!on) this.showFocusMarker(null);
    else if (this.planeTool) this.setPlaneTool(null);
    this.onUiChange();
  }

  // -- plane tools: offset / trim / fillet (docs/29-offset-trim-fillet.md) --------------------

  /** Switch a plane tool on (Object mode only) or off; the fillet radius starts at the profile's minimum bend radius. */
  setPlaneTool(t: PlaneTool | null): void {
    if (t && this.store.mode.kind !== 'object') return;
    this.planeTool = t;
    this.filletFirst = null;
    this.toolMessage = '';
    if (t) { this.focusTool = false; this.showFocusMarker(null); }
    if (t === 'fillet' && !this.toolValues.fillet) {
      // the largest minimum bend radius across the curve's layers: one click makes the bend legal for all of them (docs/30 §3)
      const c = this.store.activeCurve() ?? this.store.project.curves[0] ?? null;
      const radii = c ? c.outline.map((l) => this.store.profileOf(l).limits.minBendRadius) : [this.store.project.profiles[0]?.limits.minBendRadius ?? 0];
      this.toolValues.fillet = Math.max(0, ...radii) || 50;
    }
    this.onUiChange();
    this.onToolChange();
    this.sync();
  }

  setToolValue(which: 'offset' | 'fillet', v: number): void {
    if (!Number.isFinite(v)) return;
    this.toolValues[which] = which === 'fillet' ? Math.max(0, v) : v;
    this.onToolChange();
  }

  private say(msg: string): void { this.toolMessage = msg; this.onToolChange(); }

  private clearToolPreview(): void { this.disposeGroup(this.toolGroup); }

  /** The tools' own pick: the nearest sampled point of any visible planar curve within `maxPx`. */
  private pickSample(m: Vec2, maxPx = 10): { id: Id; s: number } | null {
    let best: { id: Id; s: number } | null = null, bestD = maxPx * maxPx;
    for (const c of this.curveSamples) for (let i = 0; i < c.world.length; i++) {
      const p = this.toScreen(c.world[i]);
      const d = (p.x - m.x) ** 2 + (p.y - m.y) ** 2;
      if (d < bestD) { bestD = d; best = { id: c.id, s: c.s[i] }; }
    }
    return best;
  }

  private pickCorner(m: Vec2, maxPx = 12): { id: Id; vid: Id; world: THREE.Vector3 } | null {
    let best: { id: Id; vid: Id; world: THREE.Vector3 } | null = null, bestD = maxPx * maxPx;
    for (const c of this.corners) { const d = this.dist(m, c.world) ** 2; if (d < bestD) { bestD = d; best = c; } }
    return best;
  }

  /** A screen-facing ring of `px` radius at a world point, drawn into the tool previews. */
  private ringAt(at: THREE.Vector3, px: number, color: number): void {
    const r = px * this.worldPerPixel(at);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i++) { const a = (i / 32) * Math.PI * 2; pts.push(at.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r)); }
    this.toolGroup.add(this.line(pts, color));
  }

  private cutsOf(id: Id): number[] {
    let cuts = this.cutsCache.get(id);
    if (!cuts) { cuts = cmd.cutsOn(this.store, id); this.cutsCache.set(id, cuts); }
    return cuts;
  }

  /** The offset copy of a curve at `d`, previewed as a pink line. */
  private offsetPreview(id: Id, d: number): void {
    const c = this.store.project.curves.find((x) => x.id === id);
    const ev = this.store.evals.get(id);
    if (!c || !ev || !d) return;
    const off = offsetGeo(c.curve, d, ev.sampling);
    if (!off) return;
    const frame = this.frameOfCurve(c);
    const pts = sampleCurve(off).samples.map((p) => fromPlane(frame, p));
    if (pts.length >= 2) this.toolGroup.add(this.line(pts, PINK));
  }

  /** The piece a trim at `s` would remove, previewed as a pink line (nothing when there is nothing to trim against). */
  private trimPreview(id: Id, s: number): boolean {
    const c = this.store.project.curves.find((x) => x.id === id);
    const ev = this.store.evals.get(id);
    const cs = this.curveSamples.find((x) => x.id === id);
    if (!c || !ev?.sampling.path || !cs) return false;
    const span = trimSpan(c.curve, ev.sampling, s, this.cutsOf(id));
    if (!span) return false;
    const L = ev.sampling.length;
    const frame = this.frameOfCurve(c);
    const at = (u: number) => { const p = ev.sampling.path!.getPointAt(Math.min(1, Math.max(0, u / L))); return fromPlane(frame, { x: p.x, y: p.y }); };
    const between = (a: number, b: number) => [at(a), ...cs.world.filter((_, i) => cs.s[i] > a && cs.s[i] < b), at(b)];
    const lo = span.lo ?? 0, hi = span.hi ?? L;
    const pts = lo <= hi ? between(lo, hi) : [...between(lo, L), ...between(0, hi)];
    this.toolGroup.add(this.line(pts, PINK));
    return true;
  }

  /** Hover for the active tool: draw what a click would do and return the cursor. */
  private hoverTool(m: Vec2): string {
    this.clearToolPreview();
    const tool = this.planeTool!;
    const first = this.filletFirst ? this.curveSamples.find((x) => x.id === this.filletFirst) : null;
    if (first) this.toolGroup.add(this.line(first.world, ACCENT));
    if (tool === 'fillet') {
      const corner = this.pickCorner(m);
      if (corner) { this.ringAt(corner.world, 11, PINK); return 'pointer'; }
    }
    const hit = this.pickSample(m);
    if (!hit) return 'crosshair';
    if (tool === 'offset') this.offsetPreview(hit.id, this.toolValues.offset);
    else if (tool === 'trim') { if (!this.trimPreview(hit.id, hit.s)) return 'not-allowed'; }
    else if (hit.id !== this.filletFirst) { const cs = this.curveSamples.find((x) => x.id === hit.id); if (cs) this.toolGroup.add(this.line(cs.world, PINK)); }
    return 'pointer';
  }

  /** A press with a plane tool active: offset starts a drag, trim and fillet act at once. */
  private toolPress(m: Vec2, e: PointerEvent): void {
    const tool = this.planeTool!;
    this.drag = { kind: 'none', moved: true };
    const hit = tool === 'fillet' ? null : this.pickSample(m);
    if (tool === 'offset') {
      if (!hit) return;
      const c = this.store.project.curves.find((x) => x.id === hit.id)!;
      this.drag = { kind: 'offset', id: hit.id, frame: this.frameOfCurve(c), d: this.toolValues.offset, moved: false };
      this.controls.enabled = false;
      this.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'trim') {
      if (!hit) return;
      const left = cmd.trimCurve(this.store, hit.id, hit.s);
      this.say(left ? (left.length === 2 ? 'Cut out — the curve is now two' : 'Trimmed') : 'Nothing to trim against: no other curve on the plane crosses it on that side');
      return;
    }
    const r = this.toolValues.fillet;
    const corner = this.pickCorner(m);
    if (corner) {
      this.filletFirst = null;
      const ok = cmd.filletVertex(this.store, corner.id, corner.vid, r);
      this.say(ok ? `Rounded to R ${r} mm` : `R ${r} mm does not fit that corner — a smaller radius will`);
      return;
    }
    const pick = this.pickSample(m);
    if (!pick) return;
    const c = this.store.project.curves.find((x) => x.id === pick.id)!;
    if (c.curve.closed) { this.say('A closed curve has no ends to join — click one of its corners instead'); return; }
    if (!this.filletFirst || this.filletFirst === pick.id) { this.filletFirst = pick.id; this.say('Now click the second open curve'); this.sync(); return; }
    const a = this.filletFirst;
    this.filletFirst = null;
    const id = cmd.filletCurves(this.store, a, pick.id, r);
    this.say(id ? (r > 0 ? `Joined at the corner and rounded to R ${r} mm` : 'Joined at the corner') : 'No corner: the ends are parallel, the curves sit on different planes, or R does not fit');
    if (!id) this.sync();
  }

  /** The focus tool's click: the first geometry under the pointer sets the DOF focus (its depth along the view) and turns DOF on. */
  focusAt(m: Vec2): boolean {
    this.raycaster.setFromCamera(new THREE.Vector2((m.x / this.width) * 2 - 1, -(m.y / this.height) * 2 + 1), this.camera);
    // meshes, and the curves' centre lines within ~8 px (a thin wire is easy to miss)
    this.raycaster.params.Line = { threshold: this.worldPerPixel(this.controls.target) * 8 };
    const hit = this.raycaster.intersectObjects(this.content.children, true).find((h) => (h.object as THREE.Mesh).isMesh || (h.object as THREE.Line).isLine);
    this.raycaster.params.Line = { threshold: 1 };
    if (!hit) return false;
    const depth = -hit.point.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
    const focus = { enabled: true, focusDistance: Math.max(1, Math.round(depth)) };
    cmd.updateCamera(this.store, activeCameraOf(this.store.project).id, { dof: focus });
    this.showFocusMarker(hit.point);
    return true;
  }

  private showFocusMarker(at: THREE.Vector3 | null): void {
    if (!at) { if (this.focusMarker) { this.scene.remove(this.focusMarker); this.focusMarker.geometry.dispose(); (this.focusMarker.material as THREE.Material).dispose(); this.focusMarker = null; } return; }
    if (!this.focusMarker) {
      this.focusMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.85, depthTest: false }));
      this.focusMarker.renderOrder = 5;
      this.scene.add(this.focusMarker);
    }
    this.focusMarker.position.copy(at);
    const px = this.worldPerPixel(at) * 6;
    this.focusMarker.scale.setScalar(px);
  }

  setEditTool(t: EditTool): void {
    this.editTool = t;
    this.onUiChange();
    this.syncGizmo();
  }

  /** World frame of a plane: the objects it sits in, then its own placement (docs/18-nested-objects.md §2). */
  private frameOf(plane: Plane): PlaneFrame {
    return planeWorld(this.store.project, plane);
  }

  private frameOfCurve(c: CurveObject): PlaneFrame {
    return planeWorld(this.store.project, this.store.planeOf(c));
  }

  /** Every plane inside the given objects, at any depth. */
  private planesOfGroups(ids: Id[]): Set<Id> {
    const { project } = this.store.state;
    const out = new Set<Id>();
    for (const id of ids) { const g = findGroup(project, id); if (g) for (const pid of subtreePlanes(project, g)) out.add(pid); }
    return out;
  }

  /** World vertices of all curves inside the objects, and their bounds centre. */
  private groupVertices(ids: Id[]): { verts: THREE.Vector3[]; pivot: THREE.Vector3 } {
    const { project } = this.store.state;
    const planes = this.planesOfGroups(ids);
    const verts: THREE.Vector3[] = [];
    for (const c of project.curves) {
      if (!planes.has(c.planeId)) continue;
      const f = this.frameOfCurve(c);
      for (const v of c.curve.points) verts.push(fromPlane(f, v));
    }
    const box = new THREE.Box3();
    if (verts.length) box.setFromPoints(verts);
    else {
      for (const pid of planes) { const p = project.planes.find((x) => x.id === pid); if (p) box.expandByPoint(this.frameOf(p).origin); }
      // an object with no planes of its own still has a place: its origin
      for (const id of ids) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(groupMatrix(project, id)));
    }
    return { verts, pivot: box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()) };
  }

  /** World vertices of every visible curve outside the objects (snap candidates while they are dragged). */
  private verticesOutsideGroup(ids: Id[]): THREE.Vector3[] {
    const { project } = this.store.state;
    const planes = this.planesOfGroups(ids);
    const out: THREE.Vector3[] = [];
    for (const c of project.curves) {
      if (planes.has(c.planeId) || !planeVisible(project, c.planeId)) continue;
      const f = this.frameOfCurve(c);
      for (const v of c.curve.points) out.push(fromPlane(f, v));
    }
    return out;
  }

  private syncGizmo(): void {
    if (this.gizmo.dragging) return;
    const { mode, selection, project } = this.store.state;
    if (mode.kind === 'edit') {
      // Edit mode: the same in-plane gizmo as for curves, on the selected vertices (hidden while adding points)
      const c = this.store.editingCurve();
      const pts = c ? c.curve.points.filter((v) => selection.vertices.includes(v.id)) : [];
      // pivot: bounds centre in the plane, at the mean normal offset; a 3D curve gets the Z arrow (Move)
      if (c && pts.length && this.editTool === 'select' && this.frame) this.gizmo.attachCurves(this.frame.matrix, fromPlane(this.frame, curveBounds(pts).center, this.meanZ(pts)), c.type === 'spatial');
      else this.gizmo.detach();
      return;
    }
    if (selection.loftId || selection.shapeId) { this.gizmo.detach(); return; }
    // an array handle takes the gizmo from the plane it belongs to (docs/26-array.md §3)
    const arrayPlane = selection.arrayHandle ? this.arrayPlane() : null;
    if (arrayPlane?.array && selection.arrayHandle) {
      const frame = this.frameOf(arrayPlane);
      const p = this.arrayHandleLocal(arrayPlane.array, selection.arrayHandle, this.arrayHandleLength(arrayPlane));
      if (p) { this.gizmo.attachArray(frame.matrix, fromPlane(frame, p, p.z)); return; }
    }
    if (selection.groups.length) { this.gizmo.attachGroup(this.groupVertices(selection.groups).pivot); return; }
    if (selection.planeSelected && selection.planeId) {
      const plane = project.planes.find((p) => p.id === selection.planeId);
      if (plane) { this.gizmo.attachPlane(this.frameOf(plane).matrix); return; }
    }
    const sel = this.gizmoCurves();
    if (sel) {
      const pts = sel.curves.flatMap((c) => c.curve.points);
      if (pts.length) { this.gizmo.attachCurves(sel.frame.matrix, fromPlane(sel.frame, curveBounds(pts).center)); return; }
    }
    this.gizmo.detach();
  }

  /** Selected curves on the primary curve's plane (the ones a curve gizmo acts on). */
  private gizmoCurves(): { curves: CurveObject[]; plane: Plane; frame: PlaneFrame } | null {
    const { selection, project } = this.store.state;
    const primary = project.curves.find((c) => c.id === this.store.primaryCurveId);
    if (!primary) return null;
    const plane = this.store.planeOf(primary);
    const curves = project.curves.filter((c) => selection.curves.includes(c.id) && c.planeId === plane.id);
    return { curves, plane, frame: this.frameOf(plane) };
  }

  /** Vertices of every curve that is not being moved, projected onto `frame` (plane coords). */
  private otherVerticesOnPlane(frame: PlaneFrame, movedIds: Set<Id>): Vec2[] {
    const out: Vec2[] = [];
    for (const c of this.store.project.curves) {
      if (movedIds.has(c.id)) continue;
      const f = this.frameOfCurve(c);
      for (const v of c.curve.points) out.push(toPlane(frame, fromPlane(f, v)));
    }
    return out;
  }

  /** World vertices of every curve not on `planeId`. */
  private otherVerticesWorld(planeId: Id): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const c of this.store.project.curves) {
      if (c.planeId === planeId) continue;
      const f = this.frameOfCurve(c);
      for (const v of c.curve.points) out.push(fromPlane(f, v));
    }
    return out;
  }

  private meanZ(pts: { z: number }[]): number {
    return pts.length ? pts.reduce((s, v) => s + v.z, 0) / pts.length : 0;
  }

  private nearestVec2(points: Vec2[], to: Vec2): Vec2 | null {
    let best: Vec2 | null = null, bd = Infinity;
    for (const p of points) { const d = (p.x - to.x) ** 2 + (p.y - to.y) ** 2; if (d < bd) { bd = d; best = p; } }
    return best ? { ...best } : null;
  }

  /**
   * Snap an anchor (plane coords) that has been moved by `delta`: onto a nearby
   * vertex (exact), else alignment guides + grid. Only the allowed axes move.
   * Returns the corrected delta.
   */
  private snapAnchor2D(anchor0: Vec2, delta: Vec2, candidates: Vec2[], frame: PlaneFrame, allow: { x: boolean; y: boolean }, shift: boolean): Vec2 {
    const a = { x: anchor0.x + delta.x, y: anchor0.y + delta.y };
    this.snapTarget = null;
    this.guides = [];
    this.guideAnchor = a;
    if (shift) return delta;
    const tol = 10 * this.worldPerPixel(fromPlane(frame, a));
    let best: Vec2 | null = null, bd = tol;
    for (const c of candidates) {
      const dx = allow.x ? c.x - a.x : 0, dy = allow.y ? c.y - a.y : 0;
      const d = Math.hypot(dx, dy);
      if (d < bd && (allow.x || Math.abs(c.x - a.x) < tol) && (allow.y || Math.abs(c.y - a.y) < tol)) { bd = d; best = c; }
    }
    let snapped: Vec2;
    if (best) {
      snapped = { x: allow.x ? best.x : a.x, y: allow.y ? best.y : a.y };
      this.snapTarget = fromPlane(frame, best);
    } else {
      snapped = { ...a };
      if (this.store.state.alignSnap) {
        const r = alignSnap(a, candidates, tol);
        this.guides = r.guides.filter((g) => (g.axis === 'v' ? allow.x : allow.y));
        if (allow.x && this.guides.some((g) => g.axis === 'v')) snapped.x = r.point.x;
        if (allow.y && this.guides.some((g) => g.axis === 'h')) snapped.y = r.point.y;
      }
      if (this.store.state.snap) {
        if (allow.x && !this.guides.some((g) => g.axis === 'v')) snapped.x = Math.round(snapped.x / GRID) * GRID;
        if (allow.y && !this.guides.some((g) => g.axis === 'h')) snapped.y = Math.round(snapped.y / GRID) * GRID;
      }
    }
    this.guideAnchor = snapped;
    return { x: snapped.x - anchor0.x, y: snapped.y - anchor0.y };
  }

  /** World-space anchor snapping for plane moves: nearest other vertex within 10 px on the allowed axes. */
  private snapAnchor3D(anchor0: THREE.Vector3, delta: THREE.Vector3, candidates: THREE.Vector3[], allow: { x: boolean; y: boolean; z: boolean }, shift: boolean): THREE.Vector3 {
    this.snapTarget = null;
    if (shift) return delta;
    const a = anchor0.clone().add(delta);
    const tol = 10 * this.worldPerPixel(a);
    let best: THREE.Vector3 | null = null, bd = tol;
    for (const c of candidates) {
      const d = Math.hypot(allow.x ? c.x - a.x : 0, allow.y ? c.y - a.y : 0, allow.z ? c.z - a.z : 0);
      if (d < bd && (allow.x || Math.abs(c.x - a.x) < tol) && (allow.y || Math.abs(c.y - a.y) < tol) && (allow.z || Math.abs(c.z - a.z) < tol)) { bd = d; best = c; }
    }
    if (!best) {
      if (!this.store.state.snap) return delta;
      const g = new THREE.Vector3(allow.x ? Math.round(a.x / GRID) * GRID : a.x, allow.y ? Math.round(a.y / GRID) * GRID : a.y, allow.z ? Math.round(a.z / GRID) * GRID : a.z);
      return g.sub(anchor0);
    }
    this.snapTarget = best.clone();
    return new THREE.Vector3(allow.x ? best.x : a.x, allow.y ? best.y : a.y, allow.z ? best.z : a.z).sub(anchor0);
  }

  private gizmoStart(): void {
    const { project, selection } = this.store.state;
    this.gizmo.setSnapping(this.store.state.snap);
    if (this.gizmo.kind === 'array' && selection.arrayHandle) {
      const plane = this.arrayPlane();
      if (!plane) return;
      this.gizmoDrag = { kind: 'array', planeId: plane.id, handle: selection.arrayHandle, frame: this.frameOf(plane) };
      return;
    }
    if (this.gizmo.kind === 'group' && selection.groups.length) {
      const snap = cmd.snapshotGroups(this.store, selection.groups);
      if (!snap) return;
      const { verts, pivot } = this.groupVertices(selection.groups);
      let anchor0: THREE.Vector3 | null = null, bd = Infinity;
      for (const v of verts) { const d = v.distanceToSquared(pivot); if (d < bd) { bd = d; anchor0 = v; } }
      this.gizmoDrag = { kind: 'group', groupIds: selection.groups, snap, pivot, anchor0, candidates: this.verticesOutsideGroup(selection.groups) };
      return;
    }
    if (this.gizmo.kind === 'plane' && selection.planeId) {
      const plane = project.planes.find((p) => p.id === selection.planeId);
      if (!plane) return;
      const frame = this.frameOf(plane);
      const mine = project.curves.filter((c) => c.planeId === plane.id);
      const verts = mine.flatMap((c) => c.curve.points.map((v) => fromPlane(frame, v)));
      let anchor0: THREE.Vector3 | null = null, bd = Infinity;
      for (const v of verts) { const d = v.distanceToSquared(frame.origin); if (d < bd) { bd = d; anchor0 = v; } }
      this.gizmoDrag = { kind: 'plane', planeId: plane.id, origin: { x: frame.origin.x, y: frame.origin.y, z: frame.origin.z }, originals: cmd.snapshotCurves(this.store, mine.map((c) => c.id)), anchor0, candidates: this.otherVerticesWorld(plane.id) };
    } else if (this.gizmo.kind === 'curves' && this.store.mode.kind === 'edit') {
      const c = this.store.editingCurve();
      if (!c || !this.frame) return;
      const vids = selection.vertices.filter((id) => c.curve.points.some((v) => v.id === id));
      const pts = c.curve.points.filter((v) => vids.includes(v.id));
      if (!pts.length) return;
      const pivot = curveBounds(pts).center;
      this.gizmoDrag = { kind: 'vertices', id: c.id, frame: this.frame, pivot, pivotZ: this.meanZ(pts), original: snapshotCurve(c), vids, anchor0: this.nearestVec2(pts, pivot), candidates: this.collectSnapCandidates(this.frame, new Set(vids)) };
    } else if (this.gizmo.kind === 'curves') {
      const sel = this.gizmoCurves();
      if (!sel) return;
      const pts = sel.curves.flatMap((c) => c.curve.points);
      const pivot = curveBounds(pts).center;
      const ids = new Set(sel.curves.map((c) => c.id));
      this.gizmoDrag = { kind: 'curves', frame: sel.frame, pivot, originals: cmd.snapshotCurves(this.store, [...ids]), anchor0: this.nearestVec2(pts, pivot), candidates: this.otherVerticesOnPlane(sel.frame, ids) };
    }
  }

  private gizmoChange(): void {
    const d = this.gizmoDrag;
    if (!d) return;
    const proxy = this.gizmo.proxy;
    const mode = this.gizmo.mode;
    if (d.kind === 'array') { this.dragArrayHandle(d.planeId, d.handle, d.frame, proxy.position.clone().applyMatrix4(d.frame.inverse)); return; }
    if (d.kind === 'group') {
      const zero = { x: 0, y: 0, z: 0 };
      const ident = { x: 0, y: 0, z: 0, w: 1 };
      const pv = { x: d.pivot.x, y: d.pivot.y, z: d.pivot.z };
      if (mode === 'translate') {
        let delta = proxy.position.clone().sub(d.pivot);
        if (d.anchor0) { delta = this.snapAnchor3D(d.anchor0, delta, d.candidates, axisMask(this.gizmo.axis), this.shiftHeld); proxy.position.copy(d.pivot).add(delta); }
        cmd.transformGroup(this.store, d.snap, { pivot: pv, translation: { x: delta.x, y: delta.y, z: delta.z }, rotation: ident, scale: 1 }, true);
      } else if (mode === 'rotate') {
        const q = proxy.quaternion;
        cmd.transformGroup(this.store, d.snap, { pivot: pv, translation: zero, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, scale: 1 }, true);
      } else {
        const k = this.gizmo.axis === 'Y' ? proxy.scale.y : this.gizmo.axis === 'Z' ? proxy.scale.z : proxy.scale.x;
        cmd.transformGroup(this.store, d.snap, { pivot: pv, translation: zero, rotation: ident, scale: Math.max(0.01, k) }, true);
      }
      return;
    }
    if (d.kind === 'plane') {
      // the gizmo is in world space; the plane's placement is local to the object it sits in (docs/18-nested-objects.md §2)
      const parent = groupMatrix(this.store.project, groupOfPlane(this.store.project, d.planeId)?.id ?? null);
      if (mode === 'translate') {
        const origin = new THREE.Vector3(d.origin.x, d.origin.y, d.origin.z);
        if (d.anchor0) {
          const delta = this.snapAnchor3D(d.anchor0, proxy.position.clone().sub(origin), d.candidates, axisMask(this.gizmo.axis), this.shiftHeld);
          proxy.position.copy(origin).add(delta);
        }
        const local = localPlacement(parent, new THREE.Matrix4().compose(proxy.position, proxy.quaternion, new THREE.Vector3(1, 1, 1)));
        cmd.setPlaneTransform(this.store, d.planeId, local.position, null, true);
      } else if (mode === 'rotate') {
        const local = localPlacement(parent, new THREE.Matrix4().compose(new THREE.Vector3(d.origin.x, d.origin.y, d.origin.z), proxy.quaternion, new THREE.Vector3(1, 1, 1)));
        cmd.setPlaneTransform(this.store, d.planeId, local.position, local.rotation, true);
      } else {
        cmd.transformCurves(this.store, d.originals, { pivot: { x: 0, y: 0 }, angle: 0, sx: proxy.scale.x, sy: proxy.scale.y, tx: 0, ty: 0 }, true);
      }
      return;
    }
    // curves (Object mode) and vertices (Edit mode): the same in-plane affine; vertices of a 3D curve also move along the normal (Z arrow)
    const local = proxy.position.clone().applyMatrix4(d.frame.inverse);
    let a: Affine2;
    if (mode === 'translate') {
      let delta = { x: local.x - d.pivot.x, y: local.y - d.pivot.y };
      const pz = d.kind === 'vertices' ? d.pivotZ : 0;
      let dz = d.kind === 'vertices' ? local.z - pz : 0;
      if (dz && this.store.state.snap && !this.shiftHeld) dz = Math.round(dz / GRID) * GRID;
      if (d.anchor0) {
        const m = axisMask(this.gizmo.axis);
        delta = this.snapAnchor2D(d.anchor0, delta, d.candidates, d.frame, { x: m.x, y: m.y }, this.shiftHeld);
      }
      proxy.position.copy(fromPlane(d.frame, { x: d.pivot.x + delta.x, y: d.pivot.y + delta.y }, pz + dz));
      a = translation(delta.x, delta.y, dz);
    } else if (mode === 'rotate') {
      const fq = new THREE.Quaternion().setFromRotationMatrix(d.frame.matrix);
      const ql = fq.invert().multiply(proxy.quaternion);
      const angle = 2 * Math.atan2(ql.z, ql.w);
      a = { pivot: d.pivot, angle, sx: 1, sy: 1, tx: 0, ty: 0 };
    } else {
      a = { pivot: d.pivot, angle: 0, sx: proxy.scale.x, sy: proxy.scale.y, tx: 0, ty: 0 };
    }
    if (d.kind === 'vertices') cmd.transformVertices(this.store, d.id, d.original, d.vids, a, true);
    else cmd.transformCurves(this.store, d.originals, a, true);
  }

  /**
   * An array handle dragged to `local` (plane coordinates): the offset and the axis
   * point go where they are put, the "up" handle only aims and springs back to its
   * length (docs/26-array.md §3). Live — one undo step when the drag ends.
   */
  private dragArrayHandle(planeId: Id, handle: ArrayHandle, frame: PlaneFrame, local: THREE.Vector3): void {
    const plane = this.store.project.planes.find((p) => p.id === planeId);
    const mod = plane?.array;
    if (!plane || !mod) return;
    const grid = this.store.state.snap && !this.shiftHeld;
    const g = (v: number) => (grid ? Math.round(v / GRID) * GRID : Math.round(v * 10) / 10);
    const p = { x: g(local.x), y: g(local.y), z: g(local.z) };
    if (mod.type === 'linear' && handle === 'offset') cmd.setPlaneModifier(this.store, planeId, { ...mod, offset: p }, true);
    else if (mod.type === 'circular' && handle === 'center') cmd.setPlaneModifier(this.store, planeId, { ...mod, center: p }, true);
    else if (mod.type === 'circular' && handle === 'axis') {
      const dir = new THREE.Vector3(local.x - mod.center.x, local.y - mod.center.y, local.z - mod.center.z);
      if (dir.lengthSq() < 1e-6) return;
      const axis = dir.normalize();
      cmd.setPlaneModifier(this.store, planeId, { ...mod, axis: { x: axis.x, y: axis.y, z: axis.z } }, true);
    } else return;
    // the handle is where the modifier says it is, not where the pointer went
    const now = this.store.project.planes.find((x) => x.id === planeId)?.array;
    const at = now ? this.arrayHandleLocal(now, handle, this.arrayHandleLength(plane)) : null;
    if (at) this.gizmo.proxy.position.copy(fromPlane(frame, at, at.z));
  }

  private gizmoEnd(): void {
    if (!this.gizmoDrag) return;
    this.gizmoDrag = null;
    this.snapTarget = null;
    this.guides = [];
    this.guideAnchor = null;
    this.gizmo.proxy.scale.set(1, 1, 1);
    cmd.commit(this.store);
    this.sync();
  }

  private line(points: THREE.Vector3[], color: number, opts: { dashed?: boolean; opacity?: number } = {}): THREE.Line {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = opts.dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 12, gapSize: 8, depthTest: false, transparent: true, opacity: opts.opacity ?? 1 })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: opts.opacity ?? 1 });
    const l = new THREE.Line(geo, mat);
    if (opts.dashed) l.computeLineDistances();
    l.renderOrder = 5;
    return l;
  }

  private billboard(geo: THREE.BufferGeometry, color: number | string, px: number, at: THREE.Vector3, aspect = 1, map?: THREE.Texture): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: map ? 0xffffff : color, ...(map ? { map } : {}), transparent: true, depthTest: false }));
    mesh.position.copy(at);
    mesh.renderOrder = 6;
    this.helpers.add(mesh);
    this.billboards.push({ mesh, px, aspect });
    return mesh;
  }

  /**
   * The plane's reference image (docs/19-reference-image.md): an unlit, un-tone-mapped quad
   * lying just behind the plane, so whatever is traced on top of it is drawn in front.
   */
  private imageMesh(plane: Plane): THREE.Mesh | null {
    const img = plane.image;
    if (!img || !img.visible) return null;
    const map = this.textures.get(img.texture);
    if (!map) return null;
    const t = this.store.project.textures.find((x) => x.id === img.texture);
    const aspect = t && t.width && t.height ? t.height / t.width : 1;
    const mesh = new THREE.Mesh(this.squareGeo, new THREE.MeshBasicMaterial({ map, transparent: true, opacity: img.opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    mesh.scale.set(img.width, img.width * aspect, 1);
    mesh.position.set(img.center.x, img.center.y, IMAGE_Z);
    mesh.rotation.z = (img.rotation * Math.PI) / 180;
    mesh.renderOrder = -1;
    mesh.userData = { planeImage: plane.id };
    return mesh;
  }

  /** The image's four corners in plane coordinates (centre, size and turn), or null. */
  private imageCornersLocal(plane: Plane): Vec2[] | null {
    const img = plane.image;
    if (!img) return null;
    const t = this.store.project.textures.find((x) => x.id === img.texture);
    const aspect = t && t.width && t.height ? t.height / t.width : 1;
    const hw = img.width / 2, hh = (img.width * aspect) / 2;
    const a = (img.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: img.center.x + x * cos - y * sin, y: img.center.y + x * sin + y * cos }));
  }

  /** How far from the axis point the circular array's "up" handle sits: the plane's content radius, at least 300 mm. */
  private arrayHandleLength(plane: Plane): number {
    const pts = this.store.project.curves.filter((c) => c.planeId === plane.id).flatMap((c) => c.curve.points);
    if (!pts.length) return 300;
    const b = curveBounds(pts);
    return Math.max(300, Math.round(Math.hypot(b.max.x - b.center.x, b.max.y - b.center.y)));
  }

  /** Plane-local position of one array handle (docs/26-array.md §3), or null when this array has none. */
  private arrayHandleLocal(mod: ArrayModifier, handle: ArrayHandle, len: number): Vec3 | null {
    if (mod.type === 'linear') return handle === 'offset' ? { ...mod.offset } : null;
    if (handle === 'center') return { ...mod.center };
    if (handle !== 'axis') return null;
    const a = arrayAxis(mod).multiplyScalar(len);
    return { x: mod.center.x + a.x, y: mod.center.y + a.y, z: mod.center.z + a.z };
  }

  /** The plane whose array handles are on show: the plane itself has to be the selected thing. */
  private arrayPlane(): Plane | null {
    const { selection, mode, project } = this.store.state;
    if (mode.kind !== 'object' || !selection.planeSelected || !selection.planeId) return null;
    const plane = project.planes.find((p) => p.id === selection.planeId);
    return plane?.array ? plane : null;
  }

  /** The array's handles, drawn in the plane's frame; picking and the gizmo read `arrayHandles`. */
  private buildArrayHandles(plane: Plane, frame: PlaneFrame, local: THREE.Group): void {
    const mod = plane.array;
    if (!mod) return;
    const picked = this.store.selection.arrayHandle;
    const len = this.arrayHandleLength(plane);
    const V = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
    const kinds: ArrayHandle[] = mod.type === 'linear' ? ['offset'] : ['center', 'axis'];
    if (mod.type === 'linear') {
      local.add(this.line([new THREE.Vector3(), V(mod.offset)], AMBER, { dashed: true, opacity: 0.9 }));
    } else {
      const a = arrayAxis(mod).multiplyScalar(len);
      const c = V(mod.center);
      local.add(this.line([c.clone().sub(a), c.clone().add(a)], AMBER, { dashed: true, opacity: 0.9 }));
    }
    for (const kind of kinds) {
      const p = this.arrayHandleLocal(mod, kind, len);
      if (!p) continue;
      const at = fromPlane(frame, p, p.z);
      this.arrayHandles.push(at);
      this.arrayHandleKinds.push(kind);
      this.billboard(kind === 'center' ? this.ringGeo : this.squareGeo, picked === kind ? ACCENT : AMBER, ARRAY_HANDLE_PX, at);
    }
  }

  private buildActiveHelpers(plane: Plane, active: CurveObject | null, editing: boolean): void {
    const frame = this.frameOf(plane);
    this.frame = frame;
    const local = new THREE.Group();
    local.matrixAutoUpdate = false;
    local.matrix.copy(frame.matrix);
    const V = (p: Vec2 & { z?: number }, z = p.z ?? 0) => new THREE.Vector3(p.x, p.y, z);

    // plane grid around everything on the plane
    const all = this.store.project.curves.filter((c) => c.planeId === plane.id).flatMap((c) => c.curve.points);
    const b = curveBounds(all);
    const span = Math.max(1200, (b.max.x - b.min.x) + 600, (b.max.y - b.min.y) + 600);
    const size = Math.ceil(span / 100) * 100;
    const grid = new THREE.GridHelper(size, size / 50, 0x3a3a44, 0x26262c);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(Math.round(b.center.x / 50) * 50, Math.round(b.center.y / 50) * 50, 0);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = editing ? 0.9 : 0.35;
    local.add(grid);

    // an unlocked reference image shows its outline and four corner handles (drag = move / scale)
    this.imageCorners = [];
    const img = plane.image;
    const corners = img && img.visible && !img.locked ? this.imageCornersLocal(plane) : null;
    if (corners) {
      local.add(this.line([...corners, corners[0]].map((c) => V(c, IMAGE_Z)), TEAL, { dashed: true, opacity: 0.9 }));
      for (const c of corners) {
        const at = fromPlane(frame, { x: c.x, y: c.y, z: IMAGE_Z });
        this.imageCorners.push(at);
        this.billboard(this.squareGeo, TEAL, IMAGE_CORNER_PX, at);
      }
    }
    if (this.imageCalibrate?.planeId === plane.id && this.imageCalibrate.first) {
      this.billboard(this.ringGeo, PINK, 20, fromPlane(frame, { x: this.imageCalibrate.first.x, y: this.imageCalibrate.first.y, z: IMAGE_Z }));
    }
    if (this.arrayPlane()?.id === plane.id) this.buildArrayHandles(plane, frame, local);

    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)), new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: editing ? 0.6 : 0.3 }));
    border.position.copy(grid.position);
    local.add(border);

    // violations of the selected curves (or the edited one)
    const shown = editing && active ? [active] : this.store.project.curves.filter((c) => this.store.selection.curves.includes(c.id));
    for (const c of shown) {
      const ev = this.store.evals.get(c.id)!;
      const r = 12;   // highlight tube around the curve (the profile's own size is not known here)
      // each layer's violations sit on that layer's own curve (docs/30 §3)
      for (const le of ev.layers) for (const v of le.violations) {
        if (!v.span) continue;
        const pts = samplesBetween(le.sampling, v.span[0], v.span[1]).map((s) => new THREE.Vector3(s.x, s.y, s.z));
        if (pts.length < 2) continue;
        const path = pts.length === 2 ? new THREE.LineCurve3(pts[0], pts[1]) : new THREE.CatmullRomCurve3(pts);
        const color = CHECKS.find((k) => k.id === v.check)?.color ?? '#ff5c5c';
        const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(4, pts.length), r, 10, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }));
        tube.renderOrder = 3;
        local.add(tube);
      }
    }

    if (!editing) {
      for (const g of this.guides) {
        const target: Vec2 = this.guideAnchor ?? g.source;
        const ext2 = 60;
        const p1 = g.axis === 'h' ? { x: Math.min(g.source.x, target.x) - ext2, y: g.value } : { x: g.value, y: Math.min(g.source.y, target.y) - ext2 };
        const p2 = g.axis === 'h' ? { x: Math.max(g.source.x, target.x) + ext2, y: g.value } : { x: g.value, y: Math.max(g.source.y, target.y) + ext2 };
        local.add(this.line([V(p1, 0.5), V(p2, 0.5)], PINK));
        this.billboard(this.squareGeo, PINK, 7, fromPlane(frame, g.source));
      }
    }

    if (editing && active) {
      const ev = this.store.evals.get(active.id)!;
      const pts = active.curve.points;
      const byId = new Map(pts.map((v) => [v.id, v]));
      const selected = new Set(this.store.selection.vertices);
      const primary = this.store.primaryVertex;

      for (const c of active.constraints) {
        const a = byId.get(c.a), bb = c.b ? byId.get(c.b) : undefined;
        if (!a) continue;
        const ok = ev.constraints.get(c.id) !== false;
        const color = ok ? TEAL : RED;
        const css = ok ? '#4fd1c5' : '#ff5c5c';
        if (c.type === 'pin') { this.billboard(this.circleGeo, color, 18, fromPlane(frame, a)); continue; }
        if (!bb) continue;
        local.add(this.line([V(a), V(bb)], color, { dashed: true, opacity: 0.9 }));
        const mid = { x: (a.x + bb.x) / 2, y: (a.y + bb.y) / 2 };
        const text = c.type === 'horizontal' ? '— H' : c.type === 'vertical' ? '| V' : `${(c.value ?? 0).toFixed(0)} mm`;
        this.billboard(this.squareGeo, color, 54, fromPlane(frame, mid), 160 / 48, labelTexture(text, css));
      }

      for (const g of this.guides) {
        const target: Vec2 = this.guideAnchor ?? g.source;
        const ext2 = 60;
        const p1 = g.axis === 'h' ? { x: Math.min(g.source.x, target.x) - ext2, y: g.value } : { x: g.value, y: Math.min(g.source.y, target.y) - ext2 };
        const p2 = g.axis === 'h' ? { x: Math.max(g.source.x, target.x) + ext2, y: g.value } : { x: g.value, y: Math.max(g.source.y, target.y) + ext2 };
        local.add(this.line([V(p1, 0.5), V(p2, 0.5)], PINK));
        this.billboard(this.squareGeo, PINK, 7, fromPlane(frame, g.source));
      }

      const pi = pts.findIndex((v) => v.id === primary);
      if (pi >= 0) {
        const v = pts[pi];
        if (v.type !== 'polygon') {                       // a polygon vertex has no handles to show or drag
          const h = absoluteHandles(pts, active.curve.closed, pi);
          local.add(this.line([V(h.in), V(v), V(h.out)], ACCENT));
          const inW = fromPlane(frame, h.in), outW = fromPlane(frame, h.out);
          this.billboard(this.circleGeo, ACCENT, HANDLE_PX, inW);
          this.billboard(this.circleGeo, ACCENT, HANDLE_PX, outW);
          this.handlesWorld = { in: inW, out: outW };
        }
      }

      // 3D curve: a dashed drop line from every raised vertex to its foot on the plane, so z reads in a tilted view
      if (active.type === 'spatial') for (const v of pts) if (v.z) local.add(this.line([V(v), V(v, 0)], 0x7a8aa8, { dashed: true, opacity: 0.7 }));

      pts.forEach((v, i) => {
        const world = fromPlane(frame, v);
        this.pointsWorld.push(world);
        this.pointIds.push(v.id);
        const color = selected.has(v.id) ? ACCENT : i === 0 ? 0xffffff : 0xd0d0d6;
        const mesh = this.billboard(v.type === 'polygon' ? this.squareGeo : this.circleGeo, color, POINT_PX, world);
        if (v.type === 'polygon') this.billboards[this.billboards.length - 1].diamond = true;
        mesh.userData = { pointIndex: i };
      });
      this.samplesWorld = ev.sampling.samples.map((s) => fromPlane(frame, s));
    }
    this.helpers.add(local);
  }

  /** An outline layer's mesh: its profile's program on the layer's own curve (docs/14, docs/30 §3); a thin tube if the code fails (warned once). */
  private layerGeo(c: CurveObject, le: LayerEval): THREE.BufferGeometry | null {
    const id = layerKey(c.id, le.layer.id);
    const params = paramsOf(le.profile, le.layer);
    const key = JSON.stringify([le.curve, le.profile.code, params]);
    const hit = this.geomCache.get(id);
    if (hit && hit.key === key) return hit.geo;
    const input = shapeInput({ id: c.id, name: c.name, curve: le.curve }, le.sampling);
    if (!input) { hit?.geo.dispose(); this.geomCache.delete(id); return null; }
    let geo: THREE.BufferGeometry;
    const bad = `${id}|${key}`;
    if (this.badShapes.has(bad)) geo = fallbackGeometry(input);
    else {
      try { geo = buildShapeGeometry(le.profile.code, input, params).geometry; }
      catch (e) {
        console.warn(`profile "${le.profile.label}" failed on curve "${c.name}" (layer ${le.layer.id}) — drawing a thin tube:`, e);
        this.badShapes.add(bad);
        geo = fallbackGeometry(input);
      }
    }
    hit?.geo.dispose();
    this.geomCache.set(id, { key, geo });
    return geo;
  }

  /** The lamps of a layer's mesh (docs/17-emitters.md), cached with its geometry. */
  private layerLamps(id: string, geo: THREE.BufferGeometry | null): Lamps | null {
    if (!geo || !geo.hasAttribute('pixel')) { this.lampCache.delete(id); return null; }
    const key = this.geomCache.get(id)?.key ?? '';
    const hit = this.lampCache.get(id);
    if (hit && hit.key === key) return hit.lamps;
    const lamps = lampsOf(geo);
    this.lampCache.set(id, { key, lamps });
    return lamps;
  }

  /** A shape's surface (docs/30 §4), rebuilt when its curves, expand or resolution change. */
  private surfaceOf(shape: Shape, curves: CurveObject[]): { key: string; input: SurfaceInput } | null {
    const key = JSON.stringify([shape.expand, shape.resolution, curves.map((c) => [c.id, c.curve])]);
    const hit = this.surfaceCache.get(shape.id);
    if (hit && hit.key === key) return hit.input ? { key, input: hit.input } : null;
    hit?.input?.sheet.dispose();
    const input = surfaceInput(shape, curves);
    this.surfaceCache.set(shape.id, { key, input });
    return input ? { key, input } : null;
  }

  /** A fill layer's mesh: its fill's program over the surface; nothing if the code fails (warned once). */
  private fillGeo(shape: Shape, layerId: Id, surfaceKey: string, surface: SurfaceInput, code: string, params: Record<string, number>): THREE.BufferGeometry | null {
    const id = layerKey(shape.id, layerId);
    const key = JSON.stringify([surfaceKey, code, params]);
    const hit = this.fillCache.get(id);
    if (hit && hit.key === key) return hit.geo;
    hit?.geo.dispose();
    this.fillCache.delete(id);
    const bad = `${id}|${key}`;
    if (this.badShapes.has(bad)) return null;
    try {
      const geo = buildFillGeometry(code, surface, params).geometry;
      this.fillCache.set(id, { key, geo });
      return geo;
    } catch (e) {
      console.warn(`fill failed on shape "${shape.name}" (layer ${layerId}) — drawing nothing:`, e);
      this.badShapes.add(bad);
      return null;
    }
  }

  /** The default look of a fill layer without a material: its fill's colour, metalness and roughness, both sides (docs/30 §4). */
  private fillMaterial(fill: { color: string; metalness: number; roughness: number }, visual: Visual): THREE.Material {
    const key = `fill|${fill.color}|${fill.metalness}|${fill.roughness}|${visual}`;
    let m = this.matCache.get(key);
    if (!m) {
      const sm = new THREE.MeshStandardNodeMaterial({ color: fill.color, metalness: fill.metalness, roughness: fill.roughness, side: THREE.DoubleSide });
      if (visual !== 'normal') { sm.emissive = new THREE.Color(ACCENT); sm.emissiveIntensity = 0.45; }
      this.matCache.set(key, m = this.lit(sm));
    }
    return m;
  }

  /** Let a material take the light of the LEDs (docs/17-emitters.md); harmless while emitters are off. */
  private lit<T extends THREE.NodeMaterial>(m: T): T {
    this.irradiance ??= new THREE.IrradianceNode(this.emitters.irradianceNode());
    const irr = this.irradiance;
    m.setupLightMap = () => irr;
    return m;
  }

  /** The default look: the shape colour — or the geometry's own color / emissive attributes (docs/14-shapes.md §3). */
  private material(color: string, visual: Visual, geo?: THREE.BufferGeometry, curveId?: Id): THREE.Material {
    const attrs = geo ? `${geo.hasAttribute('color') ? 'c' : ''}${geo.hasAttribute('emissive') ? 'e' : ''}` : '';
    // lamps read their colour from this curve's slots, so a driven string needs its own material
    const driven = !!geo?.hasAttribute('pixel') && !!curveId;
    const key = `${color}|${visual}|${attrs}${driven ? `|px:${curveId}` : ''}`;
    let m = this.matCache.get(key);
    if (!m && attrs && geo) {
      const glow = visual === 'normal' ? null : { color: ACCENT, intensity: visual === 'editing' ? 0.25 : 0.45 };
      const am = attributeMaterial(color, geo, glow)!;
      if (driven) {
        const live = this.pixels.node(this.pixels.baseUniform(curveId!));
        const sel = glow ? tslColor(glow.color).mul(glow.intensity) : null;
        am.emissiveNode = (sel ? live.add(sel as unknown as THREE.Node<'vec3'>) : live) as THREE.Node;
      }
      this.matCache.set(key, m = this.lit(am));
    }
    if (!m) {
      const sm = new THREE.MeshStandardNodeMaterial({ color, metalness: 0.85, roughness: 0.35 });
      if (visual !== 'normal') { sm.emissive = new THREE.Color(ACCENT); sm.emissiveIntensity = visual === 'editing' ? 0.25 : 0.45; }
      this.matCache.set(key, m = this.lit(sm));
    }
    return m;
  }

  /** A project material compiled once per (material, visual); null if none or if its code fails (falls back to the default look). */
  private projectMaterial(m: Material | null, visual: Visual): THREE.Material | null {
    if (!m) return null;
    const key = `${m.id}|${visual}`;
    const hit = this.nodeMatCache.get(key);
    if (hit && hit.code === m.code) return hit.material;
    if (hit) hit.material.dispose();
    if (this.badMaterials.has(`${m.id}|${m.code}`)) return null;
    try {
      this.host ??= hostForObjects((id) => this.textures.get(id));
      const built = this.lit(buildMaterial(m.code, this.host));
      if (visual !== 'normal') {
        const glow = tslColor(ACCENT).mul(visual === 'editing' ? 0.25 : 0.45);
        built.emissiveNode = built.emissiveNode ? (built.emissiveNode as ReturnType<typeof tslColor>).add(glow) : glow;
      }
      this.nodeMatCache.set(key, { code: m.code, material: built });
      return built;
    } catch (e) {
      console.warn(`material "${m.name}" failed to build:`, e);
      this.badMaterials.add(`${m.id}|${m.code}`);
      return null;
    }
  }

  private disposeGroup(group: THREE.Group): void {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !m.userData.cached && m.geometry !== this.squareGeo && m.geometry !== this.circleGeo) m.geometry.dispose();
      if (m.material && !m.userData.cachedMaterial && !(m.material instanceof THREE.MeshStandardMaterial)) (m.material as THREE.Material).dispose();
    });
    group.clear();
  }

  // -- cameras -----------------------------------------------------------------

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.width = w;
    this.height = h;
    this.persp.aspect = w / h;
    this.persp.fov = verticalFov(this.activeSettings(), this.persp.aspect);
    this.persp.updateProjectionMatrix();
    this.ortho.left = -w / 2; this.ortho.right = w / 2; this.ortho.top = h / 2; this.ortho.bottom = -h / 2;
    this.ortho.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.needsFrame = true;
  }

  private rememberPose(into: { position: THREE.Vector3; target: THREE.Vector3; quaternion: THREE.Quaternion }): void {
    into.position.copy(this.camera.position); into.target.copy(this.controls.target); into.quaternion.copy(this.camera.quaternion);
  }

  /** How far the camera moved since `since`, in screen pixels: position and target over the pixel size at the target, the turn over the focal length. */
  private cameraMotionPx(since: { position: THREE.Vector3; target: THREE.Vector3; quaternion: THREE.Quaternion }): number {
    const wpp = Math.max(1e-9, this.worldPerPixel(this.controls.target));
    const travel = (this.camera.position.distanceTo(since.position) + this.controls.target.distanceTo(since.target)) / wpp;
    const focalPx = this.camera === this.persp ? (this.height / 2) / Math.tan((this.persp.fov * Math.PI) / 360) : this.height;
    return travel + this.camera.quaternion.angleTo(since.quaternion) * focalPx;
  }

  /** Ask for a frame (docs/32-render-on-demand.md) — the loop draws one on its next tick. */
  invalidate(): void { this.needsFrame = true; }

  /** the pixel ratio the canvas is drawn at right now: the full one, or half of it while interacting */
  get pixelRatioNow(): number { return this.ratioNow; }

  private touch(interactive = false): void {
    this.needsFrame = true;
    if (interactive) this.interactUntil = performance.now() + 150;
  }

  private setRatio(r: number): void {
    if (r === this.ratioNow) return;
    this.ratioNow = r;
    this.renderer.setPixelRatio(r);   // re-sizes the drawing buffer; the pass nodes follow it on the next render
    this.needsFrame = true;
  }

  private useCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    if (this.camera === cam) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const up = this.camera.up.clone();
    this.camera = cam;
    this.applyLook();
    this.controls.object = cam;
    this.gizmo.camera = cam;
    cam.up.copy(up);
    cam.position.copy(this.controls.target).addScaledVector(dir, cam === this.persp ? 3500 : 20_000);
    cam.lookAt(this.controls.target);
    this.controls.update();
  }

  private onModeChange(kind: 'object' | 'edit' | 'post'): void {
    if (kind === 'edit') {
      this.planeTool = null; this.filletFirst = null; this.toolMessage = '';
      this.clearToolPreview();
      this.onToolChange();
      // a fresh curve (< 2 points) starts in the add-points tool, an existing one with the gizmo
      const c = this.store.editingCurve();
      this.editTool = c && c.curve.points.length < 2 ? 'add' : 'select';
      this.useCamera(this.ortho);
      this.alignToPlane(true);
    } else {
      this.editTool = 'select';
      this.useCamera(this.wantedCamera());
    }
    this.onUiChange();
  }

  private animateTo(pos1: THREE.Vector3, up1: THREE.Vector3): void {
    this.anim = { pos0: this.camera.position.clone(), pos1, up0: this.camera.up.clone(), up1, t0: performance.now() };
  }

  /** Look straight at the active plane (orthographic in Edit mode). */
  alignToPlane(animate = true): void {
    const plane = this.store.activePlane();
    if (!plane) return;
    const frame = this.frameOf(plane);
    const active = this.store.activeCurve();
    const pts = active && active.curve.points.length ? active.curve.points : this.store.project.curves.filter((c) => c.planeId === plane.id).flatMap((c) => c.curve.points);
    const b = curveBounds(pts);
    const target = fromPlane(frame, b.center);
    this.controls.target.copy(target);
    if (this.camera === this.ortho) {
      const bw = Math.max(400, b.max.x - b.min.x + 300), bh = Math.max(400, b.max.y - b.min.y + 300);
      this.ortho.zoom = Math.min(this.width / bw, this.height / bh);
      this.ortho.updateProjectionMatrix();
    }
    const dist = this.camera === this.ortho ? 20_000 : Math.max(1500, this.camera.position.distanceTo(target));
    const pos = target.clone().addScaledVector(frame.normal, dist);
    if (animate) this.animateTo(pos, frame.y.clone());
    else { this.camera.position.copy(pos); this.camera.up.copy(frame.y); this.camera.lookAt(target); }
  }

  /**
   * Drag on the navigation cube = pull the view around like a ball
   * (docs/21-navcube-drag.md): the same orbit as a drag in the viewport, at the
   * cube's scale — across the cube is half a turn.
   */
  private spinCube(m: Vec2): void {
    const d = this.cubeDrag;
    if (!d) return;
    const dx = m.x - d.last.x, dy = m.y - d.last.y;
    d.last = m;
    if (!dx && !dy) return;
    if (this.down && Math.hypot(m.x - this.down.x, m.y - this.down.y) > 4) d.moved = true;
    this.anim = null;                                   // a spin overrides a running snap
    this.navcube.setHover(null);
    this.renderer.domElement.style.cursor = 'grabbing';
    const r = this.navcube.rect(this.width);
    // the camera's offset from the target, in the frame where its own up is +Y (OrbitControls does the same)
    const q = new THREE.Quaternion().setFromUnitVectors(this.camera.up.clone().normalize(), new THREE.Vector3(0, 1, 0));
    const offset = this.camera.position.clone().sub(this.controls.target).applyQuaternion(q);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta -= (dx / r.w) * Math.PI;
    sph.phi -= (dy / r.h) * Math.PI;
    sph.phi = Math.max(1e-4, Math.min(Math.PI - 1e-4, sph.phi));
    offset.setFromSpherical(sph).applyQuaternion(q.invert());
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  /** Snap the view to a direction (navigation cube). */
  lookFrom(dir: THREE.Vector3, up: THREE.Vector3): void {
    const target = this.controls.target;
    const dist = this.camera === this.ortho ? 20_000 : this.camera.position.distanceTo(target);
    this.animateTo(target.clone().addScaledVector(dir, dist), up.clone());
  }

  /** Frame everything (Object mode) or the active plane (Edit mode). */
  fit(): void {
    if (this.store.mode.kind === 'edit') { this.alignToPlane(true); return; }
    this.frameBox(new THREE.Box3().setFromObject(this.content), new THREE.Vector3(0, 1, 0));
  }

  /**
   * Put the orbit pivot on the box centre and zoom to its extents, keeping the
   * view direction (Blender's numpad `.`) — docs/20-viewport-status-bar.md.
   */
  private frameBox(box: THREE.Box3, up?: THREE.Vector3): void {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    // the up we frame with: the asked-for one unless it looks along the view, then the camera's
    let upv = (up ?? this.camera.up).clone().normalize();
    if (Math.abs(upv.dot(dir)) > 0.999) upv = this.camera.up.clone().normalize();
    if (Math.abs(upv.dot(dir)) > 0.999) upv = new THREE.Vector3(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(upv, dir).normalize();
    const camUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    // half extents of the box in view space, and how far it reaches towards the camera
    let hw = 0, hh = 0, depth = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      hw = Math.max(hw, Math.abs(v.dot(right)));
      hh = Math.max(hh, Math.abs(v.dot(camUp)));
      depth = Math.max(depth, Math.abs(v.dot(dir)));
    }
    // a point (a lone vertex, an empty object) still gets a sensible frame
    const w = Math.max(200, hw * 2) * 1.15, h = Math.max(200, hh * 2) * 1.15;
    this.controls.target.copy(center);
    let dist: number;
    if (this.camera === this.ortho) {
      this.ortho.zoom = Math.min(this.width / w, this.height / h);
      this.ortho.updateProjectionMatrix();
      dist = 20_000 + depth;
    } else {
      const vfov = (this.persp.fov * Math.PI) / 360;
      const hfov = Math.atan(Math.tan(vfov) * this.persp.aspect);
      dist = Math.max(h / 2 / Math.tan(vfov), w / 2 / Math.tan(hfov)) + depth;
    }
    this.animateTo(center.clone().addScaledVector(dir, dist), upv);
  }

  /** World bounds of the scene objects whose userData the predicate accepts (array instances included). */
  private boxOfContent(match: (u: Record<string, unknown>) => boolean): THREE.Box3 {
    const box = new THREE.Box3();
    this.content.traverse((o) => {
      const m = o as THREE.Object3D & { isMesh?: boolean; isLine?: boolean };
      if ((!m.isMesh && !m.isLine) || !match(m.userData)) return;
      box.expandByObject(m);
    });
    return box;
  }

  /** World bounds of the vertices of the given curves — the fallback when nothing is built (a hidden subtree). */
  private boxOfCurveIds(ids: Set<Id>): THREE.Box3 {
    const box = new THREE.Box3();
    for (const c of this.store.project.curves) {
      if (!ids.has(c.id)) continue;
      const f = this.frameOfCurve(c);
      for (const v of c.curve.points) box.expandByPoint(fromPlane(f, v));
    }
    return box;
  }

  /** Everything drawn on one plane: its curves and the reference image traced under them. */
  private planeBox(planeId: Id): THREE.Box3 {
    const ids = new Set(this.store.project.curves.filter((c) => c.planeId === planeId).map((c) => c.id));
    const box = this.boxOfContent((u) => (typeof u.curveId === 'string' && ids.has(u.curveId)) || u.planeImage === planeId);
    if (box.isEmpty()) box.union(this.boxOfCurveIds(ids));
    if (box.isEmpty()) {
      const plane = this.store.project.planes.find((p) => p.id === planeId);
      if (plane) box.expandByPoint(this.frameOf(plane).origin);
    }
    return box;
  }

  /** Frame everything on the active plane (docs/20-viewport-status-bar.md). */
  framePlane(): void {
    const plane = this.store.activePlane();
    if (!plane) { this.fit(); return; }
    this.frameBox(this.planeBox(plane.id));
  }

  /** Frame the selection — the selected vertices in Edit mode; everything when nothing is selected. */
  frameSelection(): void {
    const { mode, selection, project } = this.store.state;
    if (mode.kind === 'edit') {
      const c = this.store.editingCurve();
      if (!c || !this.frame) return;
      const sel = c.curve.points.filter((v) => selection.vertices.includes(v.id));
      const pts = sel.length ? sel : c.curve.points;
      if (!pts.length) return;
      const box = new THREE.Box3();
      for (const v of pts) box.expandByPoint(fromPlane(this.frame, v));
      this.frameBox(box);
      return;
    }
    let box: THREE.Box3 | null = null;
    if (selection.groups.length) {
      const planes = this.planesOfGroups(selection.groups);
      const curves = new Set(project.curves.filter((c) => planes.has(c.planeId)).map((c) => c.id));
      const lofts = new Set(project.lofts.filter((l) => curves.has(l.a) && curves.has(l.b)).map((l) => l.id));
      const shapes = new Set(project.shapes.filter((sh) => sh.curves.some((id) => curves.has(id))).map((sh) => sh.id));
      box = this.boxOfContent((u) => (typeof u.curveId === 'string' && curves.has(u.curveId)) || (typeof u.loftId === 'string' && lofts.has(u.loftId)) || (typeof u.shapeId === 'string' && shapes.has(u.shapeId)) || (typeof u.planeImage === 'string' && planes.has(u.planeImage)));
      // hidden objects are not built: fall back to their curves, then to the object's own place
      if (box.isEmpty()) box.union(this.boxOfCurveIds(curves));
      if (box.isEmpty()) box.expandByPoint(this.groupVertices(selection.groups).pivot);
    } else if (selection.planes.length) {
      box = new THREE.Box3();
      for (const id of selection.planes) box.union(this.planeBox(id));
    } else if (selection.lofts.length) {
      box = this.boxOfContent((u) => selection.lofts.includes(u.loftId as string));
    } else if (selection.shapes.length) {
      box = this.boxOfContent((u) => selection.shapes.includes(u.shapeId as string));
    } else if (selection.curves.length) {
      const curves = new Set(selection.curves);
      box = this.boxOfContent((u) => typeof u.curveId === 'string' && curves.has(u.curveId));
      if (box.isEmpty()) box.union(this.boxOfCurveIds(curves));
    } else if (selection.cameraId) {
      const cam = project.cameras.find((c) => c.id === selection.cameraId);
      if (cam) box = new THREE.Box3().expandByPoint(new THREE.Vector3(cam.pose.position.x, cam.pose.position.y, cam.pose.position.z));
    }
    if (box && !box.isEmpty()) this.frameBox(box); else this.fit();
  }

  private frameLoop(): void {
    const now = performance.now();
    if (this.anim) {
      const k = Math.min(1, (now - this.anim.t0) / 260);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.camera.position.lerpVectors(this.anim.pos0, this.anim.pos1, e);
      this.camera.up.lerpVectors(this.anim.up0, this.anim.up1, e).normalize();
      this.camera.lookAt(this.controls.target);
      if (k >= 1) this.anim = null;
      this.touch(true);
    }
    this.controls.update();
    // The camera's motion, in screen pixels. The controls' damping tail eases the camera for seconds at sub-pixel
    // speeds — that is neither interaction nor worth a frame: ≥ 2 px in one tick is a gesture (half the pixels),
    // ≥ 0.5 px since the last drawn frame earns a sharp frame, less is ignored (the drift is drawn with the next frame).
    const speed = this.cameraMotionPx(this.tickPose);
    this.rememberPose(this.tickPose);
    if (speed >= 2) this.touch(true);
    if (this.cameraMotionPx(this.drawnPose) >= 0.5) this.needsFrame = true;
    this.writePose();
    this.tickPixels(now);
    // frames on demand (docs/32-render-on-demand.md): half the pixels while interacting, one sharp frame after,
    // and nothing at all when nothing asked
    this.setRatio(now < this.interactUntil ? Math.max(0.5, this.ratioFull / 2) : this.ratioFull);
    if (!this.needsFrame) return;
    this.needsFrame = false;
    this.renderCount++;
    this.rememberPose(this.drawnPose);
    this.sampleFps(now);

    for (const b of this.billboards) {
      const idx = b.mesh.userData.pointIndex as number | undefined;
      const px = idx !== undefined && idx === this.hoverPoint ? b.px + 3 : b.px;
      const wpp = this.worldPerPixel(b.mesh.position);
      b.mesh.scale.set(px * wpp * b.aspect, px * wpp, 1);
      b.mesh.quaternion.copy(this.camera.quaternion);
      if (b.diamond) b.mesh.rotateZ(Math.PI / 4);
    }

    const r = this.renderer;
    r.setViewport(0, 0, this.width, this.height);
    r.setScissorTest(false);
    r.autoClear = true;
    if (this.fx) this.fx.render(); else r.render(this.scene, this.camera);

    this.navcube.sync(this.camera, this.controls.target);
    const c = this.navcube.rect(this.width);
    const vy = this.isWebGPU ? c.y : this.height - c.y - c.h;
    // The cube is drawn straight onto the canvas: with tone mapping / an output colour space set, the renderer
    // would route this render through its internal framebuffer target and blit *that* (stale — the post pipeline
    // draws directly to the canvas) over the frame just rendered, freezing the picture under a live cube.
    const toneMapping = r.toneMapping, colorSpace = r.outputColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.autoClear = false;
    r.clearDepth();
    r.setViewport(c.x, vy, c.w, c.h);
    r.setScissor(c.x, vy, c.w, c.h);
    r.setScissorTest(true);
    r.render(this.navcube.scene, this.navcube.camera);
    r.setScissorTest(false);
    r.autoClear = true;
    r.toneMapping = toneMapping;
    r.outputColorSpace = colorSpace;
  }

  /** The camera looked through — always a camera object (docs/15-camera.md, docs/36-camera-world.md). */
  private activeSettings(): CameraSettings {
    return activeCameraOf(this.store.project);
  }

  /**
   * Perspective / orthographic (the cube's dropdown). Orthographic is a detour for whichever camera is looked through:
   * its pose is not written while it lasts, and perspective returns the view to the camera's pose (docs/36 §1).
   */
  setProjection(p: 'perspective' | 'orthographic'): void {
    if (p === this.projection) return;
    this.projection = p;
    if (this.store.mode.kind === 'object') {
      if (p === 'perspective') this.appliedCameraId = undefined;   // back to the camera's pose (followCamera)
      else this.useCamera(this.wantedCamera());
    }
    this.onUiChange();
  }

  private wantedCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (this.store.mode.kind === 'edit') return this.ortho;
    return this.projection === 'orthographic' ? this.ortho : this.persp;
  }

  /** Looking through a camera object: move the view to its pose when it becomes active; write the view back while it is. */
  private followCamera(): void {
    const { activeCamera } = this.store.project;
    if (activeCamera !== this.appliedCameraId) {
      this.appliedCameraId = activeCamera;
      const cam = activeCameraOf(this.store.project);
      if (this.store.mode.kind === 'object') {
        this.useCamera(this.wantedCamera());
        this.controls.target.set(cam.pose.target.x, cam.pose.target.y, cam.pose.target.z);
        if (this.camera === this.persp) this.animateTo(new THREE.Vector3(cam.pose.position.x, cam.pose.position.y, cam.pose.position.z), new THREE.Vector3(0, 1, 0));
        else {
          // orthographic: stand far out along the camera's view direction, the pose itself untouched
          const dir = new THREE.Vector3(cam.pose.position.x - cam.pose.target.x, cam.pose.position.y - cam.pose.target.y, cam.pose.position.z - cam.pose.target.z).normalize();
          this.animateTo(this.controls.target.clone().addScaledVector(dir, 20_000), new THREE.Vector3(0, 1, 0));
        }
      }
    }
  }

  /** Called every frame: while a camera object is active, its pose follows the view — written once the view has been still for a moment (no undo step). */
  private writePose(): void {
    const id = this.store.project.activeCamera;
    if (!id || this.anim || this.camera !== this.persp) return;
    const cam = this.store.project.cameras.find((c) => c.id === id);
    if (!cam) return;
    const p = this.camera.position, t = this.controls.target;
    const same = (a: Vec3, b: THREE.Vector3) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.z - b.z) < 0.5;
    const now = performance.now();
    if (!same(this.lastPose.position, p) || !same(this.lastPose.target, t)) {
      // still moving (or damping): remember, wait
      this.lastPose = { position: { x: p.x, y: p.y, z: p.z }, target: { x: t.x, y: t.y, z: t.z } };
      this.stillSince = now;
      return;
    }
    if (now - this.stillSince < 300) return;
    if (same(cam.pose.position, p) && same(cam.pose.target, t)) return;
    cmd.setCameraPose(this.store, id, { position: { x: p.x, y: p.y, z: p.z }, target: { x: t.x, y: t.y, z: t.z } });
  }

  /** Blender's passepartout: the film-back frame outlined, the rest darkened — perspective view only. */
  private applyFrame(): void {
    const camera = this.activeSettings();
    const on = camera.frame.show && this.camera === this.persp;
    this.frameEl.style.display = on ? 'block' : 'none';
    if (!on) return;
    const r = frameRect(camera, this.width, this.height);
    Object.assign(this.frameEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, boxShadow: `0 0 0 9999px rgba(0, 0, 0, ${Math.max(0, Math.min(1, camera.frame.passepartout))})` });
  }

  /** Apply the project's camera (field of view) and post script; rebuilds the pipeline only when they changed. */
  /** Preview a draft post script (null = the project's); returns the script error, if any. */
  setPostPreview(draft: PostProgram | null): string | null {
    this.postPreview = draft ? JSON.parse(JSON.stringify(draft)) as PostProgram : null;
    this.applyLook();
    return this.postError;
  }

  private applyLook(): void {
    this.needsFrame = true;
    this.followCamera();
    this.applyFrame();
    const { project } = this.store.state;
    const camera = this.activeSettings();
    // the world: the active camera's (docs/36); edit mode keeps a neutral fixed look
    this.world.apply(this.activeWorld(), project.textures);
    const post = this.postPreview ?? project.post;
    const fov = verticalFov(camera, this.persp.aspect);
    if (Math.abs(fov - this.persp.fov) > 1e-6) { this.persp.fov = fov; this.persp.updateProjectionMatrix(); }
    // only what the pipeline bakes in — not the pose (it changes with every navigation while a camera is looked through)
    const key = JSON.stringify([post, camera.filmBack, camera.focalLength, camera.dof, this.camera === this.persp]);
    if (key === this.fxKey) return;
    this.fxKey = key;
    this.fx?.dispose();
    this.fx = null;
    this.postError = null;
    // The plain render (script off) still goes through a pipeline: the scene pass and the view transform only. A direct
    // renderer.render with tone mapping set presents a black frame here (the internal framebuffer path + the cube overlay).
    if (!post.enabled) { this.fx = fallbackEffects(this.renderer, this.scene, this.camera); return; }
    try { this.fx = createEffects(this.renderer, this.scene, this.camera, post, camera); }
    catch (e) {
      this.postError = e instanceof Error ? e.message : String(e);
      console.warn(`post script "${post.label}" failed — showing the plain image:`, e);
      this.fx = fallbackEffects(this.renderer, this.scene, this.camera);
    }
  }

  /**
   * A still at full quality (docs/32-render-on-demand.md §1.3): the camera's frame (film-back aspect, its own field of
   * view, no passepartout) — or the viewport's aspect while the view is orthographic — `width` px wide, through the
   * post script, without the helpers. Resizes the canvas for one frame and restores it. Returns a PNG data URL.
   */
  renderStill(opts: { width?: number } = {}): { url: string; width: number; height: number; name: string } {
    const { project } = this.store.state;
    const cam = activeCameraOf(project);
    const settings = this.activeSettings();
    const looked = this.camera === this.persp ? settings : null;
    const { width, height } = stillSize(looked, this.width / Math.max(1, this.height), opts.width);
    const r = this.renderer;
    const persp = this.persp;
    const saved = { aspect: persp.aspect, fov: persp.fov, ratio: this.ratioNow, helpers: this.helpers.visible, tool: this.toolGroup.visible, floor: this.floor.visible };
    const gizmoHelper = (this.gizmo.controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper?.() ?? null;
    const gizmoVisible = gizmoHelper?.visible ?? true;
    try {
      this.helpers.visible = false; this.toolGroup.visible = false; this.floor.visible = false;
      if (gizmoHelper) gizmoHelper.visible = false;
      persp.aspect = width / height;
      persp.fov = looked ? cameraFov(looked).vertical : verticalFov(settings, persp.aspect);
      persp.updateProjectionMatrix();
      r.setPixelRatio(1);
      r.setSize(width, height, false);
      r.setViewport(0, 0, width, height);
      r.setScissorTest(false);
      r.autoClear = true;
      if (this.fx) this.fx.render(); else r.render(this.scene, this.camera);
      const url = r.domElement.toDataURL('image/png');
      const name = `${project.name || 'deco'} · ${cam.name} ${width}×${height}.png`;
      return { url, width, height, name };
    } finally {
      this.helpers.visible = saved.helpers; this.toolGroup.visible = saved.tool; this.floor.visible = saved.floor;
      if (gizmoHelper) gizmoHelper.visible = gizmoVisible;
      persp.aspect = saved.aspect; persp.fov = saved.fov; persp.updateProjectionMatrix();
      this.ratioNow = saved.ratio;
      r.setPixelRatio(saved.ratio);
      r.setSize(this.width, this.height, false);
      this.needsFrame = true;
    }
  }

  /** Render a still and download it (the ⧉ button on the viewport rail). */
  saveStill(width?: number): void {
    const { url, name } = this.renderStill({ width });
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /**
   * A square PNG of one object for the archive (docs/33-object-archive.md §4): the rest of the scene and the helpers
   * hidden, framed from front-right-above with the world background kept, `size` px, no post. Restores the view.
   * Null when the object has nothing to show.
   */
  renderThumbnail(groupId: Id | null, size = 512): string | null {
    const { project } = this.store.state;
    // null = everything (the export of the whole file, docs/33 §13)
    const planes = groupId === null ? new Set(project.planes.map((p) => p.id)) : this.planesOfGroups([groupId]);
    const curves = new Set(project.curves.filter((c) => planes.has(c.planeId)).map((c) => c.id));
    const lofts = new Set(project.lofts.filter((l) => curves.has(l.a) && curves.has(l.b)).map((l) => l.id));
    const shapes = new Set(project.shapes.filter((sh) => sh.curves.some((id) => curves.has(id))).map((sh) => sh.id));
    const match = (u: Record<string, unknown>) => (typeof u.curveId === 'string' && curves.has(u.curveId)) || (typeof u.loftId === 'string' && lofts.has(u.loftId)) || (typeof u.shapeId === 'string' && shapes.has(u.shapeId)) || (typeof u.planeImage === 'string' && planes.has(u.planeImage));
    let box = this.boxOfContent(match);
    if (box.isEmpty()) box = this.boxOfCurveIds(curves);
    if (box.isEmpty()) return null;
    const r = this.renderer, persp = this.persp;
    const saved = { pos: persp.position.clone(), quat: persp.quaternion.clone(), up: persp.up.clone(), aspect: persp.aspect, fov: persp.fov, ratio: this.ratioNow, helpers: this.helpers.visible, tool: this.toolGroup.visible, floor: this.floor.visible };
    const gizmoHelper = (this.gizmo.controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper?.() ?? null;
    const gizmoVisible = gizmoHelper?.visible ?? true;
    const hidden: THREE.Object3D[] = [];
    try {
      this.helpers.visible = false; this.toolGroup.visible = false; this.floor.visible = false;
      if (gizmoHelper) gizmoHelper.visible = false;
      this.content.traverse((o) => {
        const m = o as THREE.Object3D & { isMesh?: boolean; isLine?: boolean };
        if ((m.isMesh || m.isLine) && m.visible && !match(m.userData)) { m.visible = false; hidden.push(m); }
      });
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(100, box.getSize(new THREE.Vector3()).length() / 2);
      const fov = 30;
      const dist = (radius / Math.sin((fov / 2) * Math.PI / 180)) * 1.05;
      persp.aspect = 1; persp.fov = fov; persp.updateProjectionMatrix();
      persp.up.set(0, 1, 0);
      persp.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.7, 1).normalize(), dist);
      persp.lookAt(center);
      persp.updateMatrixWorld();
      r.setPixelRatio(1);
      r.setSize(size, size, false);
      r.setViewport(0, 0, size, size);
      r.setScissorTest(false);
      r.autoClear = true;
      r.render(this.scene, persp);
      return r.domElement.toDataURL('image/png');
    } finally {
      for (const m of hidden) m.visible = true;
      this.helpers.visible = saved.helpers; this.toolGroup.visible = saved.tool; this.floor.visible = saved.floor;
      if (gizmoHelper) gizmoHelper.visible = gizmoVisible;
      persp.position.copy(saved.pos); persp.quaternion.copy(saved.quat); persp.up.copy(saved.up);
      persp.aspect = saved.aspect; persp.fov = saved.fov; persp.updateProjectionMatrix();
      this.ratioNow = saved.ratio;
      r.setPixelRatio(saved.ratio);
      r.setSize(this.width, this.height, false);
      this.needsFrame = true;
    }
  }

  // -- for the camera page (docs/15-camera.md) ------------------------------------------

  viewInfo(): { position: Vec3; target: Vec3; fov: number; aspect: number } {
    const p = this.camera.position, t = this.controls.target;
    return { position: { x: p.x, y: p.y, z: p.z }, target: { x: t.x, y: t.y, z: t.z }, fov: this.persp.fov, aspect: this.persp.aspect };
  }

  setView(position: Vec3, target: Vec3): void {
    this.controls.target.set(target.x, target.y, target.z);
    this.animateTo(new THREE.Vector3(position.x, position.y, position.z), new THREE.Vector3(0, 1, 0));
  }

  /** Distance from the camera to the centre of the selection (or of everything), mm — for the focus distance. */
  selectionDistance(): number | null {
    const { selection } = this.store;
    const box = new THREE.Box3();
    const ids = new Set(selection.curves);
    this.content.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mine = ids.size ? ids.has(m.userData.curveId as string) : selection.loftId ? m.userData.loftId === selection.loftId : selection.shapeId ? m.userData.shapeId === selection.shapeId : true;
      if (mine) box.expandByObject(m);
    });
    if (box.isEmpty()) return null;
    return this.camera.position.distanceTo(box.getCenter(new THREE.Vector3()));
  }

  private worldPerPixel(at: THREE.Vector3): number {
    if (this.camera === this.ortho) return 1 / this.ortho.zoom;
    const dist = this.camera.position.distanceTo(at);
    return (dist * 2 * Math.tan((this.persp.fov * Math.PI) / 360)) / this.height;
  }

  // -- picking -----------------------------------------------------------------

  private local(e: MouseEvent): Vec2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setRay(m: Vec2): void {
    this.raycaster.setFromCamera(new THREE.Vector2((m.x / this.width) * 2 - 1, -(m.y / this.height) * 2 + 1), this.camera);
  }

  private toScreen(v: THREE.Vector3): Vec2 {
    const p = v.clone().project(this.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  private dist(m: Vec2, v: THREE.Vector3): number {
    const s = this.toScreen(v);
    return Math.hypot(s.x - m.x, s.y - m.y);
  }

  private nearest(points: THREE.Vector3[], m: Vec2, maxPx: number): number | null {
    let best = -1, bestD = maxPx * maxPx;
    points.forEach((v, i) => {
      const s = this.toScreen(v);
      const d = (s.x - m.x) ** 2 + (s.y - m.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best < 0 ? null : best;
  }

  /** Pointer ray ∩ the plane (or the parallel plane at normal offset `z` — where a raised vertex lives). */
  private planeHit(m: Vec2, frame: PlaneFrame, z = 0): THREE.Vector3 | null {
    this.setRay(m);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(z ? offsetPlane(frame, z) : frame.plane, out) ? out : null;
  }

  /** What a click at `m` would select under the current filter. */
  private pickTarget(m: Vec2): PickTarget | null {
    return resolvePick(this.store.project, this.pickFilter, this.pick(m));
  }

  private pick(m: Vec2): PickHit {
    this.setRay(m);
    this.raycaster.params.Line.threshold = 15;
    for (const hit of this.raycaster.intersectObjects(this.content.children, true)) {
      const curveId = hit.object.userData.curveId as Id | undefined;
      if (curveId) return { curveId, loftId: null };
      const loftId = hit.object.userData.loftId as Id | undefined;
      if (loftId) return { curveId: null, loftId };
      const shapeId = hit.object.userData.shapeId as Id | undefined;
      if (shapeId) return { curveId: null, loftId: null, shapeId };
    }
    return { curveId: null, loftId: null };
  }

  /** Every vertex of every curve projected onto the edit plane (alignment snap sources). */
  private collectSnapCandidates(frame: PlaneFrame, exclude: Set<Id>): Vec2[] {
    const out: Vec2[] = [];
    const editing = this.store.editingCurve();
    for (const c of this.store.project.curves) {
      const f = editing && c.planeId === editing.planeId ? frame : this.frameOfCurve(c);
      for (const v of c.curve.points) {
        if (exclude.has(v.id)) continue;
        out.push(f === frame ? { x: v.x, y: v.y } : toPlane(frame, fromPlane(f, v)));
      }
    }
    return out;
  }

  /** Alignment snap (pink guides) then grid snap; Shift disables both. */
  private snapDrag(p: Vec2, e: MouseEvent, own: Vec2[] = []): Vec2 {
    if (e.shiftKey) { this.guides = []; return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }; }
    const tol = 8 * this.worldPerPixel(this.frame ? fromPlane(this.frame, p) : this.controls.target);
    let point = { ...p };
    this.guides = [];
    if (this.store.state.alignSnap) {
      const r = alignSnap(p, [...this.snapCandidates, ...own], tol);
      point = r.point;
      this.guides = r.guides;
    }
    if (this.store.state.snap) {
      if (!this.guides.some((g) => g.axis === 'v')) point.x = Math.round(point.x / GRID) * GRID;
      if (!this.guides.some((g) => g.axis === 'h')) point.y = Math.round(point.y / GRID) * GRID;
    }
    this.guideAnchor = point;
    return point;
  }

  // -- interaction ---------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const m = this.local(e);
    this.down = m;
    this.renderer.domElement.focus();
    if (this.navcube.contains(this.width, m.x, m.y)) {
      if (e.button === 0) { this.cubeDrag = { last: m, moved: false }; this.renderer.domElement.setPointerCapture(e.pointerId); }
      return;
    }
    if (e.button !== 0) return;
    if (this.gizmo.axis) return; // the gizmo takes this drag
    // Shift+left = orbit, ⌘/Ctrl+left = pan: hand the press to OrbitControls (it swaps rotate ⇄ pan when a
    // modifier is held, hence the crossed mapping) and treat a press without movement as a Shift-click.
    const LEFT = this.controls.mouseButtons as { LEFT: THREE.MOUSE | null };
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      LEFT.LEFT = e.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      this.navClick = { shift: e.shiftKey && !e.metaKey && !e.ctrlKey };
      return;
    }
    LEFT.LEFT = null;
    const capture = () => this.renderer.domElement.setPointerCapture(e.pointerId);

    // "Set scale…" (docs/19-reference-image.md): two clicks on the image, then the distance in mm
    if (this.imageCalibrate) { this.calibrateClick(m); this.drag = { kind: 'none', moved: true }; return; }

    if (this.store.mode.kind === 'edit') {
      const c = this.store.editingCurve();
      if (!c || !this.frame) return;
      const pi0 = this.nearest(this.pointsWorld, m, 10);
      if (this.handlesWorld && this.store.primaryVertex) {
        const hi = this.nearest([this.handlesWorld.in, this.handlesWorld.out], m, 10);
        const handleCloser = hi !== null && (pi0 === null || this.dist(m, hi === 0 ? this.handlesWorld.in : this.handlesWorld.out) < this.dist(m, this.pointsWorld[pi0]));
        if (hi !== null && handleCloser) {
          this.snapCandidates = this.collectSnapCandidates(this.frame, new Set());
          this.drag = { kind: 'handle', id: c.id, vid: this.store.primaryVertex, which: hi === 0 ? 'in' : 'out', moved: false };
          capture();
          return;
        }
      }
      if (pi0 !== null) {
        const vid = this.pointIds[pi0];
        if (!this.store.selection.vertices.includes(vid)) cmd.selectVertex(this.store, c.id, vid);
        if (e.altKey && c.type === 'spatial') this.startZDrag(c, vid, this.pointsWorld[pi0]);
        else this.startVertexDrag(c, vid);
        capture();
        return;
      }
      // add-points tool: click on the curve inserts a vertex there, click on the plane appends one
      const si = this.editTool === 'add' ? this.nearest(this.samplesWorld, m, 8) : null;
      if (si !== null) {
        const ev = this.store.evals.get(c.id)!;
        const vid = cmd.insertVertexAt(this.store, c.id, ev.sampling.samples[si].s);
        if (vid) { this.startVertexDrag(this.store.editingCurve()!, vid); capture(); }
        return;
      }
      // a new vertex of a 3D curve continues at the previous vertex's normal offset
      const lastZ = c.type === 'spatial' && c.curve.points.length ? c.curve.points[c.curve.points.length - 1].z : 0;
      const hit = this.editTool === 'add' ? this.planeHit(m, this.frame, lastZ) : null;
      this.drag = { kind: 'box', additive: e.altKey, addAt: hit ? { ...this.snapDrag(toPlane(this.frame, hit), e), z: lastZ } : null, moved: false };
      this.guides = [];
      capture();
      return;
    }

    // object mode: the filter decides which level the hit selects (docs/08-selection-filter.md)
    if (this.planeTool) { this.toolPress(m, e); return; }
    if (this.focusTool) { this.focusAt(m); this.drag = { kind: 'none', moved: true }; return; }
    // an array handle wins the click: the gizmo moves onto it (docs/26-array.md §3)
    const ah = this.nearest(this.arrayHandles, m, ARRAY_HANDLE_PX + 4);
    if (ah !== null) { cmd.selectArrayHandle(this.store, this.arrayHandleKinds[ah]); this.drag = { kind: 'none', moved: true }; return; }
    if (this.store.selection.arrayHandle) cmd.selectArrayHandle(this.store, null);
    // an unlocked reference image: its corner handles win the click, its body only loses to a curve
    const grab = this.imageGrab(m);
    if (grab?.kind === 'corner' && this.startImageScale(m, grab.index)) { capture(); return; }
    const target = this.pickTarget(m);
    if (target?.kind === 'loft') { cmd.selectLoft(this.store, target.id); this.drag = { kind: 'none', moved: true }; return; }
    if (target?.kind === 'shape') { cmd.selectShape(this.store, target.id); this.drag = { kind: 'none', moved: true }; return; }
    if (target?.kind === 'object' && !target.curveId) { cmd.selectGroup(this.store, target.id, e.shiftKey); this.drag = { kind: 'none', moved: true }; return; }
    const id = target ? (target.kind === 'curve' ? target.id : target.curveId) : null;
    if (id && target) {
      const c = this.store.project.curves.find((x) => x.id === id)!;
      if (target.kind === 'plane' && !(this.store.selection.planeSelected && this.store.selection.planeId === target.id)) cmd.selectPlane(this.store, target.id);
      if (target.kind === 'object' && !this.store.selection.groups.includes(target.id)) cmd.selectGroup(this.store, target.id, e.shiftKey);
      const sel = this.store.selection;
      const plane = this.store.planeOf(c);
      const frame = this.frameOf(plane);
      const start = this.planeHit(m, frame);
      // dragging any curve inside a selected object moves the whole selection of objects (docs/18-nested-objects.md §3)
      const chain = groupChain(this.store.project, groupOfPlane(this.store.project, plane.id)?.id ?? null);
      const inSelection = chain.some((g) => sel.groups.includes(g.id));
      if (sel.groups.length && inSelection) {
        const snap = start ? cmd.snapshotGroups(this.store, sel.groups) : null;
        if (start && snap) {
          const { verts, pivot } = this.groupVertices(sel.groups);
          let anchor0: THREE.Vector3 | null = null, bd = Infinity;
          for (const v of verts) { const dd = v.distanceToSquared(start); if (dd < bd) { bd = dd; anchor0 = v; } }
          this.drag = { kind: 'group', groupIds: sel.groups, frame, start, snap, pivot, anchor0, candidates: this.verticesOutsideGroup(sel.groups), moved: false };
          this.controls.enabled = false; capture();
        }
        return;
      }
      if (sel.planeSelected && sel.planeId === c.planeId) {
        if (start) {
          const verts = this.store.project.curves.filter((x) => x.planeId === plane.id).flatMap((x) => x.curve.points.map((v) => fromPlane(frame, v)));
          let anchor0: THREE.Vector3 | null = null, bd = Infinity;
          for (const v of verts) { const dd = v.distanceToSquared(start); if (dd < bd) { bd = dd; anchor0 = v; } }
          this.drag = { kind: 'plane', planeId: c.planeId, frame, start, origin: { ...plane.placement.position }, anchor0, candidates: this.otherVerticesWorld(plane.id), moved: false };
        }
      } else {
        if (!sel.curves.includes(id)) cmd.selectCurve(this.store, id);
        if (start) {
          const ids = this.store.selection.curves.filter((x) => this.store.project.curves.find((y) => y.id === x)?.planeId === plane.id);
          const startLocal = toPlane(frame, start);
          const pts = this.store.project.curves.filter((x) => ids.includes(x.id)).flatMap((x) => x.curve.points);
          this.drag = { kind: 'curves', ids, frame, start: startLocal, originals: cmd.snapshotCurves(this.store, ids), anchor0: this.nearestVec2(pts, startLocal), candidates: this.otherVerticesOnPlane(frame, new Set(ids)), moved: false };
        }
      }
      if (this.drag) { this.controls.enabled = false; capture(); }
      return;
    }
    if (grab?.kind === 'body' && this.startImageMove(m)) { capture(); return; }
    // empty space: box select (Alt adds to the selection)
    this.drag = { kind: 'box', additive: e.altKey, addAt: null, moved: false };
    capture();
  }

  /** Curves with a vertex whose screen projection lies inside the box (Object-mode box select). */
  private curvesInBox(x0: number, y0: number, x1: number, y1: number): Id[] {
    if (!this.pickFilter.curve) return [];
    const out: Id[] = [];
    for (const c of this.store.project.curves) {
      if (!planeVisible(this.store.project, c.planeId)) continue;
      const f = this.frameOfCurve(c);
      if (c.curve.points.some((v) => { const s = this.toScreen(fromPlane(f, v)); return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1; })) out.push(c.id);
    }
    return out;
  }

  /** What the press hits on the active plane's reference image, when it is there and unlocked. */
  private imageGrab(m: Vec2): { kind: 'corner'; index: number } | { kind: 'body' } | null {
    const plane = this.store.activePlane();
    const img = plane?.image;
    if (!plane || !img || !img.visible || img.locked) return null;
    const ci = this.nearest(this.imageCorners, m, IMAGE_CORNER_PX + 4);
    if (ci !== null) return { kind: 'corner', index: ci };
    const frame = this.frameOf(plane);
    const hit = this.planeHit(m, frame, IMAGE_Z);
    if (!hit) return null;
    const q = toPlane(frame, hit);
    const a = -(img.rotation * Math.PI) / 180;
    const dx = q.x - img.center.x, dy = q.y - img.center.y;
    const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(x) <= img.width / 2 && Math.abs(y) <= this.imageHeight(img) / 2 ? { kind: 'body' } : null;
  }

  private imageHeight(img: NonNullable<Plane['image']>): number {
    const t = this.store.project.textures.find((x) => x.id === img.texture);
    return img.width * (t && t.width && t.height ? t.height / t.width : 1);
  }

  /** Drag inside the image: move it. */
  private startImageMove(m: Vec2): boolean {
    const plane = this.store.activePlane();
    if (!plane?.image) return false;
    const frame = this.frameOf(plane);
    const hit = this.planeHit(m, frame, IMAGE_Z);
    if (!hit) return false;
    this.drag = { kind: 'image', planeId: plane.id, frame, start: toPlane(frame, hit), center0: { ...plane.image.center }, moved: false };
    this.controls.enabled = false;
    return true;
  }

  /** Drag a corner: scale about the opposite corner, aspect kept. */
  private startImageScale(m: Vec2, index: number): boolean {
    const plane = this.store.activePlane();
    const corners = plane ? this.imageCornersLocal(plane) : null;
    if (!plane?.image || !corners) return false;
    const frame = this.frameOf(plane);
    const hit = this.planeHit(m, frame, IMAGE_Z);
    if (!hit) return false;
    const anchor = corners[(index + 2) % 4];
    const start = toPlane(frame, hit);
    this.drag = { kind: 'imageScale', planeId: plane.id, frame, anchor, center0: { ...plane.image.center }, width0: plane.image.width, d0: Math.max(1, Math.hypot(start.x - anchor.x, start.y - anchor.y)), moved: false };
    this.controls.enabled = false;
    return true;
  }

  /** Start "Set scale…": the next two clicks measure a distance on the image (docs/19-reference-image.md). */
  startImageCalibration(planeId: Id): void {
    this.imageCalibrate = { planeId, first: null };
    this.onUiChange();
    this.sync();
  }

  cancelImageCalibration(): void {
    if (!this.imageCalibrate) return;
    this.imageCalibrate = null;
    this.onUiChange();
    this.sync();
  }

  /** First click marks a point, the second asks for the real distance and scales the image to it. */
  private calibrateClick(m: Vec2): void {
    const cal = this.imageCalibrate;
    if (!cal) return;
    const plane = this.store.project.planes.find((p) => p.id === cal.planeId);
    const img = plane?.image;
    if (!plane || !img) { this.cancelImageCalibration(); return; }
    const frame = this.frameOf(plane);
    const hit = this.planeHit(m, frame, IMAGE_Z);
    if (!hit) return;
    const q = toPlane(frame, hit);
    if (!cal.first) { cal.first = { x: q.x, y: q.y }; this.sync(); return; }
    const shown = Math.hypot(q.x - cal.first.x, q.y - cal.first.y);
    this.imageCalibrate = null;
    if (shown >= 1) {
      const typed = prompt(`How far apart are those two points, in mm?  (they are ${Math.round(shown)} mm apart now)`, String(Math.round(shown)));
      const mm = typed === null ? NaN : Number(typed.replace(',', '.'));
      if (Number.isFinite(mm) && mm > 0) {
        const k = mm / shown;
        cmd.setPlaneImage(this.store, cal.planeId, {
          width: Math.max(1, img.width * k),
          center: { x: cal.first.x + (img.center.x - cal.first.x) * k, y: cal.first.y + (img.center.y - cal.first.y) * k },
        });
      }
    }
    this.onUiChange();
    this.sync();
  }

  private startVertexDrag(c: CurveObject, vid: Id): void {
    const ids = this.store.selection.vertices.includes(vid) ? this.store.selection.vertices : [vid];
    const originals = new Map<Id, Vec2>();
    for (const v of c.curve.points) if (ids.includes(v.id)) originals.set(v.id, { x: v.x, y: v.y });
    this.snapCandidates = this.collectSnapCandidates(this.frame!, new Set(ids));
    this.drag = { kind: 'vertices', id: c.id, vid, originals, moved: false };
  }

  /** Alt-drag: move the selected vertices along the plane normal; the mouse is read along the normal's screen direction. */
  private startZDrag(c: CurveObject, vid: Id, origin: THREE.Vector3): void {
    const ids = this.store.selection.vertices.includes(vid) ? this.store.selection.vertices : [vid];
    const originals = new Map<Id, number>();
    for (const v of c.curve.points) if (ids.includes(v.id)) originals.set(v.id, v.z);
    const s0 = this.toScreen(origin), s1 = this.toScreen(origin.clone().addScaledVector(this.frame!.normal, 100));
    const dir = { x: (s1.x - s0.x) / 100, y: (s1.y - s0.y) / 100 };   // px per mm
    this.drag = { kind: 'vertexZ', id: c.id, originals, origin, dir: Math.hypot(dir.x, dir.y) > 0.02 ? dir : null, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const m = this.local(e);
    const el = this.renderer.domElement;
    if (this.cubeDrag) { this.spinCube(m); return; }
    if (this.down && Math.hypot(m.x - this.down.x, m.y - this.down.y) > 4 && this.drag) this.drag.moved = true;
    const d = this.drag;

    if (d?.kind === 'offset') {
      // the copy follows the pointer's side and perpendicular distance, on the grid unless Shift
      const c = this.store.project.curves.find((x) => x.id === d.id);
      const ev = this.store.evals.get(d.id);
      const hit = this.planeHit(m, d.frame);
      if (!c || !ev || !hit) return;
      const sd = signedDistance(ev.sampling, toPlane(d.frame, hit));
      if (!sd) return;
      let left = sd.d;
      if (this.store.state.snap && !e.shiftKey) left = Math.round(left / GRID) * GRID;
      const closed = c.curve.closed && c.curve.points.length > 2;
      d.d = Math.round((closed && windingOf(ev.sampling) > 0 ? -left : left) * 100) / 100;
      this.toolValues.offset = d.d;
      this.clearToolPreview();
      this.offsetPreview(d.id, d.d);
      this.onToolChange();
      return;
    }

    if (d?.kind === 'vertices' && this.frame) {
      // drag in the plane parallel to the drawing plane through the grabbed vertex (its z is kept)
      const z0 = this.store.editingCurve()?.curve.points.find((x) => x.id === d.vid)?.z ?? 0;
      const hit = this.planeHit(m, this.frame, z0);
      if (!hit) return;
      const p = this.snapDrag(toPlane(this.frame, hit), e);
      const o = d.originals.get(d.vid)!;
      const delta = { x: p.x - o.x, y: p.y - o.y };
      cmd.moveVertices(this.store, d.id, [...d.originals].map(([vid, q]) => ({ vid, p: { x: q.x + delta.x, y: q.y + delta.y } })), true);
      return;
    }
    if (d?.kind === 'vertexZ' && this.frame && this.down) {
      let dz: number;
      if (d.dir) dz = ((m.x - this.down.x) * d.dir.x + (m.y - this.down.y) * d.dir.y) / (d.dir.x ** 2 + d.dir.y ** 2);
      else dz = -(m.y - this.down.y) * this.worldPerPixel(d.origin);   // normal points at the camera: mouse up = +z
      if (this.store.state.snap && !e.shiftKey) dz = Math.round(dz / GRID) * GRID;
      cmd.offsetVertices(this.store, d.id, d.originals, dz, true);
      return;
    }
    if (d?.kind === 'handle' && this.frame) {
      const c = this.store.editingCurve();
      const v = c?.curve.points.find((x) => x.id === d.vid);
      const hz = v ? v.z + (v.type === 'polygon' ? 0 : v[d.which].z) : 0;
      const hit = this.planeHit(m, this.frame, hz);
      if (hit && v) cmd.moveHandle(this.store, d.id, d.vid, d.which, this.snapDrag(toPlane(this.frame, hit), e, [{ x: v.x, y: v.y }]), true);
      return;
    }
    if (d?.kind === 'box') {
      if (d.moved && this.down) {
        const x = Math.min(this.down.x, m.x), y = Math.min(this.down.y, m.y);
        Object.assign(this.boxEl.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${Math.abs(m.x - this.down.x)}px`, height: `${Math.abs(m.y - this.down.y)}px` });
      }
      return;
    }
    if (d?.kind === 'curves') {
      const hit = this.planeHit(m, d.frame);
      if (hit) {
        const b = toPlane(d.frame, hit);
        let delta = { x: b.x - d.start.x, y: b.y - d.start.y };
        if (d.anchor0) delta = this.snapAnchor2D(d.anchor0, delta, d.candidates, d.frame, { x: true, y: true }, e.shiftKey);
        else delta = cmd.snapGrid(this.store, delta, GRID, e.shiftKey ? false : undefined);
        cmd.transformCurves(this.store, d.originals, translation(delta.x, delta.y), true);
      }
      return;
    }
    if (d?.kind === 'group') {
      const hit = this.planeHit(m, d.frame);
      if (hit) {
        let delta = hit.clone().sub(d.start);
        if (d.anchor0) delta = this.snapAnchor3D(d.anchor0, delta, d.candidates, { x: true, y: true, z: true }, e.shiftKey);
        cmd.transformGroup(this.store, d.snap, { pivot: { x: d.pivot.x, y: d.pivot.y, z: d.pivot.z }, translation: { x: delta.x, y: delta.y, z: delta.z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: 1 }, true);
      }
      return;
    }
    if (d?.kind === 'image') {
      const hit = this.planeHit(m, d.frame, IMAGE_Z);
      if (hit) {
        const q = toPlane(d.frame, hit);
        cmd.setPlaneImage(this.store, d.planeId, { center: { x: d.center0.x + q.x - d.start.x, y: d.center0.y + q.y - d.start.y } }, true);
      }
      return;
    }
    if (d?.kind === 'imageScale') {
      const hit = this.planeHit(m, d.frame, IMAGE_Z);
      if (hit) {
        const q = toPlane(d.frame, hit);
        const k = Math.max(0.02, Math.hypot(q.x - d.anchor.x, q.y - d.anchor.y) / d.d0);
        cmd.setPlaneImage(this.store, d.planeId, {
          width: Math.max(1, d.width0 * k),
          center: { x: d.anchor.x + (d.center0.x - d.anchor.x) * k, y: d.anchor.y + (d.center0.y - d.anchor.y) * k },
        }, true);
      }
      return;
    }
    if (d?.kind === 'plane') {
      const hit = this.planeHit(m, d.frame);
      if (hit) {
        let delta = hit.clone().sub(d.start);
        if (d.anchor0) delta = this.snapAnchor3D(d.anchor0, delta, d.candidates, { x: true, y: true, z: true }, e.shiftKey);
        else {
          const a = toPlane(d.frame, d.start), bb = toPlane(d.frame, hit);
          const g = cmd.snapGrid(this.store, { x: bb.x - a.x, y: bb.y - a.y }, GRID, e.shiftKey ? false : undefined);
          delta = d.frame.x.clone().multiplyScalar(g.x).addScaledVector(d.frame.y, g.y);
        }
        const local = localDelta(groupMatrix(this.store.project, groupOfPlane(this.store.project, d.planeId)?.id ?? null), delta);
        cmd.movePlane(this.store, d.planeId, { x: d.origin.x + local.x, y: d.origin.y + local.y, z: d.origin.z + local.z }, true);
      }
      return;
    }
    if (d) return;

    if (this.navcube.contains(this.width, m.x, m.y)) {
      this.navcube.setHover(this.navcube.hitTest(this.width, m.x, m.y));
      el.style.cursor = 'grab';
      return;
    }
    this.navcube.setHover(null);
    if (this.store.mode.kind === 'edit') {
      const pi = this.nearest(this.pointsWorld, m, 10);
      const hi = this.handlesWorld ? this.nearest([this.handlesWorld.in, this.handlesWorld.out], m, 10) : null;
      const onHandle = hi !== null && (pi === null || this.dist(m, hi === 0 ? this.handlesWorld!.in : this.handlesWorld!.out) < this.dist(m, this.pointsWorld[pi]));
      this.hoverPoint = onHandle ? null : pi;
      const onCurve = this.editTool === 'add' && this.nearest(this.samplesWorld, m, 8) !== null;
      el.style.cursor = this.gizmo.axis ? 'grab' : onHandle || this.hoverPoint !== null ? 'move' : onCurve ? 'copy' : this.editTool === 'add' ? 'crosshair' : 'default';
    } else {
      el.style.cursor = this.planeTool ? this.hoverTool(m) : this.focusTool ? 'crosshair' : this.gizmo.axis ? 'grab' : this.nearest(this.arrayHandles, m, ARRAY_HANDLE_PX + 4) !== null ? 'move' : this.pickTarget(m) ? 'pointer' : 'default';
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const m = this.local(e);
    const d = this.drag;
    this.drag = null;
    this.controls.enabled = true;
    this.boxEl.style.display = 'none';
    const hadGuides = this.guides.length > 0 || this.snapTarget !== null;
    this.guides = [];
    this.guideAnchor = null;
    this.snapTarget = null;
    if (this.cubeDrag) {
      const dragged = this.cubeDrag.moved;
      this.cubeDrag = null;
      this.renderer.domElement.style.cursor = 'default';
      // a click, not a spin: snap to the zone under it
      if (!dragged && this.down && Math.hypot(m.x - this.down.x, m.y - this.down.y) < 4) {
        const z = this.navcube.hitTest(this.width, m.x, m.y);
        if (z) this.lookFrom(z.dir, z.up);
      }
      return;
    }
    const still = !!this.down && Math.hypot(m.x - this.down.x, m.y - this.down.y) < 4;
    if (e.button === 2 && this.store.mode.kind === 'edit' && still) {
      this.openContextMenu(m);
      return;
    }
    if (this.navClick) {
      // Shift-click without a drag: add to / remove from the selection (vertex in Edit mode, curve in Object mode)
      const nav = this.navClick;
      this.navClick = null;
      (this.controls.mouseButtons as { LEFT: THREE.MOUSE | null }).LEFT = null;
      if (nav.shift && still && e.button === 0) {
        const c = this.store.editingCurve();
        if (c) { const pi = this.nearest(this.pointsWorld, m, 10); if (pi !== null) cmd.selectVertex(this.store, c.id, this.pointIds[pi], true); }
        else { const t = this.pickTarget(m); if (t?.kind === 'curve') cmd.selectCurve(this.store, t.id, true); }
      }
      return;
    }
    if (!d) { if (hadGuides) this.sync(); return; }
    const c = this.store.editingCurve();
    if (d.kind === 'vertices') {
      if (c && d.moved) cmd.moveVertices(this.store, c.id, [...d.originals.keys()].map((vid) => { const v = c.curve.points.find((x) => x.id === vid)!; return { vid, p: { x: v.x, y: v.y } }; }), false);
      else this.sync();
    } else if (d.kind === 'vertexZ') {
      if (c && d.moved) cmd.moveVertices(this.store, c.id, [...d.originals.keys()].map((vid) => ({ vid, p: { z: c.curve.points.find((x) => x.id === vid)?.z } })), false);
      else this.sync();
    } else if (d.kind === 'handle') {
      const v = c?.curve.points.find((x) => x.id === d.vid);
      if (c && v && d.moved) cmd.moveHandle(this.store, c.id, d.vid, d.which, { x: v.x + v[d.which].x, y: v.y + v[d.which].y, z: v.z + v[d.which].z }, false);
      else this.sync();
    } else if (d.kind === 'box') {
      if (d.moved && this.down) {
        const x0 = Math.min(this.down.x, m.x), x1 = Math.max(this.down.x, m.x), y0 = Math.min(this.down.y, m.y), y1 = Math.max(this.down.y, m.y);
        if (c) {
          const inside = this.pointIds.filter((_, i) => { const s = this.toScreen(this.pointsWorld[i]); return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1; });
          cmd.selectVertices(this.store, inside, d.additive);
        } else {
          cmd.selectCurves(this.store, this.curvesInBox(x0, y0, x1, y1), d.additive);
        }
      } else if (e.button === 0) {
        if (c && d.addAt) cmd.addVertex(this.store, c.id, d.addAt);
        else if (c) cmd.selectVertices(this.store, []);
        else cmd.selectCurve(this.store, null);
      }
    } else if (d.kind === 'curves') {
      if (d.moved) cmd.commit(this.store); else this.sync();
    } else if (d.kind === 'group') {
      if (d.moved) cmd.commit(this.store); else this.sync();
    } else if (d.kind === 'plane') {
      const p = this.store.project.planes.find((x) => x.id === d.planeId);
      if (p && d.moved) cmd.movePlane(this.store, d.planeId, p.placement.position, false); else this.sync();
    } else if (d.kind === 'image' || d.kind === 'imageScale') {
      const img = this.store.project.planes.find((x) => x.id === d.planeId)?.image;
      if (img && d.moved) cmd.setPlaneImage(this.store, d.planeId, { center: { ...img.center }, width: img.width }, false);
      else this.sync();
    } else if (d.kind === 'offset') {
      // a drag took its distance from the pointer, a click takes the tool bar's
      const dd = d.moved ? d.d : this.toolValues.offset;
      this.clearToolPreview();
      const id = dd ? cmd.offsetCurve(this.store, d.id, dd) : null;
      this.say(id ? `Offset ${dd > 0 ? '+' : ''}${dd} mm` : 'An offset of 0 mm makes nothing — set d in the tool bar, or drag from the curve to a side');
    }
  }

  private onDoubleClick(e: MouseEvent): void {
    const m = this.local(e);
    if (this.navcube.contains(this.width, m.x, m.y) || this.store.mode.kind === 'edit') return;
    const target = this.pickTarget(m);
    if (target?.kind === 'curve') { cmd.enterEdit(this.store, target.id); return; }
    // objects: a double-click steps one level in — root → child → … → the plane (docs/18-nested-objects.md §3)
    if (target?.kind === 'object' && target.curveId) {
      const { project, selection } = this.store.state;
      const c = project.curves.find((x) => x.id === target.curveId);
      if (!c) return;
      const chain = groupChain(project, groupOfPlane(project, c.planeId)?.id ?? null);
      const i = chain.findIndex((g) => selection.groups.includes(g.id));
      const next = i < 0 ? chain[0] : chain[i + 1];
      if (next) cmd.selectGroup(this.store, next.id);
      else cmd.selectPlane(this.store, c.planeId);
    }
  }

  private openContextMenu(m: Vec2): void {
    const c = this.store.editingCurve();
    if (!c) return;
    const pi = this.nearest(this.pointsWorld, m, 12);
    if (pi !== null && !this.store.selection.vertices.includes(this.pointIds[pi])) cmd.selectVertex(this.store, c.id, this.pointIds[pi]);
    const sel = this.store.selection.vertices;
    if (!sel.length) return;
    const primary = c.curve.points.find((v) => v.id === sel[sel.length - 1])!;
    const pinned = c.constraints.some((k) => k.type === 'pin' && k.a === primary.id);
    const two = sel.length === 2;
    const [a, b] = sel;
    const types: { t: VertexType; label: string }[] = [{ t: 'polygon', label: 'Polygon (no handles)' }, { t: 'equal', label: 'Equal handles' }, { t: 'free', label: 'Free handles' }];
    const items: MenuItem[] = [
      ...types.map((t) => ({ label: t.label, hint: 'V', checked: primary.type === t.t, onClick: () => cmd.setVertexType(this.store, c.id, sel, t.t) })),
      { separator: true },
      { label: 'Keep horizontal', hint: 'H', disabled: !two, onClick: () => cmd.addConstraint(this.store, c.id, 'horizontal', a, b) },
      { label: 'Keep vertical', hint: '⇧V', disabled: !two, onClick: () => cmd.addConstraint(this.store, c.id, 'vertical', a, b) },
      { label: 'Keep distance', hint: 'D', disabled: !two, onClick: () => cmd.addConstraint(this.store, c.id, 'distance', a, b) },
      { label: pinned ? 'Unpin' : 'Pin in place', hint: 'P', checked: pinned, onClick: () => cmd.togglePin(this.store, c.id, primary.id) },
      { separator: true },
      { label: sel.length > 1 ? `Break apart at ${sel.length} vertices` : 'Break apart here', hint: 'B', onClick: () => cmd.breakApart(this.store, c.id, sel) },
      { label: sel.length > 1 ? `Delete ${sel.length} vertices` : 'Delete vertex', hint: 'Del', onClick: () => cmd.deleteVertices(this.store, c.id, sel) },
    ];
    const r = this.renderer.domElement.getBoundingClientRect();
    showContextMenu(r.left + m.x, r.top + m.y, items);
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const editing = this.store.editingCurve();
    const sel = this.store.selection.vertices;
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === 'a' && editing) { cmd.selectAllVertices(this.store); e.preventDefault(); }
      if (e.key.toLowerCase() === 'd' && !editing) { cmd.duplicateSelection(this.store); e.preventDefault(); }
      if (e.key.toLowerCase() === 'g' && !editing) { cmd.groupSelection(this.store); e.preventDefault(); }
      if (e.key.toLowerCase() === 'l' && !editing) {
        const ids = this.store.selection.curves;
        if (ids.length === 2) cmd.addLoft(this.store, ids[0], ids[1]);
        e.preventDefault();
      }
      if (e.key.toLowerCase() === 'j' && !editing) {
        const ids = this.store.selection.curves;
        if (ids.length === 2) cmd.joinEnds(this.store, ids[1], ids[0]);
        e.preventDefault();
      }
      return;
    }
    const active = this.store.activeCurve();
    const pair = editing && sel.length === 2 ? ([sel[0], sel[1]] as const) : null;
    switch (e.key) {
      case 'Tab': cmd.toggleEdit(this.store); break;
      case 'Escape':
        if (this.imageCalibrate) this.cancelImageCalibration();
        else if (this.filletFirst) { this.filletFirst = null; this.say(''); this.sync(); }         // the fillet's first pick is dropped, the tool stays
        else if (this.planeTool) this.setPlaneTool(null);
        else if (this.store.selection.arrayHandle) cmd.selectArrayHandle(this.store, null);   // the gizmo goes back to the plane (docs/26-array.md §3)
        else if (!editing) cmd.selectCurve(this.store, null);
        else if (sel.length) cmd.selectVertices(this.store, []);
        else cmd.exitEdit(this.store);
        break;
      case 'Delete': case 'Backspace': deleteSelectionAsked(this.store); break;
      case 'c': case 'C': if (active) cmd.toggleClosed(this.store, active.id); break;
      case 'g': case 'G': cmd.toggleSnap(this.store); break;
      case 'f': case 'F': this.fit(); break;
      // Blender's numpad . — pivot on the selection and zoom to its extents (docs/20-viewport-status-bar.md)
      case '.': this.frameSelection(); break;
      case 'Home': this.alignToPlane(true); break;
      case 'w': case 'W': this.setGizmoMode('translate'); break;
      case 'e': case 'E': this.setGizmoMode('rotate'); break;
      case 'r': case 'R': this.setGizmoMode('scale'); break;
      case 'a': case 'A': if (editing) this.setEditTool('add'); else return; break;
      // the plane tools (docs/29-offset-trim-fillet.md): the key toggles the tool
      case 'o': case 'O': if (editing) return; this.setPlaneTool(this.planeTool === 'offset' ? null : 'offset'); break;
      case 't': case 'T': if (editing) return; this.setPlaneTool(this.planeTool === 'trim' ? null : 'trim'); break;
      case 'l': case 'L': if (editing) return; this.setPlaneTool(this.planeTool === 'fillet' ? null : 'fillet'); break;
      case '1': case '2': case '3': case '4': if (editing) return; this.togglePickLevel((['curve', 'loft', 'plane', 'object'] as const)[+e.key - 1]); break;
      case 'b': case 'B': if (editing && sel.length) cmd.breakApart(this.store, editing.id, sel); else return; break;
      case 'v': if (editing && sel.length) cmd.cycleVertexType(this.store, editing.id, sel); else return; break;
      case 'V': if (pair) cmd.addConstraint(this.store, editing!.id, 'vertical', pair[0], pair[1]); else return; break;
      case 'h': case 'H': if (pair) cmd.addConstraint(this.store, editing!.id, 'horizontal', pair[0], pair[1]); else return; break;
      case 'd': case 'D': if (pair) cmd.addConstraint(this.store, editing!.id, 'distance', pair[0], pair[1]); else return; break;
      case 'p': case 'P':
        if (editing && sel.length) cmd.togglePin(this.store, editing.id, sel[sel.length - 1]);
        else if (!editing && this.store.selection.curves.length) projectSelectionAsked(this.store);   // docs/34-project.md
        else return;
        break;
      default: return;
    }
    e.preventDefault();
  }
}
