import { el, btn } from './dom';
import type { Store } from '../app/store';
import * as cmd from '../app/commands';
import { findCurve, findGroup, groupChain, groupOfPlane, subtreeGroups, subtreePlanes, type Id, type ObjectGroup, type Plane, type Project } from '../model/types';

export interface Choice { label: string; title?: string; class?: string; onPick: () => void }

let current: HTMLElement | null = null;
let release: (() => void) | null = null;

export function closeAsk(): void {
  release?.();
  release = null;
  current?.remove();
  current = null;
}

/** A small modal question in the middle of the window: one line, a row of choices, Escape cancels. */
export function askChoice(title: string, message: string, choices: Choice[]): void {
  closeAsk();
  const pick = (c: Choice) => { closeAsk(); c.onPick(); };
  const buttons = choices.map((c) => btn(c.label, () => pick(c), { title: c.title, class: c.class }));
  const modal = el('div', {
    class: 'modal',
    onpointerdown: (e: PointerEvent) => { if (e.target === modal) closeAsk(); },
  }, el('div', { class: 'modal-card' },
    el('div', { class: 'modal-title' }, title),
    el('div', { class: 'modal-msg' }, message),
    el('div', { class: 'row modal-actions' }, ...buttons, btn('Cancel', closeAsk)),
  ));
  // the question owns the keyboard while it is up: Escape cancels, the rest of the app hears nothing
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAsk(); return; }
    if (['Tab', 'Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;   // the buttons still take these
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  release = () => window.removeEventListener('keydown', onKey, true);
  document.body.append(modal);
  current = modal;
  buttons[0]?.focus();
}

/** What an object holds, for the delete question: "2 objects · 3 planes · 12 curves". */
function contentsOf(project: Project, g: ObjectGroup): string {
  const groups = subtreeGroups(project, g).length - 1;
  const planes = new Set(subtreePlanes(project, g));
  const curves = project.curves.filter((c) => planes.has(c.planeId)).length;
  const parts = [
    groups ? `${groups} object${groups === 1 ? '' : 's'}` : '',
    planes.size ? `${planes.size} plane${planes.size === 1 ? '' : 's'}` : '',
    curves ? `${curves} curve${curves === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** An empty object holds nothing, so deleting it needs no question. */
function holdsSomething(project: Project, id: Id): boolean {
  const g = findGroup(project, id);
  return !!g && (g.planes.length > 0 || g.groups.length > 0);
}

/**
 * Delete the selected objects — but ask first (docs/18-nested-objects.md §5): with everything
 * inside, or exploded, which keeps the contents and moves them up into the parent.
 */
export function deleteGroupsAsked(store: Store, ids: Id[]): void {
  const list = ids.filter((id) => findGroup(store.project, id));
  const withContents = list.filter((id) => holdsSomething(store.project, id));
  if (!withContents.length) { for (const id of list) cmd.removeGroupContents(store, id); return; }
  const names = list.map((id) => findGroup(store.project, id)!.name);
  const one = list.length === 1 ? findGroup(store.project, list[0])! : null;
  askChoice(
    list.length === 1 ? `Delete "${names[0]}"?` : `Delete ${list.length} objects?`,
    one ? `It holds ${contentsOf(store.project, one)}.` : `${names.join(' · ')} — with everything they hold.`,
    [
      { label: 'Delete with contents', class: 'danger', title: 'Delete the object with its child objects, planes and curves', onPick: () => { for (const id of list) cmd.removeGroupContents(store, id); } },
      { label: 'Explode', title: 'Remove only the object; its planes and child objects move up into its parent, keeping their place in 3D', onPick: () => { for (const id of list) cmd.ungroup(store, id); } },
    ],
  );
}

/** Delete the selection the way ⌫ / the rail ✕ do, asking what to do with a selected object. */
export function deleteSelectionAsked(store: Store): void {
  const { selection, mode } = store.state;
  if (mode.kind !== 'edit' && selection.groups.length) { deleteGroupsAsked(store, [...selection.groups]); return; }
  cmd.deleteSelection(store);
}

/** A plane's name behind the objects it sits in: "Rig › Post › Top". */
function planePath(project: Project, plane: Plane): string {
  return [...groupChain(project, groupOfPlane(project, plane.id)?.id ?? null).map((g) => g.name), plane.name].join(' › ');
}

/**
 * Project the selected curves onto another plane (docs/34-project.md): the popup asks which
 * plane, then each curve's shadow along that plane's normal lands there as a new planar curve.
 */
export function projectSelectionAsked(store: Store): void {
  if (store.state.mode.kind !== 'object') return;
  const curves = store.state.selection.curves.map((id) => findCurve(store.project, id)).filter((c) => !!c);
  if (!curves.length) return;
  const own = new Set(curves.map((c) => c.planeId));
  // every plane but the one they all lie on already (a copy there is what duplicate is for)
  const planes = store.project.planes.filter((p) => !(own.size === 1 && own.has(p.id)));
  const title = curves.length === 1 ? `Project "${curves[0].name}" onto…` : `Project ${curves.length} curves onto…`;
  if (!planes.length) { askChoice(title, 'Add another plane first — the curve already lies on the only one.', []); return; }
  askChoice(title, 'Each curve lands on the plane as a new planar curve: its shadow cast along the plane\'s normal. The originals stay.', planes.map((p) => ({
    label: planePath(store.project, p),
    title: `Project onto ${p.name} (${p.id})`,
    onPick: () => {
      const ids = cmd.projectCurves(store, curves.map((c) => c.id), p.id);
      if (ids.length < curves.length) askChoice('Not everything could be projected', `${curves.length - ids.length} of ${curves.length} collapse to a point on ${p.name} — a line along its normal has no shadow.`, []);
    },
  })));
}
