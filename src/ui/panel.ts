/**
 * Right-hand panel, split in two panes that scroll independently: the
 * outliner (planes → curves) on top, tools + properties below, with a
 * draggable splitter between them. The outliner can be folded to a header.
 * Object mode: outliner, tools, plane placement + modifier, curve properties.
 * Edit mode: constraints window (profile + limitations + vertex constraints),
 * plane modifier, curve info (the outliner pane is hidden).
 */
import type { ArrayHandle, Store } from '../app/store';
import * as cmd from '../app/commands';
import { PLANE_PRESETS, childGroups, fillOf, findAnimation, planeVisible, groupChain, groupOfPlane, groupVisible, loftEdge, loftsOfGroup, loftsOwnedBy, shapesOfGroup, shapesOwnedBy, parentOfGroup, subtreeGroups, wouldCycle, type Animation, type ArrayModifier, type Camera, type CurveObject, type CurveType, type Loft, type LoftEdge, type ObjectGroup, type OutlineLayer, type Profile, type Shape, type ShapeLayer, type Plane, type PlanePreset, type PostProgram, type Vec3, type VertexType, type World } from '../model/types';
import { FILM_BACKS, F_STOPS, LENSES, cameraFov, dofRange } from '../model/camera';
import { describeWorld, isHdrMime, type WorldPatch } from '../model/world';
import { PIXELS_PER_CHAIN, pixelCount } from '../model/types';
import { CHECKER_COLOR, PRESET_FILLS } from '../model/fills';
import { PRESET_PROFILES } from '../model/profiles';
import { fillLibrary, shapeLibrary } from '../shapes/library';
import { HDR_ACCEPT, IMAGE_ACCEPT, isImageMime, textureFromFile } from '../materials/textures';
import { POST_PRESETS } from '../model/post-presets';
import { frameAt } from '../view3d/pixels';
import { postLibrary } from './post-library';
import { compilePost } from '../view3d/effects';
import { planeWorld } from '../geometry/placement';
import { slug } from '../model/types';
import { limitStatuses } from '../checks';
import { MIXED, badge, btn, colorField, el, numField, numRow, section, selectField, subTitle, swatch, textField } from './dom';
import { Fields, pickIds, pickMode, shared, type Shared } from './multi';
import { commitArray } from '../geometry/array';
import { isScrubbing } from './scrub';
import { deleteGroupsAsked } from './confirm';
import { addLibraryMaterial } from '../app/commands';
import { onLibraryChange, readLibrary } from '../materials/library';
import type { Id } from '../model/types';

const KEY_H = 'deco.outlineHeight';
const KEY_FOLD = 'deco.outlineFolded';
const KEY_FOLDS = 'deco.outlineFolds';   // folded rows: object / plane ids, 'lofts:<object id>', 'lofts'
const MIN_TOP = 60;   // px – header + a couple of rows
const MIN_BOTTOM = 120;

const PRESETS = [...(Object.keys(PLANE_PRESETS) as PlanePreset[]).map((p) => ({ value: p, label: PLANE_PRESETS[p].label })), { value: 'custom', label: 'Custom' }];

/** The classes of outliner rows a Shift / ⌘ click stays within (docs/35-outliner-multi-edit.md §3). */
type RowKind = 'curve' | 'plane' | 'group' | 'loft' | 'shape' | 'camera';

export class Panel {
  private dirty = false;
  private top = el('div', { class: 'pane top' });
  private splitter = el('div', { class: 'splitter', title: 'Drag to resize the outliner' });
  private bottom = el('div', { class: 'pane bottom' });
  private folded = localStorage.getItem(KEY_FOLD) === '1';
  private folds = new Set<string>(JSON.parse(localStorage.getItem(KEY_FOLDS) ?? '[]') as string[]);

  /** how close two ends have to be to weld when an array is committed (docs/26-array.md §4) */
  private merge = 0.5;

  /** a draft post script under edit (post mode, docs/15-camera.md) */
  private postDraft: PostProgram | null = null;
  private postCode = el('textarea', { class: 'code post-code', spellcheck: false });
  private postStatus: { text: string; error: boolean } = { text: '', error: false };
  /** the fixture's own frame on the shared clock (docs/22-transport-in-out.md), written on its own like the transport's counter */
  private frameLabel = el('span', { class: 'dim' });
  private frameOf: Animation | null = null;
  /** folded layer cards (`owner/layer`), this session */
  private foldedLayers = new Set<string>();

