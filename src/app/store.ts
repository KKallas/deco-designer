/**
 * Single state store. Views render from `state` + `evals`; UI code changes
 * state only through commands (src/app/commands.ts) which call `update`.
 * Undo history snapshots the project (not mode / selection).
 */
import { findCurve, findGroup, findLoft, findShape, findPlane, firstCamera, flattenCurve, normalizeLoftEdge, normalizeOutlineLayer, normalizeShape, planeOf, profileOf, wouldCycle, type Camera, type Curve, type CurveObject, type Id, type Loft, type ObjectGroup, type OutlineLayer, type Plane, type Profile, type Project, type Shape } from '../model/types';
import { EMPTY_SAMPLING, sampleCurve, type CurveSampling } from '../geometry/curve';
import { layerCurve } from '../geometry/outline';
import { runChecks, type Violation } from '../checks';
import { defaultPost } from '../model/post-presets';
import { checkConstraints } from '../model/constraints';

/** object: the scene · edit: one curve's vertices · post: the post-processing editor in the panel, the viewport previewing the draft (docs/15-camera.md) */
export type Mode = { kind: 'object' } | { kind: 'edit'; curveId: Id } | { kind: 'post' };

/**
 * Object mode: `curves` are the selected curve objects (last = primary) and
 * `planeId` the active plane; `planeSelected` means the plane itself is the
 * thing selected (it moves as a whole). Edit mode: `vertices` of the edited curve.
 */
export interface Selection {
  curves: Id[];
  planeId: Id | null;
  planeSelected: boolean;
  vertices: Id[];
  loftId: Id | null;
  /** the selected shape (docs/30-outline-and-shape-layers.md) */
  shapeId: Id | null;
  /** the selected objects (docs/18-nested-objects.md); a gizmo acts on each of them */
  groups: Id[];
  cameraId: Id | null;
  /** the array handle the gizmo drives (docs/26-array.md §3) */
  arrayHandle: ArrayHandle | null;
  /**
   * Several of one class at once (docs/35-outliner-multi-edit.md §2): the lists behind
   * `planeId` / `loftId` / `shapeId` / `cameraId`, which name the primary — the last of each.
   * `validate` keeps the two in step whichever side a command wrote.
   */
  planes: Id[];
  lofts: Id[];
  shapes: Id[];
  cameras: Id[];
}
export interface State { project: Project; mode: Mode; selection: Selection; snap: boolean; alignSnap: boolean }

/** One outline layer evaluated (docs/30 §3): its own curve, sampled and checked against its profile. */
export interface LayerEval {
  layer: OutlineLayer;
  profile: Profile;
  /** the drawn curve moved by the layer's offset and lift (the drawn one itself on the line) */
  curve: Curve;
  sampling: CurveSampling;
  violations: Violation[];
}

export interface CurveEval {
  /** the drawn curve */
  sampling: CurveSampling;
  layers: LayerEval[];
  /** every layer's violations, each naming its layer */
  violations: Violation[];
  /** constraint id → currently satisfied */
  constraints: Map<Id, boolean>;
}

type Listener = (store: Store) => void;

/** A handle of the plane's array modifier: the linear offset, the circular axis point, or its "up" direction. */
export type ArrayHandle = 'offset' | 'center' | 'axis';

export const NO_SELECTION: Selection = { curves: [], planeId: null, planeSelected: false, vertices: [], loftId: null, shapeId: null, groups: [], cameraId: null, arrayHandle: null, planes: [], lofts: [], shapes: [], cameras: [] };

export class Store {
  state: State;
  /** Derived per-curve data, rebuilt on every update. */
  evals = new Map<Id, CurveEval>();
  private listeners = new Set<Listener>();
  private history: string[] = [];
  private index = -1;
  private cache = new Map<Id, { key: string; value: CurveEval }>();
  private txDepth = 0;
  private liveDepth = 0;

  constructor(project: Project) {
    this.state = { project, mode: { kind: 'object' }, selection: { ...NO_SELECTION }, snap: true, alignSnap: true };
    this.evaluate();
    this.record();
  }

