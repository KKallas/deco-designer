/**
 * The right-hand toolbar rail (docs/23-toolbar-rails.md): framing, the selection
 * filter of Part 8 and the render view, in three coloured sections — what used
 * to be the bar across the top of the viewport (docs/20-viewport-status-bar.md).
 * The selection text stays a floating label at the top-left: it only says
 * things, selection is made in the viewport and the outliner.
 */
import type { Store } from '../app/store';
import { findGroup, type Id } from '../model/types';
import { PICK_LEVELS, type PickLevel } from '../model/pick';
import { el } from './dom';
import { renderRail, type RailItem, type RailPrefs, type RailSection } from './rails';

/** What the bar needs of the viewer (docs/20 §3). */
export interface ViewBarHost {
  pickFilter: Record<PickLevel, boolean>;
  togglePickLevel(level: PickLevel): void;
  frameSelection(): void;
  framePlane(): void;
  fit(): void;
  alignToPlane(animate?: boolean): void;
  /** render the camera frame at full quality and download it (docs/32-render-on-demand.md) */
  saveStill(): void;
}

/** The post-processing script: looked at in the viewport (✦) and edited in the panel (docs/15-camera.md). */
export interface PostControls {
  enabled: () => boolean;
  toggle: () => void;
  edit: () => void;
}

/** The same icons as the outliner rows: curve ○, surface ◫ (lofts and panels), plane ▤, object ▣. */
const LEVELS: Record<PickLevel, { icon: string; label: string; title: string }> = {
  curve: { icon: '○', label: 'Curve', title: 'Curve: clicks may select curves (1)' },
  loft: { icon: '◫', label: 'Surface', title: 'Surface: clicks may select lofts and panels (2)' },
  plane: { icon: '▤', label: 'Plane', title: 'Plane: clicks may select planes — a curve hit selects its plane when Curve is off (3)' },
  object: { icon: '▣', label: 'Object', title: 'Object: clicks may select objects — a curve or surface hit selects its object when the lower levels are off (4)' },
};

/** The status text: the lowest selected thing wins, worded like the outliner. */
export function selectionText(store: Store): string {
  const { project, mode, selection } = store.state;
  if (mode.kind === 'edit') {
    const c = store.editingCurve();
    if (!c) return 'Edit';
    const n = c.curve.points.length;
    const sel = selection.vertices.length;
    return `Edit · ${c.name} · ${sel ? `${sel} / ${n}` : n} point${n === 1 && !sel ? '' : 's'}`;
  }
  if (selection.groups.length) {
    const g = findGroup(project, selection.groups[0]);
    return selection.groups.length > 1 ? `${selection.groups.length} objects` : g?.name ?? 'Object';
  }
  if (selection.planes.length > 1) return `${selection.planes.length} planes`;
  if (selection.planeSelected && selection.planeId) {
    const p = project.planes.find((x) => x.id === selection.planeId);
    return `Plane · ${p?.name ?? selection.planeId}`;
  }
  if (selection.lofts.length > 1) return `${selection.lofts.length} lofts`;
  if (selection.loftId) {
    const l = project.lofts.find((x) => x.id === selection.loftId);
    return `Loft · ${l?.name ?? selection.loftId}`;
  }
  if (selection.shapes.length > 1) return `${selection.shapes.length} shapes`;
  if (selection.shapeId) {
    const p = project.shapes.find((x) => x.id === selection.shapeId);
    return `Shape · ${p?.name ?? selection.shapeId}`;
  }
  if (selection.curves.length) {
    const curves = selection.curves.map((id) => project.curves.find((c) => c.id === id)).filter((c) => !!c);
    const what = curves.length === 1 ? curves[0].name : `${selection.curves.length} curves`;
    const planes = new Set<Id>(curves.map((c) => c.planeId));
    const plane = planes.size === 1 ? project.planes.find((p) => p.id === [...planes][0]) : null;
    return plane ? `${what} · ${plane.name}` : what;
  }
  if (selection.cameras.length > 1) return `${selection.cameras.length} cameras`;
  if (selection.cameraId) {
    const c = project.cameras.find((x) => x.id === selection.cameraId);
    return `Camera · ${c?.name ?? selection.cameraId}`;
  }
  return 'Nothing selected';
}

export class ViewRail {
  /** The right rail itself — the left one is built in main.ts from the same widget. */
  readonly root = el('div', { class: 'rail right' });
  /** What is selected, floating at the top-left of the viewport. */
  readonly label = el('div', { class: 'view-label' });

  constructor(private store: Store, private host: () => ViewBarHost | null, private post: PostControls, private prefs: RailPrefs) {}

  /** The three sections; `key` picks the section's colour in the stylesheet. */
  private sections(): RailSection[] {
    const view = this.host();
    const plane = this.store.activePlane();
    const filter = view?.pickFilter;
    const posting = this.store.state.mode.kind === 'post';
    const frame: RailItem[] = [
      { icon: '⊙', label: 'Selected', title: 'Frame the selection: pivot on it and zoom to its extents (.)', onclick: () => view?.frameSelection() },
      { icon: '▤', label: 'Plane', title: plane ? `Frame everything on plane "${plane.name}"` : 'Frame the active plane', onclick: () => view?.framePlane() },
      { icon: '⛶', label: 'All', title: 'Frame everything (F)', onclick: () => view?.fit() },
      { icon: '⊥', label: 'Plane view', title: plane ? `Look straight at plane "${plane.name}" (Home)` : 'Look straight at the active plane (Home)', onclick: () => view?.alignToPlane(true) },
    ];
    return [
      { key: 'frame', label: 'Frame', items: frame },
      // selection filter (docs/08): which levels a click may select
      { key: 'select', label: 'Select', items: PICK_LEVELS.map((l) => ({
        icon: LEVELS[l].icon, label: LEVELS[l].label, title: LEVELS[l].title,
        onclick: () => view?.togglePickLevel(l), active: !!filter?.[l], class: filter?.[l] ? '' : 'off',
      })) },
      // the render view: the post script on / off, and its editor
      { key: 'render', label: 'Render', items: [
        { icon: '✦', label: 'Post', title: 'Render view: the post-processing script on / off (off = the plain render)', onclick: () => this.post.toggle(), active: this.post.enabled() },
        { icon: '⚙', label: 'Edit post', title: 'Edit the post-processing script in the panel; the viewport previews the draft until you commit', onclick: () => this.post.edit(), active: posting },
        { icon: '⧉', label: 'Still', title: 'Render the camera frame (an orthographic view: the viewport) 3840 px wide through the post script, without helpers, and download the PNG', onclick: () => view?.saveStill() },
      ] },
    ];
  }

  render(): void {
    const text = selectionText(this.store);
    this.label.textContent = text;
    this.label.className = `view-label ${text === 'Nothing selected' ? 'dim' : ''}`;
    this.label.title = 'What is selected — the lowest selected level wins';
    renderRail(this.root, this.sections(), this.prefs, 'right');
  }
}