  /**
   * `openMaterials(id)` / `openShapes(id)` open the pages (docs/13, 14); `viewer` hooks the post editor's preview and the
   * camera properties to the viewport (docs/15-camera.md).
   */
  constructor(private root: HTMLElement, private store: Store, private openMaterials: (materialId?: Id | null) => void = () => {}, private openShapes: (shapeId?: Id | null) => void = () => {},
    private viewer: { preview: (draft: PostProgram | null) => string | null; view: () => { position: Vec3; target: Vec3 } | null; selectionDistance: () => number | null; fit: () => void; lamps: (id: Id, layer?: Id) => number; calibrateImage: (planeId: Id) => void; seconds: () => number } = { preview: () => null, view: () => null, selectionDistance: () => null, fit: () => {}, lamps: () => 0, calibrateImage: () => {}, seconds: () => 0 }) {
    this.postCode.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.previewPost(); } });
    root.replaceChildren(this.top, this.splitter, this.bottom);
    const h = Number(localStorage.getItem(KEY_H));
    if (h > 0) this.setTopHeight(h);
    this.splitter.addEventListener('pointerdown', (e) => this.dragSplitter(e));
    store.subscribe(() => this.render());
    onLibraryChange(() => this.render());   // the importer tab added a material
    root.addEventListener('focusout', () => {
      setTimeout(() => { if (this.dirty && !this.root.contains(document.activeElement)) this.render(); }, 0);
    });
    this.render();
    const tick = () => { this.showFrame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  /** The frame the selected fixture's map is on right now — the clock is the transport's, the frame is this map's. */
  private showFrame(): void {
    const a = this.frameOf;
    const text = a ? `frame ${frameAt(a, this.viewer.seconds()) + 1} / ${Math.max(1, a.frames)}` : '';
    if (this.frameLabel.textContent !== text) this.frameLabel.textContent = text;
  }

  render(): void {
    // a drag on a number field must not have the element under the pointer replaced (docs/25-number-fields.md §3)
    if (isScrubbing()) { this.dirty = true; return; }
    const active = document.activeElement;
    if (active && this.root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) { this.dirty = true; return; }
    this.dirty = false;
    const scrollTop = this.top.scrollTop;
    const scrollBottom = this.bottom.scrollTop;
    const editing = this.store.editingCurve();
    const postMode = this.store.mode.kind === 'post';
    if (postMode && !this.postDraft) this.startPostDraft();
    if (!postMode && this.postDraft) { this.postDraft = null; this.viewer.preview(null); }
    const plane = this.store.activePlane();
    // one class, several at once (docs/35-outliner-multi-edit.md §4): every section takes the whole list, the primary last
    const curves = this.store.selectedCurves();
    const planes = this.store.selectedPlanes();
    const lofts = this.store.selectedLofts();
    const shapes = this.store.selectedShapes();
    const cameras = this.store.selectedCameras();
    this.frameOf = null;                       // set again by the fixture rows below (docs/22)
    const groups = this.store.selectedGroups();
    const onePlane = planes.length < 2;        // the array and the reference image are structure — one plane at a time
    const top: (HTMLElement | null)[] = editing || postMode ? [] : [this.outliner()];
    const bottom: (HTMLElement | null)[] = postMode
      ? [this.postEditor()]
      : editing
        ? [this.editHeader(editing), this.constraints(editing), plane ? this.modifier(plane) : null, plane ? this.imageSection(plane) : null, this.curveInfo(editing)]
        : cameras.length
          ? [this.cameraSection(cameras)]
          : groups.length
            ? [this.groupSection(groups)]
            : lofts.length
              ? [this.loftSection(lofts)]
            : shapes.length
              ? [this.shapeSection(shapes)]
              : [plane ? this.planeSection(planes.length > 1 ? planes : [plane]) : null, plane && onePlane ? this.modifier(plane) : null, plane && onePlane ? this.imageSection(plane) : null, curves.length && !this.store.selection.planeSelected ? this.curveSection(curves) : null];
    const keep = (xs: (HTMLElement | null)[]) => xs.filter((s): s is HTMLElement => !!s);
    this.top.replaceChildren(...keep(top));
    this.bottom.replaceChildren(...keep(bottom));
    this.top.hidden = !!editing || postMode;
    this.top.classList.toggle('folded', this.folded);
    this.splitter.hidden = !!editing || postMode || this.folded;
    this.top.scrollTop = scrollTop;
    this.bottom.scrollTop = scrollBottom;
  }

  // -- panes -----------------------------------------------------------------------

  private setTopHeight(px: number): void {
    const max = this.root.clientHeight ? Math.max(MIN_TOP, this.root.clientHeight - MIN_BOTTOM) : Infinity;
    const h = Math.round(Math.max(MIN_TOP, Math.min(max, px)));
    this.top.style.height = `${h}px`;
    localStorage.setItem(KEY_H, String(h));
  }

  private dragSplitter(e: PointerEvent): void {
    e.preventDefault();
    const start = e.clientY;
    const h0 = this.top.getBoundingClientRect().height;
    this.splitter.setPointerCapture(e.pointerId);
    this.splitter.classList.add('dragging');
    const move = (ev: PointerEvent) => this.setTopHeight(h0 + ev.clientY - start);
    const up = () => {
      this.splitter.classList.remove('dragging');
      this.splitter.removeEventListener('pointermove', move);
      this.splitter.removeEventListener('pointerup', up);
      this.splitter.removeEventListener('pointercancel', up);
    };
    this.splitter.addEventListener('pointermove', move);
    this.splitter.addEventListener('pointerup', up);
    this.splitter.addEventListener('pointercancel', up);
  }

  private setFolded(f: boolean): void {
    this.folded = f;
    localStorage.setItem(KEY_FOLD, f ? '1' : '0');
    this.render();
  }

  /** Chevron that folds / unfolds one outliner row (object, plane, lofts subsection). */
  private chevron(key: string, count: number): HTMLElement {
    const folded = this.folds.has(key);
    return el('span', {
      class: `chevron ${count ? '' : 'empty'}`, title: folded ? 'Unfold' : 'Fold',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        if (folded) this.folds.delete(key); else this.folds.add(key);
        localStorage.setItem(KEY_FOLDS, JSON.stringify([...this.folds]));
        this.render();
      },
    }, folded ? '▸' : '▾');
  }

  /** The rows of each class as drawn, top to bottom — what a Shift-click ranges over (docs/35 §3); folded rows are not in it. */
  private order: Record<RowKind, Id[]> = { curve: [], plane: [], group: [], loft: [], shape: [], camera: [] };

  /** An outliner name: a label — names are changed in the properties pane (docs/35 §1). */
  private name(n: string): HTMLElement { return el('span', { class: 'grow name', title: n }, n); }

  /** A click on an outliner row: plain replaces, Shift ranges, ⌘ / Ctrl toggles — within the row's class (docs/35 §3). */
  private pick(kind: RowKind, id: Id, e: MouseEvent): void {
    const sel = this.store.selection;
    const current: Record<RowKind, Id[]> = { curve: sel.curves, plane: sel.planes, group: sel.groups, loft: sel.lofts, shape: sel.shapes, camera: sel.cameras };
    const ids = pickIds(current[kind], id, this.order[kind], pickMode(e));
    switch (kind) {
      case 'curve': cmd.selectCurves(this.store, ids); break;
      case 'plane': cmd.selectPlanes(this.store, ids); break;
      case 'group': cmd.selectGroups(this.store, ids); break;
      case 'loft': cmd.selectLofts(this.store, ids); break;
      case 'shape': cmd.selectShapes(this.store, ids); break;
      case 'camera': cmd.selectCameras(this.store, ids); break;
    }
  }

  // -- object mode -------------------------------------------------------------

  private outliner(): HTMLElement {
    const { project, selection } = this.store.state;
    const rows: HTMLElement[] = [];
    this.order = { curve: [], plane: [], group: [], loft: [], shape: [], camera: [] };
    // cameras first: few, always one looked through, each carrying the world (docs/15-camera.md, docs/36-camera-world.md)
    {
      const last = project.cameras.length < 2;
      rows.push(el('div', { class: 'plane-row group', style: 'cursor:default' },
        this.chevron('cameras', project.cameras.length), el('span', { class: 'icon' }, '📷'), el('span', { class: 'grow dim' }, 'Cameras'), el('span', { class: 'dim' }, `${project.cameras.length}`)));
      if (!this.folds.has('cameras')) for (const c of project.cameras) {
        const active = project.activeCamera === c.id;
        this.order.camera.push(c.id);
        rows.push(el('div', { class: `row item curve-row ${selection.cameras.includes(c.id) ? 'selected' : ''}`, onclick: (e: MouseEvent) => this.pick('camera', c.id, e), ondblclick: () => cmd.setActiveCamera(this.store, c.id), title: 'Click: properties · double-click: look through' },
          el('span', { class: 'icon', title: active ? 'Looking through this camera' : '' }, active ? '◉' : '○'),
          this.name(c.name),
          el('span', { class: 'dim' }, `${c.focalLength} mm${c.dof.enabled ? ' · DOF' : ''}`),
          btn('×', () => cmd.removeCamera(this.store, c.id), { title: last ? 'The last camera stays — the viewport always looks through one' : 'Delete camera', disabled: last }),
        ));
      }
    }
    const loftRow = (l: Loft, indent: string) => {
      const name = (id: string) => project.curves.find((c) => c.id === id)?.name ?? '?';
      this.order.loft.push(l.id);
      return el('div', { class: `row item curve-row ${selection.lofts.includes(l.id) ? 'selected' : ''}`, style: indent, onclick: (e: MouseEvent) => this.pick('loft', l.id, e) },
        el('span', { class: 'icon' }, '◫'),
        this.name(l.name),
        el('span', { class: 'dim' }, `${name(l.a)} ↔ ${name(l.b)}`),
        btn('×', () => cmd.removeLoft(this.store, l.id), { title: 'Delete loft' }),
      );
    };
    // a shape over curves with its fill layers (docs/30-outline-and-shape-layers.md §4), listed beside the lofts
    const shapeRow = (sh: Shape, indent: string) => {
      const names = sh.curves.map((id) => project.curves.find((c) => c.id === id)?.name ?? '?');
      const bits = [names.join(', '), `${sh.layers.length} layer${sh.layers.length === 1 ? '' : 's'}`];
      this.order.shape.push(sh.id);
      return el('div', { class: `row item curve-row ${selection.shapes.includes(sh.id) ? 'selected' : ''}`, style: indent, onclick: (e: MouseEvent) => this.pick('shape', sh.id, e) },
        el('span', { class: 'icon' }, '▱'),
        this.name(sh.name),
        el('span', { class: 'dim' }, bits.join(' · ')),
        btn('×', () => cmd.removeShape(this.store, sh.id), { title: 'Delete shape' }),
      );
    };
    const surfacesHeader = (key: string, count: number, indent: string) =>
      el('div', { class: 'plane-row group', style: `cursor:default;${indent}` },
        this.chevron(key, count),
        el('span', { class: 'icon' }, '◫'),
        el('span', { class: 'grow dim' }, 'Surfaces'),
        el('span', { class: 'dim' }, `${count}`),
      );
    const groupedLofts = new Set<string>(), groupedShapes = new Set<string>();
    // objects nest (docs/18-nested-objects.md): child objects first, then the planes and the object's own lofts
    const groupRows = (g: ObjectGroup, depth: number): void => {
      const indent = depth ? `margin-left:${depth * 18}px` : '';
      const isSel = selection.groups.includes(g.id);
      const kids = childGroups(project, g);
      const lofts = loftsOwnedBy(project, g), panels = shapesOwnedBy(project, g);
      for (const l of loftsOfGroup(project, g)) groupedLofts.add(l.id);
      for (const p of shapesOfGroup(project, g)) groupedShapes.add(p.id);
      const surfaces = lofts.length + panels.length;
      const shownByParent = groupVisible(project, parentOfGroup(project, g.id)?.id ?? null);
      const parts = [`${g.planes.length} plane${g.planes.length === 1 ? '' : 's'}`];
      if (kids.length) parts.unshift(`${kids.length} object${kids.length === 1 ? '' : 's'}`);
      if (surfaces) parts.push(`${surfaces} surface${surfaces === 1 ? '' : 's'}`);
      this.order.group.push(g.id);
      rows.push(el('div', { class: `plane-row group-row ${isSel ? 'selected' : ''} ${g.visible && shownByParent ? '' : 'hidden-row'}`, style: indent, onclick: (e: MouseEvent) => this.pick('group', g.id, e) },
        this.chevron(g.id, kids.length + g.planes.length + surfaces),
        el('span', { class: 'icon' }, '▣'),
        this.name(g.name),
        el('span', { class: 'dim' }, parts.join(' · ')),
        this.eye(g, shownByParent),
        btn('×', () => cmd.ungroup(this.store, g.id), { title: 'Ungroup: the planes and child objects move up, nothing moves in 3D' }),
      ));
      if (this.folds.has(g.id)) return;
      for (const c of kids) groupRows(c, depth + 1);
      for (const pid of g.planes) { const plane = project.planes.find((x) => x.id === pid); if (plane) this.planeRows(rows, plane, `margin-left:${(depth + 1) * 18}px`); }
      if (surfaces) {
        rows.push(surfacesHeader(`lofts:${g.id}`, surfaces, `margin-left:${(depth + 1) * 18}px`));
        if (!this.folds.has(`lofts:${g.id}`)) {
          for (const l of lofts) rows.push(loftRow(l, `margin-left:${(depth + 2) * 18}px`));
          for (const p of panels) rows.push(shapeRow(p, `margin-left:${(depth + 2) * 18}px`));
        }
      }
    };
    for (const g of project.groups) if (!parentOfGroup(project, g.id)) groupRows(g, 0);
    for (const plane of project.planes) if (!groupOfPlane(project, plane.id)) this.planeRows(rows, plane, '');
    const freeLofts = project.lofts.filter((l) => !groupedLofts.has(l.id));
    const freeShapes = project.shapes.filter((p) => !groupedShapes.has(p.id));
    if (freeLofts.length + freeShapes.length) {
      rows.push(surfacesHeader('lofts', freeLofts.length + freeShapes.length, ''));
      if (!this.folds.has('lofts')) {
        for (const l of freeLofts) rows.push(loftRow(l, ''));
        for (const p of freeShapes) rows.push(shapeRow(p, ''));
      }
    }
    const n = project.planes.length + project.groups.length + project.lofts.length + project.shapes.length + project.cameras.length;
    const head = el('div', { class: 'sec-title fold-head', onclick: () => this.setFolded(!this.folded), title: this.folded ? 'Unfold the outliner' : 'Fold the outliner' },
      el('span', { class: 'chevron' }, this.folded ? '▸' : '▾'),
      el('span', { class: 'grow' }, 'Outliner'),
      this.folded ? el('span', { class: 'dim' }, `${project.planes.length} plane${project.planes.length === 1 ? '' : 's'} · ${project.curves.length} curve${project.curves.length === 1 ? '' : 's'}`) : null,
    );
    if (this.folded) return el('section', { class: 'sec outliner-sec' }, head);
    return el('section', { class: 'sec outliner-sec' }, head,
      el('div', { class: 'outliner' }, ...rows),
      n ? null : el('div', { class: 'hint' }, 'No planes yet. Add one with ▤ on the viewport rail (▾ picks which way it faces), or ○ for a curve.'),
      el('div', { class: 'hint' }, 'Click selects; Shift-click a range, ⌘-click adds or removes — rows of one kind: curves, planes, objects, surfaces, cameras. Names are changed in the properties below. Dragging a curve of a selected object moves everything in it.'),
    );
  }

  private planeRows(rows: HTMLElement[], plane: Plane, indent: string): void {
    const { project, selection } = this.store.state;
    {
      const curves = project.curves.filter((c) => c.planeId === plane.id);
      const isSel = selection.planes.includes(plane.id);
      const folded = this.folds.has(plane.id);
      const selInside = folded ? curves.filter((c) => selection.curves.includes(c.id)).length : 0;
      this.order.plane.push(plane.id);
      rows.push(el('div', { class: `plane-row ${isSel ? 'selected' : ''} ${selection.planeId === plane.id ? 'active' : ''} ${planeVisible(project, plane.id) ? '' : 'hidden-row'}`, style: indent, onclick: (e: MouseEvent) => this.pick('plane', plane.id, e) },
        this.chevron(plane.id, curves.length),
        el('span', { class: 'icon' }, '▱'),
        this.name(plane.name),
        el('span', { class: 'dim' }, `${plane.placement.preset}${plane.array ? ` · ×${plane.array.count}` : ''}${folded ? ` · ${curves.length} curve${curves.length === 1 ? '' : 's'}${selInside ? ` (${selInside} sel)` : ''}` : ''}`),
        btn('×', () => cmd.removePlane(this.store, plane.id), { title: 'Delete plane and its curves' }),
      ));
      if (folded) return;
      for (const c of curves) {
        const ev = this.store.evals.get(c.id)!;
        const sel = selection.curves.includes(c.id);
        const first = ev.layers[0]?.profile ?? null;
        const what = !first ? 'line' : ev.layers.length > 1 ? `${first.label} +${ev.layers.length - 1}` : first.label;
        this.order.curve.push(c.id);
        rows.push(el('div', { class: `row item curve-row ${sel ? 'selected' : ''}`, style: indent, onclick: (e: MouseEvent) => this.pick('curve', c.id, e), ondblclick: () => cmd.enterEdit(this.store, c.id) },
          swatch(first?.color ?? '#55555c'),
          this.name(c.name),
          el('span', { class: 'dim' }, `${what} · ${c.curve.points.length} v`),
          badge(ev.violations.length, '#ff5c5c'),
        ));
      }
      if (!curves.length) rows.push(el('div', { class: 'hint curve-row', style: indent }, 'empty plane – press + Curve'));
    }
  }

  /** An x y z row over the selected things (docs/35 §4): a component shows -- where they differ, and a value set goes to all. */
  private vec<X>(label: string, f: Fields<X>, get: (x: X) => Vec3, step: number, onChange: (patch: Partial<Vec3>) => void): HTMLElement {
    return el('div', { class: 'row fields' },
      el('span', { class: 'lbl' }, label),
      f.num('x', (x) => get(x).x, (n) => onChange({ x: n }), { step }),
      f.num('y', (x) => get(x).y, (n) => onChange({ y: n }), { step }),
      f.num('z', (x) => get(x).z, (n) => onChange({ z: n }), { step }),
    );
  }

  /** "-- where the N things differ; a value set here goes to all of them." */
  private sharedHint(n: number, what: string, more = ''): HTMLElement {
    return el('div', { class: 'hint' }, `${MIXED} where the ${n} ${what} differ; a value set here goes to all of them.${more ? ` ${more}` : ''}`);
  }

  /** A name row: with several selected it follows the same rule as every other field (docs/35 §6). */
  private nameRow(f: Fields<{ name: string }>, placeholder: string, set: (name: string) => void): HTMLElement {
    return el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'name'), f.text((x) => x.name, set, { class: 'grow', placeholder }));
  }

  /** The selected planes' properties (docs/35 §4), the primary last. */
  private planeSection(ps: Plane[]): HTMLElement {
    const { project } = this.store;
    const p = ps[ps.length - 1], ids = ps.map((x) => x.id), several = ps.length > 1, f = new Fields(ps);
    const depth = (g: ObjectGroup) => groupChain(project, g.id).length - 1;
    const groups = [{ value: '', label: '— none —' }, ...project.groups.map((g) => ({ value: g.id, label: `${'· '.repeat(depth(g))}${g.name}` }))];
    const parent = groupOfPlane(project, p.id);
    const world = planeWorld(project, p).origin;
    return section(several ? `${ps.length} planes` : `Plane · ${p.name}`,
      several ? el('div', { class: 'dim' }, ps.map((x) => x.name).join(' · ')) : null,
      this.nameRow(f, 'Plane name', (v) => cmd.renamePlane(this.store, ids, v)),
      el('div', { class: 'row' },
        el('span', { class: 'lbl' }, 'object'),
        f.select((x) => groupOfPlane(project, x.id)?.id ?? '', groups, (v) => cmd.setPlaneGroup(this.store, ids, v || null), { class: 'grow', title: 'The object this plane belongs to; it keeps its place in 3D' }),
      ),
      el('div', { class: 'row' },
        el('span', { class: 'lbl' }, 'preset'),
        f.select((x) => x.placement.preset, PRESETS, (v) => { if (v !== 'custom') cmd.setPlanePlacement(this.store, ids, { preset: v as PlanePreset }); }, { class: 'grow' }),
      ),
      this.vec(parent ? 'pos mm ∈' : 'pos mm', f, (x) => x.placement.position, 10, (patch) => cmd.setPlanePlacement(this.store, ids, { position: patch })),
      this.vec(parent ? 'rot ° ∈' : 'rot °', f, (x) => x.placement.rotation, 5, (patch) => cmd.setPlanePlacement(this.store, ids, { rotation: patch })),
      // inside an object the placement is local to it (docs/18-nested-objects.md §2) — show where that lands in the world
      parent && !several ? el('div', { class: 'dim', title: `Local to the object "${parent.name}"` }, `∈ ${parent.name} · world (${Math.round(world.x)}, ${Math.round(world.y)}, ${Math.round(world.z)}) mm`) : null,
      several ? this.sharedHint(ps.length, 'planes', 'The array and the reference image are edited one plane at a time.') : null,
    );
  }

  /**
   * Material dropdown (docs/10-materials.md): project materials, the shared library (picking copies it into the project) and
   * "Material editor…" (docs/13-material-editor.md). With `look`, a colour picker sits in front of it: the layer's own colour
   * over the program's (docs/30 §5), ↺ goes back to the program's; both only count while no material is assigned.
   */
  private materialField(current: Id | null, defaultLabel: string, onPick: (materialId: Id | null) => void, look?: { color: string | null; base: string; onColor: (hex: string | null) => void; mixed?: boolean }, mixed = false): HTMLElement {
    const { project } = this.store;
    const inProject = new Set(project.materials.map((m) => m.id));
    const EDIT = 'edit:';
    const options = [
      { value: '', label: defaultLabel },
      ...project.materials.map((m) => ({ value: m.id, label: `${m.name}${m.warnings.length ? ' ⚠' : ''}`, group: project.materials.length ? 'Project' : undefined })),
      ...readLibrary().filter((m) => !inProject.has(m.id)).map((m) => ({ value: `lib:${m.id}`, label: `${m.name}${m.source ? ` (${m.source})` : ''}`, group: 'Add from library' })),
      { value: EDIT, label: 'Material editor…' },
    ];
    const field = selectField(current ?? '', options, (v) => {
      if (v === EDIT) { field.value = current ?? ''; this.openMaterials(current); if (mixed) this.render(); return; }
      if (!v) return onPick(null);
      if (v.startsWith('lib:')) {
        const lib = readLibrary().find((m) => m.id === v.slice(4));
        if (!lib) return;
        void this.store.transaction(() => onPick(addLibraryMaterial(this.store, lib)));
        return;
      }
      onPick(v);
    }, { class: 'grow', title: 'Surface material — rename, edit, add textures, import from Blender on the materials page (last entry)', mixed });
    if (!look) return el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'material'), field);
    const checker = look.base === CHECKER_COLOR;
    const shown = look.color ?? (checker ? '#bbbbbb' : look.base);
    const own = look.color != null;
    return el('div', { class: `row look ${current ? 'has-material' : ''}` },
      el('span', { class: 'lbl' }, 'look'),
      el('span', { class: `param ${own ? 'overridden' : ''}`, title: current ? 'The material decides the look; the colour is used again when it is removed' : own ? `This layer's own colour (the program's is ${checker ? 'the checkerboard' : look.base})` : checker ? 'The checkerboard — pick a colour to paint this layer instead' : `The program's colour ${look.base} — pick one to override it on this layer` },
        colorField(shown, (hex) => look.onColor(hex), { mixed: look.mixed }),
        own ? btn('↺', () => look.onColor(null), { title: checker ? 'Back to the checkerboard' : 'Back to the program\'s colour' }) : null,
      ),
      field,
    );
  }

  /**
   * The selected cameras' properties (docs/15-camera.md, several at once docs/35 §4): look through, film back, lens,
   * depth of field, frame, pose, world (docs/36: every camera carries one). The primary (last) is the one looked
   * through / set from the view; the world's fields show for one camera only.
   */
  private cameraSection(cams: Camera[]): HTMLElement {
    const { project } = this.store;
    const cam = cams[cams.length - 1], ids = cams.map((c) => c.id), several = cams.length > 1, f = new Fields(cams);
    const update = (patch: Parameters<typeof cmd.updateCamera>[2]) => cmd.updateCamera(this.store, ids, patch);
    /** a patch built per camera — the pose, where the components not set must stay each camera's own */
    const each = (fn: (c: Camera) => Parameters<typeof cmd.updateCamera>[2]) => this.store.batch(() => { for (const c of cams) cmd.updateCamera(this.store, c.id, fn(c)); });
    const isActive = project.activeCamera === cam.id;
    const filmIdOf = (c: Camera) => FILM_BACKS.find((x) => Math.abs(x.width - c.filmBack.width) < 0.01 && Math.abs(x.height - c.filmBack.height) < 0.01)?.id ?? 'custom';
    const chips = (values: number[], current: Shared<number>, onPick: (v: number) => void, fmt: (v: number) => string = String) =>
      el('span', { class: 'chips' }, ...values.map((v) => btn(fmt(v), () => onPick(v), { active: !current.mixed && Math.abs(v - current.value) < 1e-9 })));
    const fov = cameraFov(cam);
    const view = this.viewer.view();
    const passe = f.of((c) => c.frame.passepartout);
    return section(several ? `${cams.length} cameras` : `Camera · ${cam.name}`,
      several ? el('div', { class: 'dim' }, cams.map((c) => c.name).join(' · ')) : null,
      el('div', { class: 'row wrap' },
        isActive ? null : btn(several ? `Look through ${cam.name}` : 'Look through', () => cmd.setActiveCamera(this.store, cam.id), { class: 'primary', title: 'The viewport moves to this camera; navigating then moves the camera' }),
        view && !isActive ? btn('Set from view', () => cmd.updateCamera(this.store, cam.id, { pose: { position: view.position, target: view.target } }), { title: `Put ${several ? cam.name : 'this camera'} where the viewport is now` }) : null,
        el('span', { class: 'dim', title: isActive ? 'To leave this camera where it stands, make a new camera from the view (◉ on the rail, or the ▾ under the cube)' : '' }, isActive ? 'Looking through — navigating moves it' : ''),
      ),
      this.nameRow(f, 'Camera name', (v) => update({ name: v })),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'film back'), f.select(filmIdOf, [...FILM_BACKS.map((x) => ({ value: x.id, label: x.label })), { value: 'custom', label: 'Custom' }], (v) => { const x = FILM_BACKS.find((y) => y.id === v); if (x) update({ filmBack: { width: x.width, height: x.height } }); }, { class: 'grow', title: 'Sensor size, mm' })),
      el('div', { class: 'row fields' }, el('span', { class: 'lbl' }, 'mm'), f.num('w', (c) => c.filmBack.width, (v) => update({ filmBack: { width: Math.max(1, v) } }), { step: 0.1, min: 1 }), f.num('h', (c) => c.filmBack.height, (v) => update({ filmBack: { height: Math.max(1, v) } }), { step: 0.1, min: 1 })),
      el('div', { class: 'row fields' }, el('span', { class: 'lbl' }, 'lens'), f.num('mm', (c) => c.focalLength, (v) => update({ focalLength: Math.max(1, v) }), { step: 1, min: 1 }), chips(LENSES, f.of((c) => c.focalLength), (v) => update({ focalLength: v }))),
      el('div', { class: 'hint' }, `${several ? `${cam.name}: field` : 'Field'} of view ${fov.horizontal.toFixed(1)}° × ${fov.vertical.toFixed(1)}° — the frame in the viewport shows exactly this.`),
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'Depth of field'),
      el('div', { class: 'row' },
        f.check('enabled', (c) => c.dof.enabled, (v) => update({ dof: { enabled: v } })),
        el('span', { class: 'grow' }),
        btn('Focus on selection', () => { const d = this.viewer.selectionDistance(); if (d !== null) update({ dof: { enabled: true, focusDistance: Math.round(d) } }); }, { title: 'Focus at the selected curves / loft (or everything) — the ◎ tool in the viewport focuses with a click' }),
      ),
      el('div', { class: 'row fields' }, el('span', { class: 'lbl' }, 'focus'), f.num('mm', (c) => Math.round(c.dof.focusDistance), (v) => update({ dof: { focusDistance: Math.max(1, v) } }), { step: 50, min: 1 }), f.num('f/', (c) => c.dof.fStop, (v) => update({ dof: { fStop: Math.max(0.7, v) } }), { step: 0.1, min: 0.7 })),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, ''), chips(F_STOPS, f.of((c) => c.dof.fStop), (v) => update({ dof: { fStop: v } }), (v) => `f/${v}`)),
      el('div', { class: 'hint' }, `${several ? `${cam.name}: ±` : '±'}${Math.round(dofRange(cam))} mm around the focus plane is fully blurred (thin lens, ${cam.filmBack.height} mm sensor).`),
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'Frame'),
      el('div', { class: 'row' },
        f.check('show', (c) => c.frame.show, (v) => update({ frame: { show: v } })),
        el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cam.frame.passepartout, class: `grow ${passe.mixed ? 'mixed' : ''}`, title: 'Passepartout: how dark the area outside the frame is', onchange: (e: Event) => update({ frame: { passepartout: Number((e.target as HTMLInputElement).value) } }) }),
        el('span', { class: 'dim' }, passe.mixed ? MIXED : `${Math.round(cam.frame.passepartout * 100)} %`),
      ),
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'Pose'),
      this.vec('pos mm', f, (c) => c.pose.position, 50, (patch) => each((c) => ({ pose: { position: { ...c.pose.position, ...patch } } }))),
      this.vec('target', f, (c) => c.pose.target, 50, (patch) => each((c) => ({ pose: { target: { ...c.pose.target, ...patch } } }))),
      // the world is the camera's (docs/16-world.md, docs/36-camera-world.md): background, environment, sun, exposure, emitters
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'World'),
      el('div', { class: 'hint' }, several ? '' : `What ${isActive ? 'the viewport shows' : 'this camera sees'} behind the objects and what lights them (Blender's world). Nothing lights the scene that is not here.`),
      several ? this.sharedHint(cams.length, 'cameras', 'The world\'s fields are edited one camera at a time.') : null,
      ...(several ? [] : this.worldFields(cam.world, (patch) => update({ world: patch }))),
      several ? null : el('div', { class: 'hint dim' }, describeWorld(cam.world, project)),
    );
  }

  // -- world (docs/16-world.md) -----------------------------------------------------------

  /** Add an .hdr / .exr to the project's textures and hand its id back. */
  private pickHdr(onPick: (id: Id) => void): void {
    const input = el('input', { type: 'file', accept: HDR_ACCEPT, onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      textureFromFile(f).then((t) => onPick(cmd.addTexture(this.store, t))).catch((err) => alert(err instanceof Error ? err.message : String(err)));
    } });
    input.click();
  }

  /** The rows of a camera's world; `update` applies a patch to it. */
  private worldFields(w: World, update: (patch: WorldPatch) => void): HTMLElement[] {
    const hdrs = this.store.project.textures.filter((t) => isHdrMime(t.mime));
    const lbl = (text: string) => el('span', { class: 'lbl' }, text);
    const hdrRow = (current: Id, onPick: (id: Id) => void) => el('div', { class: 'row' }, lbl('HDR'),
      selectField(current, [
        ...(hdrs.some((t) => t.id === current) ? [] : [{ value: current, label: current ? `${current} (missing)` : hdrs.length ? '— pick one —' : '— add one —' }]),
        ...hdrs.map((t) => ({ value: t.id, label: `${t.name} · ${t.width}×${t.height}` })),
      ], (v) => onPick(v), { class: 'grow', title: 'An equirectangular .hdr / .exr from the project textures (materials page › textures lists them too)' }),
      btn('Add…', () => this.pickHdr(onPick), { title: 'Add an .hdr / .exr file to the project and use it here — 1k is plenty for the viewport, a 2k .hdr is a few MB in the file' }),
    );
    const bg = w.background, env = w.environment, sun = w.sun;
    const rows: (HTMLElement | null)[] = [
      el('div', { class: 'sec-title', style: 'margin-top:4px' }, 'Background'),
      el('div', { class: 'row' }, lbl('kind'),
        selectField(bg.kind, [{ value: 'color', label: 'Colour' }, { value: 'hdr', label: 'HDR image' }], (v) => update({ background: { kind: v as 'color' | 'hdr' } }), { class: 'grow', title: 'What the camera sees behind the objects' }),
        bg.kind === 'color' ? colorField(bg.color, (hex) => update({ background: { color: hex } })) : null),
      bg.kind === 'hdr' ? hdrRow(bg.texture, (id) => update({ background: { texture: id } })) : null,
      bg.kind === 'hdr' ? el('div', { class: 'row' }, lbl('blur'),
        el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: bg.blur, class: 'grow', title: 'Blur the background image (0 = sharp)', onchange: (e: Event) => update({ background: { blur: Number((e.target as HTMLInputElement).value) } }) }),
        el('span', { class: 'dim' }, `${Math.round(bg.blur * 100)} %`)) : null,
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'Environment'),
      el('div', { class: 'row' }, lbl('kind'),
        selectField(env.kind, [{ value: 'none', label: 'None' }, { value: 'color', label: 'Colour (uniform)' }, { value: 'room', label: 'Studio room' }, { value: 'hdr', label: 'HDR image' }], (v) => update({ environment: { kind: v as World['environment']['kind'] } }), { class: 'grow', title: 'What lights the scene and shows in reflections' }),
        env.kind === 'color' ? colorField(env.color, (hex) => update({ environment: { color: hex } })) : null),
      env.kind === 'hdr' ? hdrRow(env.texture, (id) => update({ environment: { texture: id } })) : null,
      env.kind !== 'none' ? el('div', { class: 'row fields' }, lbl(''), numField('strength', w.strength, (v) => update({ strength: Math.max(0, v) }), { step: 0.1, min: 0, title: 'Environment light multiplier' }), numField('rotate °', w.rotation, (v) => update({ rotation: v }), { step: 5, title: 'Turn the HDR (background and environment together) about the vertical axis' })) : null,
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'Sun'),
      el('div', { class: 'row' },
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: sun.enabled, onchange: (e: Event) => update({ sun: { enabled: (e.target as HTMLInputElement).checked } }) }), 'enabled'),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: sun.shadows, onchange: (e: Event) => update({ sun: { shadows: (e.target as HTMLInputElement).checked } }) }), 'shadows'),
        el('span', { class: 'grow' }),
        colorField(sun.color, (hex) => update({ sun: { color: hex } }), { title: 'Sun colour' }),
      ),
      el('div', { class: 'row fields' }, lbl(''), numField('azimuth °', sun.azimuth, (v) => update({ sun: { azimuth: v } }), { step: 5, title: 'Where the sun comes from, clockwise from the front (+Z) seen from above' }), numField('elevation °', sun.elevation, (v) => update({ sun: { elevation: Math.max(-90, Math.min(90, v)) } }), { step: 5, title: 'Height above the horizon' }), numField('strength', sun.strength, (v) => update({ sun: { strength: Math.max(0, v) } }), { step: 0.5, min: 0 })),
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'Emitters'),
      el('div', { class: 'row' },
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: w.emitters.enabled, onchange: (e: Event) => update({ emitters: { enabled: (e.target as HTMLInputElement).checked } }) }), 'the LEDs light the scene'),
        el('span', { class: 'grow' }),
        w.emitters.enabled ? el('label', { class: 'chk', title: 'Shadows: the structure blocks the light of a lamp behind it (costs a longer bake)' }, el('input', { type: 'checkbox', checked: w.emitters.visibility, onchange: (e: Event) => update({ emitters: { visibility: (e.target as HTMLInputElement).checked } }) }), 'shadows') : null,
      ),
      w.emitters.enabled ? el('div', { class: 'row fields' }, lbl(''),
        numField('strength', w.emitters.strength, (v) => update({ emitters: { strength: Math.max(0, v) } }), { step: 0.25, min: 0, title: '1 = the shape\'s emissive colour read as a real lamp' }),
        numField('probes mm', w.emitters.probeSpacing, (v) => update({ emitters: { probeSpacing: Math.max(50, v) } }), { step: 50, min: 50, title: 'How far apart the light probes sit: closer is sharper and slower to bake' })) : null,
      w.emitters.enabled ? el('div', { class: 'hint' }, 'Light comes from the emissive geometry itself — the LED pixels, whatever colour they show. Diffuse only; add post.ssgi in the post script for the near-field bounce.') : null,
      el('div', { class: 'sec-title', style: 'margin-top:8px' }, 'View'),
      el('div', { class: 'row fields' }, lbl(''), numField('exposure', w.exposure, (v) => update({ exposure: Math.max(0, v) }), { step: 0.1, min: 0, title: 'Exposure of the AgX view transform (1 = as lit)' })),
    ];
    return rows.filter((x): x is HTMLElement => !!x);
  }

  // -- post-processing editor (post mode, docs/15-camera.md) ------------------------------------

  private startPostDraft(): void {
    this.postDraft = JSON.parse(JSON.stringify(this.store.project.post)) as PostProgram;
    this.postCode.value = this.postDraft.code;
    this.postStatus = { text: 'Draft of the project script — the viewport previews it; Commit saves, Cancel discards', error: false };
  }

  /** Build the draft in the viewport (⌘⏎ / Preview / a knob change). */
  private previewPost(): void {
    if (!this.postDraft) return;
    const src = this.postCode.value;
    try { compilePost(src); } catch (e) { this.postStatus = { text: `Syntax error: ${e instanceof Error ? e.message : String(e)}`, error: true }; this.render(); return; }
    this.postDraft.code = src;
    const err = this.viewer.preview(this.postDraft);
    this.postStatus = err ? { text: `Script error: ${err}`, error: true } : { text: 'Previewing the draft', error: false };
    this.render();
  }

  private postEditor(): HTMLElement {
    const d = this.postDraft!;
    const setDraft = (patch: Partial<PostProgram>) => { Object.assign(d, patch); if (patch.code !== undefined) this.postCode.value = patch.code; this.previewPost(); };
    const commit = () => { d.code = this.postCode.value; cmd.setPost(this.store, d); this.viewer.preview(null); this.postDraft = null; cmd.exitPostEdit(this.store); };
    const cancel = () => { this.viewer.preview(null); this.postDraft = null; cmd.exitPostEdit(this.store); };
    const entries = Object.entries(d.params);
    const rename = (from: string, to: string) => { const t = to.trim().replace(/[^\w]/g, '_'); if (!t || t === from || t in d.params) return; setDraft({ params: Object.fromEntries(entries.map(([k, v]) => [k === from ? t : k, v])) }); };
    let newName = '';
    const presets = POST_PRESETS.map((x) => el('div', { class: `row item ${x.code === d.code ? 'selected' : ''}`, onclick: () => setDraft({ label: x.label, code: x.code, params: { ...x.params, ...Object.fromEntries(Object.entries(d.params).filter(([k]) => k in x.params)) } }) },
      el('span', { class: 'grow' }, x.label), el('span', { class: 'dim' }, Object.keys(x.params).join(', ') || 'no knobs')));
    const lib = postLibrary.read().map((x) => el('div', { class: `row item ${x.code === d.code ? 'selected' : ''}`, onclick: () => setDraft({ label: x.label, code: x.code, params: { ...x.params } }) },
      el('span', { class: 'grow' }, x.label), el('span', { class: 'dim' }, Object.keys(x.params).join(', ')), btn('×', () => { postLibrary.remove(x.id); this.render(); }, { title: 'Remove from the library' })));
    return el('div', {},
      el('section', { class: 'sec edit-head' },
        el('div', { class: 'row' },
          el('span', { class: 'sec-title', style: 'margin:0' }, 'Post-processing'),
          el('span', { class: 'grow' }),
          btn('Cancel', cancel, { title: 'Discard the draft, back to the project script' }),
          btn('Commit', commit, { class: 'primary', title: 'Save the draft as the project script (undoable)' }),
        ),
        el('div', { class: 'row' },
          textField(d.label, (v) => { d.label = v; }, { class: 'grow', placeholder: 'Name' }),
          el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: d.enabled, onchange: (e: Event) => setDraft({ enabled: (e.target as HTMLInputElement).checked }) }), 'on'),
          btn('Save to library', () => { postLibrary.save({ id: slug(d.label) || 'post', label: d.label, code: this.postCode.value, params: { ...d.params } }); this.postStatus = { text: `"${d.label}" saved to the library`, error: false }; this.render(); }, { title: 'Keep this script and its knobs for other projects in this browser' }),
        ),
        el('div', { class: `code-status ${this.postStatus.error ? 'error' : ''}`, style: 'border:none; padding:2px 0' }, this.postStatus.text),
      ),
      section('Knobs',
        el('div', { class: 'hint', style: 'padding-top:0' }, 'params.name in the script · reflections ≥ 0 (lamps in the metals, 0 off) · threshold ≥ 0 · knee 0–1 · radius 0–1 (0.3 tight halos, 1 fog) · strength ≥ 0 · flare, streaks ≥ 0 · streakLength 0–0.5 · bokeh ≥ 0'),
        el('div', { class: 'params' },
          ...entries.flatMap(([k, v]) => [
            textField(k, (t) => rename(k, t), { title: 'Rename (the script must use the new name)' }),
            numField('', v, (n) => setDraft({ params: { ...d.params, [k]: n } }), { step: v >= 10 ? 1 : 0.05 }),
            btn('×', () => { const next = { ...d.params }; delete next[k]; setDraft({ params: next }); }, { title: 'Remove' }),
          ]),
          textField('', (t) => { newName = t; }, { placeholder: 'new knob' }), el('span'),
          btn('＋', () => { const t = newName.trim().replace(/[^\w]/g, '_'); if (t && !(t in d.params)) setDraft({ params: { ...d.params, [t]: 0 } }); }, { title: 'Add a knob (value 0)' }),
        ),
      ),
      section('Script',
        el('div', { class: 'row' },
          el('span', { class: 'dim' }, '(post, params) => output node'),
          el('span', { class: 'grow' }),
          btn('Presets ▾', () => { const p = this.bottom.querySelector('.post-presets') as HTMLElement | null; if (p) p.hidden = !p.hidden; }, { title: 'Load a preset or a library script into the draft' }),
          btn('Revert', () => { this.postCode.value = this.store.project.post.code; setDraft({ ...JSON.parse(JSON.stringify(this.store.project.post)) as PostProgram }); }, { title: 'Back to the project script' }),
          btn('Preview ⌘⏎', () => this.previewPost(), { class: 'primary', title: 'Build the draft in the viewport' }),
        ),
        el('div', { class: 'post-presets', hidden: true },
          el('div', { class: 'sec-title', style: 'margin-top:4px' }, 'Presets'), ...presets,
          el('div', { class: 'sec-title', style: 'margin-top:6px' }, 'Library (this browser)'), ...lib, lib.length ? null : el('div', { class: 'hint' }, 'Saved scripts live here.'),
        ),
        this.postCode,
      ),
    );
  }

  /** The selected curves' properties (docs/35 §4), the primary last: its outline lists the layers, edited by index on all. */
  private curveSection(cs: CurveObject[]): HTMLElement {
    const c = cs[cs.length - 1], ids = cs.map((x) => x.id), several = cs.length > 1, f = new Fields(cs);
    const planes = this.store.project.planes.map((p) => ({ value: p.id, label: p.name }));
    return section(several ? `${cs.length} curves` : `Curve · ${c.name}`,
      several ? el('div', { class: 'dim' }, cs.map((x) => x.name).join(' · ')) : null,
      this.nameRow(f, 'Curve name', (v) => cmd.renameCurve(this.store, ids, v)),
      this.typeField(cs),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'plane'), f.select((x) => x.planeId, planes, (v) => cmd.setCurvePlane(this.store, ids, v), { class: 'grow', title: 'Move to another plane (the drawing keeps its plane coordinates)' })),
      subTitle(`Outline · ${c.outline.length ? `${c.outline.length} layer${c.outline.length === 1 ? '' : 's'}` : 'construction line'}`,
        btn('＋ Layer', () => cmd.addOutlineLayer(this.store, ids), { title: 'Add a layer on top: a profile bent along the line (offset it sideways for the inner or the outer side)' }),
      ),
      ...c.outline.map((l, i) => this.outlineLayer(cs, l, i)),
      !c.outline.length ? el('div', { class: 'hint' }, 'No layers: the curve shows as a thin guide only. ＋ Layer bends a profile along it.') : null,
      several ? this.sharedHint(cs.length, 'curves', 'A layer is the same-numbered layer of each curve; a curve without it is skipped.') : null,
    );
  }

  /**
   * One layer of the outline (docs/30 §3) as a card: the head names it (eye, number, profile, violations,
   * order, remove); the body holds its properties — side offset and lift, params, material and, for an LED
   * profile, the fixture. With several curves selected the fields read layer `i` of each (-- where they
   * differ) and a change goes to layer `i` of each (docs/35 §4). ▸ folds the body.
   */
  private outlineLayer(cs: CurveObject[], l: OutlineLayer, i: number): HTMLElement {
    const c = cs[cs.length - 1], selected = cs.map((x) => x.id);
    const layers = cs.map((x) => x.outline[i]).filter((x): x is OutlineLayer => !!x);   // the primary's is last
    const f = new Fields(layers);
    const profile = this.store.profileOf(l);
    const le = this.store.evals.get(c.id)?.layers[i];
    const up = (patch: Parameters<typeof cmd.updateOutlineLayers>[3]) => cmd.updateOutlineLayers(this.store, selected, i, patch);
    const n = c.outline.length;
    const key = `${c.id}/${l.id}`;
    const folded = this.foldedLayers.has(key);
    const where = [l.offset ? `${l.offset > 0 ? '+' : ''}${l.offset}` : '', l.lift ? `↑${l.lift}` : ''].filter(Boolean).join(' ');
    const material = f.of((x) => x.materialId);
    const body = folded ? null : el('div', { class: 'layer-body' },
      el('div', { class: 'row fields' },
        el('span', { class: 'lbl' }, 'place'),
        f.num('offset', (x) => x.offset, (v) => up({ offset: v }), { step: 5, title: 'Sideways in the plane, mm: + outside on a closed curve, the left-hand side of travel on an open one; − the other way' }),
        f.num('lift', (x) => x.lift, (v) => up({ lift: v }), { step: 5, title: 'Along the plane normal, mm: + in front of the plane' }),
        le && le.curve !== c.curve ? el('span', { class: 'dim', title: 'Length of this layer on its own offset curve' }, `${le.sampling.length.toFixed(0)} mm`) : null,
      ),
      this.paramFields(layers, profile, i, selected),
      this.materialField(material.value, 'Colour (default)', (id) => cmd.setCurveMaterial(this.store, selected, id, i), { color: l.color, base: profile.color, onColor: (hex) => up({ color: hex }), mixed: f.of((x) => x.color).mixed }, material.mixed),
      this.pixelsSection(cs, layers, i),
    );
    return el('div', { class: `layer ${l.visible ? '' : 'off'}` },
      this.layerHead(key, folded, l.visible, () => up({ visible: !l.visible }), i, n,
        this.profileField(layers, i, selected),
        [swatch(l.color ?? profile.color), badge(le?.violations.length ?? 0, '#ff5c5c'), where ? el('span', { class: 'dim' }, where) : null],
        (to) => this.store.batch(() => { for (const x of cs) { const y = x.outline[i]; if (y) cmd.moveOutlineLayer(this.store, x.id, y.id, to); } }),
        () => this.store.batch(() => { for (const x of cs) { const y = x.outline[i]; if (y) cmd.removeOutlineLayer(this.store, x.id, y.id); } }),
      ),
      body,
    );
  }

  /**
   * The head strip every layer card shares: ▸ fold · 👁 · number · the program dropdown · status bits ·
   * ▲ ▼ order · ×. `move(to)` gets the list index to move to, `remove` deletes the layer.
   */
  private layerHead(key: string, folded: boolean, visible: boolean, toggle: () => void, i: number, n: number, program: HTMLElement, bits: (HTMLElement | null)[], move: (to: number) => void, remove: () => void): HTMLElement {
    return el('div', { class: 'layer-head' },
      el('span', { class: 'fold', title: folded ? 'Show the properties' : 'Fold the properties away', onclick: () => { if (folded) this.foldedLayers.delete(key); else this.foldedLayers.add(key); this.render(); } }, folded ? '▸' : '▾'),
      el('span', { class: `eye ${visible ? '' : 'off'}`, title: visible ? 'Hide this layer' : 'Show this layer', onclick: toggle }, visible ? '👁' : '◌'),
      el('span', { class: 'idx', title: 'Position in the stack, bottom first' }, String(i + 1)),
      program,
      ...bits.filter((b): b is HTMLElement => !!b),
      el('span', { class: 'order' },
        i > 0 ? btn('▲', () => move(i - 1), { class: 'mini', title: 'Move down the stack' }) : el('span', { class: 'mini gap' }),
        i < n - 1 ? btn('▼', () => move(i + 2), { class: 'mini', title: 'Move up the stack' }) : el('span', { class: 'mini gap' }),
      ),
      btn('×', remove, { class: 'mini', title: 'Remove this layer' }),
    );
  }

  /**
   * The fixture (docs/17-emitters.md): chains of 80 pixels reading an animation map. Shown for a profile that
   * numbers its lamps with a `pixel` attribute — an LED string.
   */
  private pixelsSection(cs: CurveObject[], layers: OutlineLayer[], i: number): HTMLElement | null {
    const { project } = this.store;
    const c = cs[cs.length - 1], l = layers[layers.length - 1], selected = cs.map((x) => x.id);
    const profile = this.store.profileOf(l);
    if (!profile.code.includes("'pixel'")) return null;
    const px = l.pixels;
    if (px) this.frameOf = findAnimation(project, px.animation);
    const lamps = this.viewer.lamps(c.id, l.id);
    const patch = (p: Parameters<typeof cmd.setCurvePixels>[2]) => cmd.setCurvePixels(this.store, selected, p, i);
    const f = new Fields(layers);
    const rows: (HTMLElement | null)[] = [
      subTitle('Fixture', el('span', { class: 'dim' }, `${lamps} lamp${lamps === 1 ? '' : 's'}`)),
      el('div', { class: 'row' }, f.check('driven by an animation', (x) => !!x.pixels, (on) => patch(on ? {} : null))),
    ];
    if (px) {
      // the fields read the layers that are fixtures (the primary's last); a change patches every selected one
      const g = new Fields(layers.filter((x) => x.pixels));
      const chains = g.of((x) => x.pixels!.chains);
      const pixels = pixelCount(px);
      const anims = project.animations;
      const spare = lamps > pixels ? `the last ${lamps - pixels} stay dark` : `${pixels - lamps} pixels light nothing`;
      const mismatch = lamps && lamps !== pixels ? ` · the profile makes ${lamps} lamps, so ${spare}` : '';
      rows.push(
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'chains'),
          el('span', { class: 'chips' }, ...[1, 2, 3].map((n) => btn(`${n} · ${n * PIXELS_PER_CHAIN}`, () => patch({ chains: n }), { active: !chains.mixed && chains.value === n, title: `${n} daisy-chained chain${n === 1 ? '' : 's'} = ${n * PIXELS_PER_CHAIN} pixels` }))),
        ),
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'map'),
          g.select((x) => x.pixels!.animation ?? '', [{ value: '', label: anims.length ? '— none (own colour) —' : '— add a map on the materials page —' }, ...anims.map((a) => ({ value: a.id, label: `${a.name} · ${a.width}×${a.frames}` }))],
            (v) => patch({ animation: v || null }), { class: 'grow', title: 'The animation map this fixture reads (x = LED id, y = frame)' }),
        ),
        // where this map stands on the shared clock (the transport's in / out — docs/22-transport-in-out.md)
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, ''), this.frameLabel),
        el('div', { class: 'row fields' }, el('span', { class: 'lbl' }, ''),
          g.num('from column', (x) => x.pixels!.offset, (v) => patch({ offset: Math.max(0, Math.round(v)) }), { step: PIXELS_PER_CHAIN, min: 0, title: 'The map column its first pixel reads — daisy-chained fixtures follow one another' }),
          g.check('reverse', (x) => x.pixels!.reverse, (v) => patch({ reverse: v })),
        ),
        selected.length > 1 ? el('div', { class: 'row' }, btn(`Chain ${selected.length} fixtures`, () => cmd.chainCurvePixels(this.store, selected, px.animation, i), { title: 'Give this layer of each selected curve one block of columns, in selection order' })) : null,
        el('div', { class: 'dim wrap' }, `${pixels} px · columns ${px.offset}–${px.offset + pixels - 1}${mismatch}`),
      );
    }
    return el('div', { class: 'fixture' }, ...rows.filter((r): r is HTMLElement => !!r));
  }

  /** Profile dropdown (docs/14-shapes.md): the project's profiles and "Profile editor…" — for layer `i` of the selected curves (`layers`: that layer of each, the primary's last). */
  private profileField(layers: OutlineLayer[], i: number, selected: Id[]): HTMLSelectElement {
    const EDIT = 'edit:';
    const l = layers[layers.length - 1];
    const current = shared(layers, (x) => x.profileId);
    const { profiles } = this.store.project;
    const have = new Set(profiles.map((p) => p.id));
    // presets and the browser library not in the project yet: picking one copies it in (like a library material)
    const extra = [
      ...PRESET_PROFILES.filter((p) => !have.has(p.id)).map((p) => ({ value: `preset:${p.id}`, label: p.label, group: 'Add preset' })),
      ...shapeLibrary.read().filter((p) => !have.has(p.id)).map((p) => ({ value: `lib:${p.id}`, label: p.label, group: 'Add from library' })),
    ];
    const options = [
      ...profiles.map((p) => ({ value: p.id, label: p.label, group: extra.length ? 'Project' : undefined })),
      ...extra,
      { value: EDIT, label: 'Profile editor…' },
    ];
    const field = selectField(current.value, options, (v) => {
      if (v === EDIT) { field.value = l.profileId; this.openShapes(l.profileId); if (current.mixed) this.render(); return; }
      const source = v.startsWith('preset:') ? PRESET_PROFILES.find((p) => p.id === v.slice(7)) : v.startsWith('lib:') ? shapeLibrary.read().find((p) => p.id === v.slice(4)) : null;
      if (source) { void this.store.transaction(() => cmd.setCurveProfile(this.store, selected, cmd.addProfile(this.store, source), i)); return; }
      cmd.setCurveProfile(this.store, selected, v, i);
    }, { class: 'grow', title: 'The stock this layer is bent from — a profile program (JS → mesh) with its bend limits; presets and the library are added to the project when picked; edit them on the programs page (last entry)', mixed: current.mixed });
    return field;
  }

  /** One number field per profile parameter: the effective value (-- where the selected layers differ); typing overrides it on this layer of the selected curves, ↺ clears the override. */
  private paramFields(layers: OutlineLayer[], profile: Profile, i: number, selected: Id[]): HTMLElement | null {
    const names = Object.keys(profile.params);
    if (!names.length) return null;
    const l = layers[layers.length - 1];
    const f = new Fields(layers);
    return el('div', { class: 'row fields wrap' },
      el('span', { class: 'lbl' }, 'params'),
      ...names.map((k) => {
        const overridden = k in l.params;
        return el('span', { class: `param ${overridden ? 'overridden' : ''}`, title: overridden ? `Overridden on this layer (profile default ${profile.params[k]})` : `Profile default ${profile.params[k]} — type to override on this layer` },
          f.num(k, (x) => (k in x.params ? x.params[k] : profile.params[k]), (v) => cmd.setCurveParams(this.store, selected, { [k]: v }, i), { step: 1 }),
          overridden ? btn('↺', () => cmd.setCurveParams(this.store, selected, { [k]: null }, i), { title: 'Back to the profile default' }) : null,
        );
      }),
    );
  }

  /** Planar / 3D dropdown (docs/12-3d-curves.md) over the selected curves. */
  private typeField(cs: CurveObject[]): HTMLElement {
    const types: { value: CurveType; label: string }[] = [{ value: 'planar', label: 'Planar (2D on the plane)' }, { value: 'spatial', label: '3D (plane + offset along the normal)' }];
    return el('div', { class: 'row' },
      el('span', { class: 'lbl' }, 'type'),
      new Fields(cs).select((c) => c.type, types, (v) => cmd.setCurveType(this.store, cs.map((c) => c.id), v as CurveType), { class: 'grow', title: 'A 3D curve keeps x, y on the plane and lifts vertices along the normal (z). Back to planar flattens it.' }),
    );
  }

  /** Outliner eye: show / hide one object (docs/18-nested-objects.md §4); ◌ dimmed = hidden by an ancestor. */
  private eye(g: ObjectGroup, shownByParent: boolean): HTMLElement {
    return el('span', {
      class: `eye ${g.visible && shownByParent ? '' : 'off'}`,
      title: !shownByParent ? 'Hidden with its parent object' : g.visible ? 'Hide this object and everything in it' : 'Show this object',
      onclick: (e: MouseEvent) => { e.stopPropagation(); cmd.setGroupVisible(this.store, [g.id], !g.visible); },
    }, g.visible ? '👁' : '◌');
  }

  /** Objects the selected objects may be moved into: anything but themselves and their own descendants (no cycles). */
  private parentOptions(gs: ObjectGroup[]): { value: string; label: string }[] {
    const { project } = this.store;
    const depth = (x: ObjectGroup) => groupChain(project, x.id).length - 1;
    return [
      { value: '', label: '— none (top level) —' },
      ...project.groups.filter((x) => gs.every((g) => x.id !== g.id && !wouldCycle(project, g.id, x.id))).map((x) => ({ value: x.id, label: `${'· '.repeat(depth(x))}${x.name}` })),
    ];
  }

  /** The selected objects' properties (docs/18, several at once docs/35 §4): name, parent, own frame, and what ⌘G, the gizmo and the buttons act on. */
  private groupSection(gs: ObjectGroup[]): HTMLElement {
    const { project } = this.store;
    const g = gs[gs.length - 1], ids = gs.map((x) => x.id), several = gs.length > 1, f = new Fields(gs);
    const lofts = gs.flatMap((x) => loftsOfGroup(project, x));
    const planes = gs.flatMap((x) => subtreeGroups(project, x).flatMap((y) => y.planes));
    const curves = project.curves.filter((c) => planes.includes(c.planeId));
    const kids = gs.flatMap((x) => childGroups(project, x));
    const hiddenAbove = gs.some((x) => !groupVisible(project, parentOfGroup(project, x.id)?.id ?? null));
    const anyVisible = gs.some((x) => x.visible);
    return section(several ? `${gs.length} objects` : `Object · ${g.name}`,
      several ? el('div', { class: 'dim' }, gs.map((x) => x.name).join(' · ')) : null,
      this.nameRow(f, 'Object name', (v) => cmd.renameGroup(this.store, ids, v)),
      el('div', { class: 'row' },
        el('span', { class: 'lbl' }, 'parent'),
        f.select((x) => parentOfGroup(project, x.id)?.id ?? '', this.parentOptions(gs), (v) => cmd.setGroupParent(this.store, ids, v || null), { class: 'grow', title: 'The object this one sits inside; it keeps its place in 3D' }),
      ),
      // the object's own frame: everything inside is placed relative to it (docs/18-nested-objects.md §2)
      this.vec('pos mm', f, (x) => x.placement.position, 10, (patch) => cmd.setGroupPlacement(this.store, ids, { position: patch })),
      this.vec('rot °', f, (x) => x.placement.rotation, 5, (patch) => cmd.setGroupPlacement(this.store, ids, { rotation: patch })),
      el('div', { class: 'dim' }, `${kids.length ? `${kids.length} object${kids.length === 1 ? '' : 's'} · ` : ''}${planes.length} planes · ${curves.length} curves · ${lofts.length} lofts${hiddenAbove ? (several ? ' · some hidden with their parent' : ' · hidden with its parent') : ''}`),
      el('div', { class: 'row wrap', style: 'margin-top:6px' },
        several ? btn('Group ⌘G', () => cmd.groupSelection(this.store), { title: 'Make one object holding all of them' }) : null,
        btn(anyVisible ? 'Hide' : 'Show', () => cmd.setGroupVisible(this.store, ids, !anyVisible), { title: 'Leave the object out of the viewport, the lighting and picking' }),
        btn('Duplicate ⌘D', () => { if (several) cmd.duplicateSelection(this.store); else cmd.duplicateGroup(this.store, g.id); }),
        several ? null : btn('Ungroup', () => cmd.ungroup(this.store, g.id), { title: 'Dissolve the object; its planes and child objects move up' }),
        btn('Delete…', () => deleteGroupsAsked(this.store, ids), { class: 'danger', title: several ? 'Delete the objects — asks whether to take their contents with them or explode them' : 'Delete the object — asks whether to take its contents with it or explode it' }),
      ),
      several ? this.sharedHint(gs.length, 'objects', 'The gizmo moves and rotates each of them about the common centre.') : null,
      el('div', { class: 'hint', title: 'Drag any curve of the object to move it as a whole; the gizmo (W/E) moves and rotates its own frame, R scales the contents. ⌘-click objects in the outliner and ⌘G to nest them.' }, 'W / E move and rotate the frame, R scales the contents, ⌘G nests.'),
    );
  }

  /** The selected lofts' properties (docs/05, docs/24; several at once docs/35 §4), the primary last. */
  private loftSection(ls: Loft[]): HTMLElement {
    const l = ls[ls.length - 1], ids = ls.map((x) => x.id), several = ls.length > 1, f = new Fields(ls);
    const curves = this.store.project.curves.map((c) => ({ value: c.id, label: `${c.name} (${this.store.planeOf(c).name})` }));
    const material = f.of((x) => x.materialId);
    return section(several ? `${ls.length} lofts` : `Loft · ${l.name}`,
      several ? el('div', { class: 'dim' }, ls.map((x) => x.name).join(' · ')) : null,
      this.nameRow(f, 'Loft name', (v) => cmd.updateLoft(this.store, ids, { name: v })),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'curve A'), f.select((x) => x.a, curves, (v) => cmd.updateLoft(this.store, ids, { a: v }), { class: 'grow' })),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'curve B'), f.select((x) => x.b, curves, (v) => cmd.updateLoft(this.store, ids, { b: v }), { class: 'grow' })),
      this.materialField(material.value, 'Checkerboard 100 mm (default)', (id) => cmd.setLoftMaterial(this.store, ids, id), undefined, material.mixed),
      el('div', { class: 'row fields' },
        f.num('resolution ×', (x) => x.resolution, (v) => cmd.updateLoft(this.store, ids, { resolution: Math.max(1, v) }), { step: 1, min: 1, title: 'Samples along = resolution × max vertex count' }),
        f.num('strips', (x) => x.strips, (v) => cmd.updateLoft(this.store, ids, { strips: Math.max(1, Math.round(v)) }), { step: 1, min: 1 }),
        f.check('flip', (x) => x.flip, (v) => cmd.updateLoft(this.store, ids, { flip: v })),
      ),
      // one parameter per row — the names are longer than x / y / z (docs/25-number-fields.md §2)
      ...(['a', 'b'] as const).flatMap((which) => {
        const e = (x: Loft) => loftEdge(x, which);
        const set = (patch: Partial<LoftEdge>) => cmd.setLoftEdge(this.store, ids, which, patch);
        const w = which.toUpperCase();
        return [
          f.row(`${w} trim start`, (x) => e(x).start, (v) => set({ start: v }), { step: 10, title: 'mm cut off the start of the curve — negative goes past it, straight along the end tangent' }),
          f.row(`${w} trim end`, (x) => e(x).end, (v) => set({ end: v }), { step: 10, title: 'mm cut off the end of the curve — negative goes past it' }),
          f.row(`${w} offset`, (x) => e(x).offset, (v) => set({ offset: v }), { step: 10, title: 'mm across the ruling, in the surface: + outwards (away from the other curve), − inwards' }),
          f.row(`${w} lift`, (x) => e(x).lift, (v) => set({ lift: v }), { step: 10, title: 'mm along the loft\u2019s normal, out of the surface: + out of its front, − behind it' }),
        ];
      }),
      several ? this.sharedHint(ls.length, 'lofts') : null,
      el('div', { class: 'hint', title: 'Both curves are resampled by arc length; sample i of A is joined to sample i of B. The checkerboard squares are 100 mm of surface (uv in mm). Flip reverses B if the rulings cross.' }, 'Sample i of A meets sample i of B; flip if the rulings cross.'),
    );
  }

  /** The selected shapes (docs/30-outline-and-shape-layers.md §4; several at once docs/35 §4): the primary's curves (structure, one shape only), the shared outline values and the fill layers by index. */
  private shapeSection(shs: Shape[]): HTMLElement {
    const { project } = this.store;
    const sh = shs[shs.length - 1], ids = shs.map((x) => x.id), several = shs.length > 1, f = new Fields(shs);
    const curves = sh.curves.map((id) => project.curves.find((c) => c.id === id)).filter((c): c is CurveObject => !!c);
    const planeId = curves[0]?.planeId ?? null;
    const plane = planeId ? project.planes.find((p) => p.id === planeId) ?? null : null;
    const set = (patch: Parameters<typeof cmd.updateShape>[2]) => cmd.updateShape(this.store, ids, patch);
    const one = (patch: Parameters<typeof cmd.updateShape>[2]) => cmd.updateShape(this.store, sh.id, patch);
    const others = project.curves.filter((c) => c.planeId === planeId && !sh.curves.includes(c.id)).map((c) => ({ value: c.id, label: c.name }));
    return section(several ? `${shs.length} shapes` : `Shape · ${sh.name}`,
      several ? el('div', { class: 'dim' }, shs.map((x) => x.name).join(' · ')) : null,
      this.nameRow(f, 'Shape name', (v) => set({ name: v })),
      several ? null : subTitle(`Curves${plane ? ` · on ${plane.name}` : ''}`, others.length ? selectField('', [{ value: '', label: '＋ add…' }, ...others], (v) => { if (v) one({ curves: [...sh.curves, v] }); }, { class: 'mini-select', title: 'Add a curve of this plane: its loop joins the outline; a loop inside another one is a hole' }) : null),
      several ? null : el('div', { class: 'chips' }, ...curves.map((c) => el('span', { class: 'chip', title: c.planeId !== planeId ? 'On another plane — skipped' : c.curve.closed ? 'Closed loop' : 'Open: closed by a straight chord' },
        el('span', {}, `${c.name}${c.planeId !== planeId ? ' ⚠' : c.curve.closed ? '' : ' ⌒'}`),
        sh.curves.length > 1 ? el('span', { class: 'x', title: 'Take this curve out of the shape', onclick: () => one({ curves: sh.curves.filter((id) => id !== c.id) }) }, '×') : null,
      ))),
      el('div', { class: 'row fields' },
        el('span', { class: 'lbl' }, 'outline'),
        f.num('expand', (x) => x.expand, (v) => set({ expand: v }), { step: 10, title: 'mm in the plane: + every loop bigger than its curve, − smaller; sides slide out, corners mitre' }),
        f.num('res ×', (x) => x.resolution, (v) => set({ resolution: Math.max(0.25, v) }), { step: 0.5, min: 0.25, title: 'Boundary samples per curve segment = 4 × resolution; every vertex is always on the boundary' }),
      ),
      subTitle(`Layers · ${sh.layers.length}`, btn('＋ Layer', () => this.store.batch(() => { for (const id of ids) cmd.addShapeLayer(this.store, id); }), { title: 'Add a fill layer on top: the sheet, a net, bubbles — change it in the dropdown' })),
      ...sh.layers.map((l, i) => this.shapeLayer(shs, l, i)),
      !sh.layers.length ? el('div', { class: 'hint' }, 'No layers: nothing is drawn. ＋ Layer adds the sheet.') : null,
      several ? this.sharedHint(shs.length, 'shapes', 'A layer is the same-numbered layer of each shape; the curves of a shape are edited one shape at a time.') : null,
    );
  }

  /** One fill layer of a shape (docs/30 §4) as a card: head with the fill, body with offset, material and params — layer `i` of every selected shape (docs/35 §4). */
  private shapeLayer(shs: Shape[], l: ShapeLayer, i: number): HTMLElement {
    const { project } = this.store;
    const sh = shs[shs.length - 1], ids = shs.map((x) => x.id);
    const layers = shs.map((x) => x.layers[i]).filter((x): x is ShapeLayer => !!x);   // the primary's is last
    const f = new Fields(layers);
    const fill = fillOf(project, l);
    const up = (patch: Parameters<typeof cmd.updateShapeLayer>[3]) => cmd.updateShapeLayers(this.store, ids, i, patch);
    const fillId = f.of((x) => x.fillId);
    const EDIT = 'edit:';
    const have = new Set(project.fills.map((f) => f.id));
    // presets and the browser library not in the project yet: picking one copies it in
    const extra = [
      ...PRESET_FILLS.filter((f) => !have.has(f.id)).map((f) => ({ value: `preset:${f.id}`, label: f.label, group: 'Add preset' })),
      ...fillLibrary.read().filter((f) => !have.has(f.id)).map((f) => ({ value: `lib:${f.id}`, label: f.label, group: 'Add from library' })),
    ];
    const options = [
      ...project.fills.map((f) => ({ value: f.id, label: f.label, group: extra.length ? 'Project' : undefined })),
      ...extra,
      { value: EDIT, label: 'Fill editor…' },
    ];
    const field = selectField(fillId.value, options, (v) => {
      if (v === EDIT) { field.value = l.fillId; this.openShapes(`fill:${l.fillId}`); if (fillId.mixed) this.render(); return; }
      const source = v.startsWith('preset:') ? PRESET_FILLS.find((x) => x.id === v.slice(7)) : v.startsWith('lib:') ? fillLibrary.read().find((x) => x.id === v.slice(4)) : null;
      if (source) { void this.store.transaction(() => up({ fillId: cmd.addFill(this.store, source) })); return; }
      up({ fillId: v });
    }, { class: 'grow', title: 'The fill program this layer runs over the surface; presets and the library are added to the project when picked; edit them on the programs page (last entry)', mixed: fillId.mixed });
    const names = fill ? Object.keys(fill.params) : [];
    const key = `${sh.id}/${l.id}`;
    const folded = this.foldedLayers.has(key);
    const material = f.of((x) => x.materialId);
    const body = folded ? null : el('div', { class: 'layer-body' },
      f.row('offset', (x) => x.offset, (v) => up({ offset: v }), { step: 10, title: 'mm along the plane normal: + in front of the curves, − behind them' }),
      this.materialField(material.value, 'Colour (default)', (id) => up({ materialId: id }), { color: l.color, base: fill?.color ?? '#d8d8dc', onColor: (hex) => up({ color: hex }), mixed: f.of((x) => x.color).mixed }, material.mixed),
      fill && names.length ? el('div', { class: 'row fields wrap' },
        el('span', { class: 'lbl' }, 'params'),
        ...names.map((k) => {
          const overridden = k in l.params;
          return el('span', { class: `param ${overridden ? 'overridden' : ''}`, title: overridden ? `Overridden on this layer (fill default ${fill.params[k]})` : `Fill default ${fill.params[k]} — type to override on this layer` },
            f.num(k, (x) => (k in x.params ? x.params[k] : fill.params[k]), (v) => up({ params: { [k]: v } }), { step: 1 }),
            overridden ? btn('↺', () => up({ params: { [k]: null } }), { title: 'Back to the fill default' }) : null,
          );
        }),
      ) : null,
    );
    return el('div', { class: `layer ${l.visible ? '' : 'off'}` },
      this.layerHead(key, folded, l.visible, () => up({ visible: !l.visible }), i, sh.layers.length, field,
        [l.color || (fill && fill.color !== CHECKER_COLOR) ? swatch(l.color ?? fill!.color) : null, l.offset ? el('span', { class: 'dim' }, `↑${l.offset}`) : null],
        (to) => cmd.moveShapeLayers(this.store, ids, i, to),
        () => cmd.removeShapeLayers(this.store, ids, i),
      ),
      body,
    );
  }

  // -- edit mode -----------------------------------------------------------------

  private editHeader(c: CurveObject): HTMLElement {
    const sel = this.store.selection.vertices;
    return el('section', { class: 'sec edit-head' },
      el('div', { class: 'row' },
        el('span', { class: 'mode-badge edit' }, 'EDIT'),
        textField(c.name, (v) => cmd.renameCurve(this.store, c.id, v), { class: 'grow name' }),
        btn('Break  B', () => { if (sel.length) cmd.breakApart(this.store, c.id, sel); }, { title: 'Break the curve at the selected vertices into separate curves' }),
        btn('Done  ⇥', () => cmd.exitEdit(this.store), { class: 'primary', title: 'Back to Object mode (Tab / Esc)' }),
      ),
    );
  }

  private constraints(c: CurveObject): HTMLElement {
    const ev = this.store.evals.get(c.id)!;
    // one block per outline layer (docs/30 §3): its profile and the limits checked on its own curve
    const layers = ev.layers.map((le, i) => {
      const statuses = limitStatuses(le.profile, le.sampling, le.violations);
      return el('div', { class: 'layer' },
        el('div', { class: 'layer-head' }, el('span', { class: 'idx' }, String(i + 1)), this.profileField([le.layer], i, [c.id]), swatch(le.profile.color), badge(le.violations.length, '#ff5c5c')),
        el('div', { class: 'layer-body limits' },
          ...statuses.map((s) => el('div', { class: `limit ${s.ok ? 'ok' : 'bad'}`, title: s.hint },
            el('span', { class: 'dot', style: `background:${s.color}` }),
            el('span', { class: 'limit-label' }, s.label),
            numField('', s.limit, (v) => cmd.setLimit(this.store, le.profile.id, s.id, v), { step: 5, min: 0 }),
            el('span', { class: 'unit' }, s.unit),
            el('span', { class: 'status' }, s.ok ? '✓' : '✗'),
            el('span', { class: 'detail' }, s.detail),
          )),
        ),
      );
    });
    return section('Constraints',
      ...layers,
      layers.length ? null : el('div', { class: 'hint' }, 'A construction line: no profile, nothing to check.'),
      subTitle('Vertex constraints'),
      ...this.vertexConstraints(c),
    );
  }

  private vertexConstraints(c: CurveObject): HTMLElement[] {
    const ev = this.store.evals.get(c.id)!;
    const num = (vid?: string) => { const i = c.curve.points.findIndex((v) => v.id === vid); return i < 0 ? '?' : String(i + 1); };
    const glyph: Record<string, string> = { horizontal: '—', vertical: '|', distance: '↔', pin: '⌖' };
    const label: Record<string, string> = { horizontal: 'Keep horizontal', vertical: 'Keep vertical', distance: 'Distance', pin: 'Pinned' };
    const rows = c.constraints.map((k) => {
      const ok = ev.constraints.get(k.id) !== false;
      return el('div', { class: `vc ${ok ? 'ok' : 'bad'}`, title: ok ? '' : 'Cannot be satisfied together with the other constraints' },
        el('span', { class: 'glyph' }, glyph[k.type]),
        el('span', {}, label[k.type]),
        el('span', { class: 'who' }, k.type === 'pin' ? `v${num(k.a)}` : `v${num(k.a)} · v${num(k.b)}`),
        k.type === 'distance' ? numField('', k.value ?? 0, (v) => cmd.setConstraintValue(this.store, c.id, k.id, v), { step: 5, min: 0 }) : el('span'),
        el('span', { class: 'status' }, ok ? '✓' : '✗'),
        btn('×', () => cmd.removeConstraint(this.store, c.id, k.id), { title: 'Remove' }),
      );
    });
    const sel = this.store.selection.vertices;
    const two = sel.length === 2;
    return [
      ...rows,
      el('div', { class: 'row', style: 'margin-top:4px' },
        btn('— H', () => { if (two) cmd.addConstraint(this.store, c.id, 'horizontal', sel[0], sel[1]); }, { title: 'Keep horizontal (H) – select 2 vertices' }),
        btn('| V', () => { if (two) cmd.addConstraint(this.store, c.id, 'vertical', sel[0], sel[1]); }, { title: 'Keep vertical (⇧V) – select 2 vertices' }),
        btn('↔ D', () => { if (two) cmd.addConstraint(this.store, c.id, 'distance', sel[0], sel[1]); }, { title: 'Keep distance (D) – select 2 vertices' }),
        btn('⌖ Pin', () => { if (sel.length) cmd.togglePin(this.store, c.id, sel[sel.length - 1]); }, { title: 'Pin / unpin the selected vertex (P)' }),
        el('span', { class: 'dim grow' }, two ? `v${num(sel[0])} → v${num(sel[1])}` : sel.length ? `${sel.length > 1 ? sel.length + ' vertices' : 'v' + num(sel[0])} selected` : 'Shift-click 2 vertices'),
      ),
      ...(rows.length ? [] : [el('div', { class: 'hint' }, 'The first selected vertex stays, the second one follows.')]),
    ];
  }

  private curveInfo(c: CurveObject): HTMLElement {
    const ev = this.store.evals.get(c.id)!;
    const n = c.curve.points.length;
    const sel = this.store.selection.vertices;
    const primary = c.curve.points.find((v) => v.id === this.store.primaryVertex);
    const types: { value: VertexType; label: string }[] = [{ value: 'polygon', label: 'Polygon' }, { value: 'equal', label: 'Equal' }, { value: 'free', label: 'Free' }];
    return section('Curve',
      el('div', { class: 'row' },
        el('span', { class: 'dim' }, `${n} vertices · ${ev.sampling.length.toFixed(0)} mm · ${this.store.planeOf(c).name}`),
        el('span', { class: 'grow' }),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: c.curve.closed, disabled: n < 3, onchange: () => cmd.toggleClosed(this.store, c.id) }), 'closed'),
      ),
      el('div', { class: 'row' },
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: this.store.state.snap, onchange: () => cmd.toggleSnap(this.store) }), 'grid 10 mm'),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: this.store.state.alignSnap, onchange: () => cmd.toggleAlignSnap(this.store) }), 'align to vertices'),
      ),
      this.typeField([c]),
      primary ? el('div', { class: 'row' },
        el('span', { class: 'lbl' }, sel.length > 1 ? `${sel.length} vertices` : `vertex ${c.curve.points.indexOf(primary) + 1}`),
        selectField(primary.type, types, (v) => cmd.setVertexType(this.store, c.id, sel, v as VertexType), { class: 'grow', title: 'Handle type (V cycles)' }),
      ) : null,
      primary ? el('div', { class: 'row fields' },
        el('span', { class: 'lbl' }, 'mm'),
        numField('x', primary.x, (v) => cmd.moveVertices(this.store, c.id, [{ vid: primary.id, p: { x: v } }], false), { step: 10 }),
        numField('y', primary.y, (v) => cmd.moveVertices(this.store, c.id, [{ vid: primary.id, p: { y: v } }], false), { step: 10 }),
        c.type === 'spatial' ? numField('z', primary.z, (v) => cmd.moveVertices(this.store, c.id, [{ vid: primary.id, p: { z: v } }], false), { step: 10, title: 'Offset along the plane normal' }) : null,
      ) : null,
      el('div', { class: 'hint' }, `Click the plane to add a vertex · click the curve to insert · drag a box to select several · ⌘A all · drag moves the selection · Shift-click adds · right-click for types, constraints and Break · V handle type · B break · Del delete · Shift while dragging = no snap.${c.type === 'spatial' ? ' 3D: Alt-drag a vertex (or the gizmo\'s Z arrow — tilt the view with the cube) moves it along the plane normal.' : ''}`),
    );
  }

  // -- both ------------------------------------------------------------------------

  /**
   * The plane's reference image (docs/19-reference-image.md): the drawing that is traced over.
   * Locked is the normal state — a locked image cannot be picked, dragged or selected.
   */
  private imageSection(p: Plane): HTMLElement {
    const img = p.image;
    const set = (patch: Parameters<typeof cmd.setPlaneImage>[2]) => cmd.setPlaneImage(this.store, p.id, patch);
    const images = this.store.project.textures.filter((t) => isImageMime(t.mime) && !isHdrMime(t.mime));
    const picker = selectField(img?.texture ?? '', [
      { value: '', label: img ? '— remove —' : '— none —' },
      ...images.map((t) => ({ value: t.id, label: t.name })),
    ], (v) => set(v ? { texture: v } : null), { class: 'grow', title: 'A project image to lie on this plane and trace over' });
    const rows: (HTMLElement | null)[] = [
      el('div', { class: 'row' },
        el('span', { class: 'lbl' }, 'image'),
        picker,
        btn('Add…', () => this.pickPlaneImage(p.id), { title: 'Load an image file (it becomes a project texture) and put it on this plane' }),
      ),
    ];
    if (img) {
      const t = this.store.project.textures.find((x) => x.id === img.texture);
      rows.push(
        el('div', { class: 'row wrap' },
          btn(img.visible ? '👁 shown' : '👁 hidden', () => set({ visible: !img.visible }), { active: img.visible, title: 'Show or hide the image' }),
          btn(img.locked ? '🔒 locked' : '🔓 unlocked', () => set({ locked: !img.locked }), { active: img.locked, title: img.locked ? 'Locked: clicks go straight through it — unlock to move or scale it in the viewport' : 'Unlocked: drag it to move, drag a corner to scale. Lock it before drawing over it' }),
          btn('Set scale…', () => this.viewer.calibrateImage(p.id), { class: 'primary', title: 'Click two points on the image, then type how far apart they really are (mm)' }),
        ),
        el('div', { class: 'row fields' },
          numField('opacity', img.opacity, (v) => set({ opacity: v }), { step: 0.05, min: 0 }),
          numField('width mm', img.width, (v) => set({ width: v }), { step: 10, min: 1 }),
          numField('rot °', img.rotation, (v) => set({ rotation: v }), { step: 5 }),
        ),
        el('div', { class: 'row fields' },
          numField('cx mm', img.center.x, (v) => set({ center: { ...img.center, x: v } }), { step: 10 }),
          numField('cy mm', img.center.y, (v) => set({ center: { ...img.center, y: v } }), { step: 10 }),
        ),
        el('div', { class: 'dim' }, `${t?.name ?? img.texture} · ${t?.width ?? '?'}×${t?.height ?? '?'} px · ${Math.round(img.width)}×${Math.round(img.width * (t && t.width && t.height ? t.height / t.width : 1))} mm`),
        el('div', { class: 'hint' }, img.locked
          ? 'Locked, so drawing over it cannot disturb it. Unlock to move it (drag) or scale it (drag a corner).'
          : 'Drag the image to move it, drag a corner to scale it about the opposite one. Lock it once it sits right.'),
      );
    } else {
      rows.push(el('div', { class: 'hint' }, 'Put a drawing on this plane and trace the shapes over it. Add an image here, or drop an image file on the viewport while this plane is active.'));
    }
    return section(`Reference image · ${p.name}`, ...rows.filter((x): x is HTMLElement => !!x));
  }

  /** Load an image file into the project and put it on the plane. */
  private pickPlaneImage(planeId: Id): void {
    const input = el('input', { type: 'file', accept: IMAGE_ACCEPT, onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      textureFromFile(f)
        .then((t) => this.store.transaction(() => cmd.setPlaneImage(this.store, planeId, { texture: cmd.addTexture(this.store, t) })))
        .catch((err) => alert(err instanceof Error ? err.message : String(err)));
    } });
    input.click();
  }

  private modifier(p: Plane): HTMLElement {
    const set = (mod: ArrayModifier | null, live = false) => cmd.setPlaneModifier(this.store, p.id, mod, live);
    const kind = p.array?.type ?? 'none';
    const picked = this.store.selection.arrayHandle;
    /** the button that hands the gizmo this handle (docs/26-array.md §3) — the plane has to be the selected thing */
    const grab = (h: ArrayHandle, title: string) => btn('◇', () => {
      if (!this.store.selection.planeSelected || this.store.selection.planeId !== p.id) cmd.selectPlane(this.store, p.id);
      cmd.selectArrayHandle(this.store, picked === h ? null : h);
    }, { title, active: picked === h });
    const rows: HTMLElement[] = [
      el('div', { class: 'row' },
        el('span', { class: 'lbl' }, 'array'),
        selectField(kind, [{ value: 'none', label: 'None' }, { value: 'linear', label: 'Linear' }, { value: 'circular', label: 'Circular' }], (v) => {
          if (v === 'none') set(null);
          else if (v === 'linear') set({ type: 'linear', count: 3, offset: { x: 300, y: 0, z: 0 } });
          else set({ type: 'circular', count: 6, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, angle: 360 });
        }, { class: 'grow' }),
      ),
    ];
    const a = p.array;
    if (a?.type === 'linear') {
      rows.push(
        numRow('count', a.count, (v) => set({ ...a, count: Math.max(1, Math.round(v)) }), { min: 1 }),
        el('div', { class: 'row fields' },
          el('span', { class: 'lbl' }, 'offset'),
          numField('x', a.offset.x, (v) => set({ ...a, offset: { ...a.offset, x: v } }), { step: 10 }),
          numField('y', a.offset.y, (v) => set({ ...a, offset: { ...a.offset, y: v } }), { step: 10 }),
          numField('z', a.offset.z, (v) => set({ ...a, offset: { ...a.offset, z: v } }), { step: 10 }),
          grab('offset', 'Drag the offset in the viewport'),
        ),
        el('div', { class: 'hint' }, 'Repeats everything on the plane. Offset per copy in plane coordinates (z = along the normal) — ◇ puts the gizmo on it.'),
      );
    } else if (a?.type === 'circular') {
      rows.push(
        el('div', { class: 'row fields' },
          el('span', { class: 'lbl' }, 'count'),
          numField('copies', a.count, (v) => set({ ...a, count: Math.max(1, Math.round(v)) }), { min: 1 }),
          numField('angle °', a.angle, (v) => set({ ...a, angle: v }), { step: 15 }),
        ),
        el('div', { class: 'row fields' },
          el('span', { class: 'lbl' }, 'axis at'),
          numField('x', a.center.x, (v) => set({ ...a, center: { ...a.center, x: v } }), { step: 10 }),
          numField('y', a.center.y, (v) => set({ ...a, center: { ...a.center, y: v } }), { step: 10 }),
          numField('z', a.center.z, (v) => set({ ...a, center: { ...a.center, z: v } }), { step: 10 }),
          grab('center', 'Drag the axis point in the viewport'),
        ),
        el('div', { class: 'row fields' },
          el('span', { class: 'lbl' }, 'axis up'),
          numField('x', a.axis.x, (v) => set({ ...a, axis: { ...a.axis, x: v } }), { step: 0.1 }),
          numField('y', a.axis.y, (v) => set({ ...a, axis: { ...a.axis, y: v } }), { step: 0.1 }),
          numField('z', a.axis.z, (v) => set({ ...a, axis: { ...a.axis, z: v } }), { step: 0.1 }),
          grab('axis', 'Aim the axis in the viewport'),
        ),
        el('div', { class: 'hint' }, 'Repeats everything on the plane about the line through the axis point (plane coordinates, z = along the normal). Up (0, 0, 1) is the plane normal — ◇ puts the gizmo on a handle.'),
      );
    }
    if (a) rows.push(...this.commitRows(p, a));
    return section(`Modifier · ${p.name}`, ...rows);
  }

  /** Commit: bake the copies into curves, welding ends closer than `merge` (docs/26-array.md §4). */
  private commitRows(p: Plane, a: ArrayModifier): HTMLElement[] {
    const mine = this.store.project.curves.filter((c) => c.planeId === p.id);
    const copies = Math.min(200, Math.max(1, Math.round(a.count)));
    const total = copies * mine.length;
    // welding every copy is too slow to redo on every keystroke of a big array; then only the count before welding is shown
    const exact = total <= 200;
    let count = total;
    if (exact) { try { count = commitArray(a, mine, this.merge).length; } catch { count = total; } }
    return [
      el('div', { class: 'row fields' },
        el('span', { class: 'lbl' }, 'merge'),
        numField('mm', this.merge, (v) => { this.merge = Math.max(0, v); this.render(); }, { step: 0.5, min: 0, title: 'Ends closer than this weld into one curve when the array is committed' }),
        btn('Commit', () => { cmd.commitArray(this.store, p.id, { merge: this.merge }); }, { title: 'Bake the copies into editable curve objects and drop the modifier' }),
      ),
      el('div', { class: 'dim' }, `${copies} cop${copies === 1 ? 'y' : 'ies'} × ${mine.length} curve${mine.length === 1 ? '' : 's'} → ${count} curve${count === 1 ? '' : 's'}${exact ? '' : ' before welding'}`),
    ];
  }
}