  get project(): Project { return this.state.project; }
  get mode(): Mode { return this.state.mode; }
  get selection(): Selection { return this.state.selection; }
  get primaryCurveId(): Id | null { const c = this.state.selection.curves; return c.length ? c[c.length - 1] : null; }
  get primaryVertex(): Id | null { const v = this.state.selection.vertices; return v.length ? v[v.length - 1] : null; }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Mutate state. Records an undo step unless `history: false` (live drags). */
  update(fn: (s: State) => void, opts: { history?: boolean } = {}): void {
    fn(this.state);
    this.validate();
    this.evaluate();
    if (opts.history !== false && this.txDepth === 0) this.record();
    this.emit();
  }

  /**
   * A live edit that spans events — a number field being dragged (docs/25-number-fields.md §3).
   * Commands run without recording until `endLive()` writes the one undo step.
   */
  beginLive(): void { this.liveDepth++; this.txDepth++; }
  endLive(): void {
    if (!this.liveDepth) return;
    this.liveDepth--;
    if (--this.txDepth === 0) { this.record(); this.emit(); }
  }
  /** Close a live edit left open — a page that went away mid-drag, say. */
  cancelLive(): void { while (this.liveDepth) this.endLive(); }

  /** Run several commands as one undo step, synchronously (a panel field writing every selected thing). */
  batch<T>(fn: () => T): T {
    this.txDepth++;
    try { return fn(); }
    finally { if (--this.txDepth === 0) { this.record(); this.emit(); } }
  }

  /** Run many commands as one undo step (a script, an agent call). */
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    this.txDepth++;
    try { return await fn(); }
    finally { if (--this.txDepth === 0) { this.record(); this.emit(); } }
  }

  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.history.length - 1; }
  undo(): void { if (this.canUndo) this.restore(this.index - 1); }
  redo(): void { if (this.canRedo) this.restore(this.index + 1); }

  /** The curve being edited, or the primary selected curve. */
  activeCurve(): CurveObject | null {
    const id = this.state.mode.kind === 'edit' ? this.state.mode.curveId : this.primaryCurveId;
    return findCurve(this.state.project, id);
  }

  editingCurve(): CurveObject | null {
    return this.state.mode.kind === 'edit' ? findCurve(this.state.project, this.state.mode.curveId) : null;
  }

  /** Plane of the active curve, or the explicitly selected plane. */
  activePlane(): Plane | null {
    const { project, selection } = this.state;
    const c = this.activeCurve();
    if (c) return planeOf(project, c);
    return findPlane(project, selection.planeId);
  }

  profileOf(layer: OutlineLayer): Profile { return profileOf(this.state.project, layer); }
  selectedLoft(): Loft | null { return findLoft(this.state.project, this.state.selection.loftId); }
  selectedShape(): Shape | null { return findShape(this.state.project, this.state.selection.shapeId); }
  /** The selected things of one class, the primary last (docs/35-outliner-multi-edit.md §2). */
  selectedCurves(): CurveObject[] { return this.state.selection.curves.map((id) => findCurve(this.state.project, id)).filter((c): c is CurveObject => !!c); }
  selectedPlanes(): Plane[] { return this.state.selection.planes.map((id) => findPlane(this.state.project, id)).filter((p): p is Plane => !!p); }
  selectedLofts(): Loft[] { return this.state.selection.lofts.map((id) => findLoft(this.state.project, id)).filter((l): l is Loft => !!l); }
  selectedShapes(): Shape[] { return this.state.selection.shapes.map((id) => findShape(this.state.project, id)).filter((x): x is Shape => !!x); }
  selectedCameras(): Camera[] { return this.state.selection.cameras.map((id) => this.state.project.cameras.find((c) => c.id === id)).filter((c): c is Camera => !!c); }
  /** The selected objects, outermost first. */
  selectedGroups(): ObjectGroup[] { return this.state.selection.groups.map((id) => findGroup(this.state.project, id)).filter((g): g is ObjectGroup => !!g); }
  /** The one selected object (null when none or several are selected). */
  selectedGroup(): ObjectGroup | null { const g = this.selectedGroups(); return g.length === 1 ? g[0] : null; }
  planeOf(c: CurveObject): Plane { return planeOf(this.state.project, c); }

  // -- internals -------------------------------------------------------------

  private restore(i: number): void {
    this.index = i;
    this.state.project = JSON.parse(this.history[i]) as Project;
    this.validate();
    this.evaluate();
    this.emit();
  }

  private record(): void {
    const s = JSON.stringify(this.state.project);
    if (this.history[this.index] === s) return;
    this.history.splice(this.index + 1);
    this.history.push(s);
    if (this.history.length > 200) this.history.shift();
    this.index = this.history.length - 1;
  }

  private validate(): void {
    const { project, mode, selection } = this.state;
    project.curves = project.curves.filter((c) => findPlane(project, c.planeId));
    project.lofts = project.lofts.filter((l) => findCurve(project, l.a) && findCurve(project, l.b) && l.a !== l.b);
    if (selection.loftId && !selection.lofts?.length) selection.lofts = [selection.loftId];
    selection.lofts = (selection.lofts ?? []).filter((id, i, xs) => findLoft(project, id) && xs.indexOf(id) === i);
    selection.loftId = selection.lofts.length ? selection.lofts[selection.lofts.length - 1] : null;
    // objects (docs/18-nested-objects.md): members exist, one parent each, no cycles, empty objects go
    for (const g of project.groups) {
      g.planes = g.planes.filter((id, i) => findPlane(project, id) && g.planes.indexOf(id) === i && project.groups.every((x) => x === g || !x.planes.includes(id)));
      g.groups ??= [];
      g.placement ??= { preset: 'custom', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
      g.visible = g.visible !== false;
    }
    for (const g of project.groups) {
      g.groups = g.groups.filter((id, i) => id !== g.id && findGroup(project, id) && g.groups.indexOf(id) === i
        && project.groups.every((x) => x === g || !x.groups.includes(id)) && !wouldCycle(project, id, g.id));
    }
    for (let pass = 0; pass < 8; pass++) {
      const before = project.groups.length;
      project.groups = project.groups.filter((g) => g.planes.length || g.groups.some((id) => findGroup(project, id)));
      for (const g of project.groups) g.groups = g.groups.filter((id) => findGroup(project, id));
      if (project.groups.length === before) break;
    }
    selection.groups = selection.groups.filter((id) => findGroup(project, id));
    // one class, several at once (docs/35 §2): the single id is the last of its list, either side may have been written
    selection.planes ??= []; selection.lofts ??= []; selection.shapes ??= []; selection.cameras ??= [];
    if (selection.planeSelected && selection.planeId && !selection.planes.length) selection.planes = [selection.planeId];
    selection.planes = selection.planes.filter((id, i) => findPlane(project, id) && selection.planes.indexOf(id) === i);
    if (selection.planes.length) { selection.planeId = selection.planes[selection.planes.length - 1]; selection.planeSelected = true; }
    else selection.planeSelected = false;
    project.materials ??= [];
    project.textures ??= [];
    // always a camera, always looked through (docs/36-camera-world.md) — also after agent scripts
    project.cameras ??= [];
    if (!project.cameras.length) project.cameras.push(firstCamera());
    if (!project.cameras.some((c) => c.id === project.activeCamera)) project.activeCamera = project.cameras[0].id;
    if (selection.cameraId && !selection.cameras.length) selection.cameras = [selection.cameraId];
    selection.cameras = selection.cameras.filter((id, i, xs) => project.cameras.some((c) => c.id === id) && xs.indexOf(id) === i);
    selection.cameraId = selection.cameras.length ? selection.cameras[selection.cameras.length - 1] : null;
    project.post ??= defaultPost();
    for (const c of project.curves) {
      // the outline (docs/30 §3): every layer bent from a profile that exists, materials that exist — also after agent scripts
      c.outline = (c.outline ?? []).filter((l) => l && l.id).map((l) => normalizeOutlineLayer(l, project.profiles));
      for (const l of c.outline) if (l.materialId && !project.materials.some((m) => m.id === l.materialId)) l.materialId = null;
      // a planar curve lies in its plane (docs/12-3d-curves.md) — also after agent scripts
      if (c.type !== 'spatial') { c.type = 'planar'; if (c.curve.points.some((v) => v.z || v.in.z || v.out.z) || c.constraints.some((k) => k.at?.z)) flattenCurve(c); }
    }
    for (const l of project.lofts) {
      if (l.materialId && !project.materials.some((m) => m.id === l.materialId)) l.materialId = null;
      l.edgeA = normalizeLoftEdge(l.edgeA); l.edgeB = normalizeLoftEdge(l.edgeB);   // docs/24-loft-trim.md
    }
    // shapes (docs/30 §4): over curves that exist, layers running fills that exist
    project.fills ??= [];
    project.shapes = (project.shapes ?? []).filter((sh) => sh && sh.id).map((sh) => normalizeShape(sh));
    for (const sh of project.shapes) {
      sh.curves = sh.curves.filter((id) => findCurve(project, id));
      sh.layers = sh.layers.filter((l) => project.fills.some((f) => f.id === l.fillId) || project.fills.length).map((l) => ({ ...l, fillId: project.fills.some((f) => f.id === l.fillId) ? l.fillId : project.fills[0].id }));
      for (const l of sh.layers) if (l.materialId && !project.materials.some((m) => m.id === l.materialId)) l.materialId = null;
    }
    project.shapes = project.shapes.filter((sh) => sh.curves.length);
    if (selection.shapeId && !selection.shapes.length) selection.shapes = [selection.shapeId];
    selection.shapes = selection.shapes.filter((id, i, xs) => findShape(project, id) && xs.indexOf(id) === i);
    selection.shapeId = selection.shapes.length ? selection.shapes[selection.shapes.length - 1] : null;
    if (mode.kind === 'edit' && !findCurve(project, mode.curveId)) this.state.mode = { kind: 'object' };
    selection.curves = selection.curves.filter((id) => findCurve(project, id));
    if (selection.planeId && !findPlane(project, selection.planeId)) { selection.planeId = null; selection.planeSelected = false; }
    const editing = this.editingCurve() ?? findCurve(project, this.primaryCurveId);
    const ids = new Set(editing?.curve.points.map((v) => v.id) ?? []);
    selection.vertices = selection.vertices.filter((id) => ids.has(id));
  }

  private evaluate(): void {
    const { project } = this.state;
    const next = new Map<Id, CurveEval>();
    for (const c of project.curves) {
      const profiles = c.outline.map((l) => profileOf(project, l));
      const key = JSON.stringify([c.curve, c.outline.map((l, i) => [l.id, l.offset, l.lift, profiles[i]?.limits]), c.constraints]);
      const hit = this.cache.get(c.id);
      if (hit && hit.key === key) { next.set(c.id, hit.value); continue; }
      const sampling = c.curve.points.length >= 2 ? sampleCurve(c.curve) : EMPTY_SAMPLING;
      // every layer on its own curve (docs/30 §3): a layer on the line shares the drawn curve's sampling
      const layers: LayerEval[] = c.outline.map((layer, i) => {
        const profile = profiles[i];
        const curve = layerCurve(c.curve, layer, sampling);
        const own = curve === c.curve ? sampling : curve.points.length >= 2 ? sampleCurve(curve) : EMPTY_SAMPLING;
        return { layer, profile, curve, sampling: own, violations: runChecks(curve, profile, own).map((v) => ({ ...v, layer: layer.id })) };
      });
      const value: CurveEval = { sampling, layers, violations: layers.flatMap((l) => l.violations), constraints: checkConstraints(c.curve, c.constraints) };
      this.cache.set(c.id, { key, value });
      next.set(c.id, value);
    }
    for (const id of this.cache.keys()) if (!next.has(id)) this.cache.delete(id);
    this.evals = next;
  }

  private emit(): void {
    for (const l of this.listeners) l(this);
  }
}
