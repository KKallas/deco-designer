/**
 * List and detail building blocks shared by the materials and shapes pages:
 * reorderable rows (drag within a list), section headers, key / value lines.
 */
import { el } from './dom';

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

let dragging: { list: string; id: string } | null = null;

/** A list row that can be dragged to reorder within its list (`move` receives the target index). */
export function row(list: string, id: string, index: number, selected: boolean, onClick: () => void, move: (index: number) => void, ...children: (HTMLElement | null)[]): HTMLElement {
  const r = el('div', { class: `me-row ${selected ? 'selected' : ''}`, draggable: true, onclick: onClick },
    el('span', { class: 'grip', title: 'Drag to reorder' }, '≡'), ...children.filter((c): c is HTMLElement => !!c));
  r.addEventListener('dragstart', (e) => { dragging = { list, id }; e.dataTransfer?.setData('text/plain', id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
  r.addEventListener('dragend', () => { dragging = null; });
  r.addEventListener('dragover', (e) => { if (dragging?.list === list && dragging.id !== id) { e.preventDefault(); r.classList.add('drag-over'); } });
  r.addEventListener('dragleave', () => r.classList.remove('drag-over'));
  r.addEventListener('drop', (e) => {
    r.classList.remove('drag-over');
    if (dragging?.list !== list || dragging.id === id) return;
    e.preventDefault(); e.stopPropagation();
    const to = index + (e.offsetY > r.clientHeight / 2 ? 1 : 0);
    move(to);
  });
  return r;
}

/** Target index for a list command after dropping the item at `from` onto slot `to`. */
export const dropIndex = (from: number, to: number): number => (to > from ? to - 1 : to);

/** A plain (non-reorderable) row. */
export function plainRow(selected: boolean, onClick: () => void, ...children: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: `me-row ${selected ? 'selected' : ''}`, onclick: onClick }, ...children.filter((c): c is HTMLElement => !!c));
}

export function header(title: string, ...actions: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'sec-title' }, el('span', { class: 'grow' }, title), ...actions.filter((a): a is HTMLElement => !!a));
}

export function emptyNote(text: string): HTMLElement { return el('div', { class: 'me-empty' }, text); }

/** `label value` pairs on one wrapping line (a null value skips the pair). */
export function meta(...pairs: [string, string | null][]): HTMLElement {
  return el('div', { class: 'row wrap' }, ...pairs.flatMap(([k, v]) => (v === null ? [] : [el('span', { class: 'lbl' }, k), el('span', { class: 'dim' }, v)])));
}

export function warningsList(warnings: string[]): HTMLElement | null {
  return warnings.length ? el('div', {}, el('div', { class: 'sec-title', style: 'margin-top:6px' }, `Not 1:1 (${warnings.length})`), el('ul', { class: 'warnings' }, ...warnings.map((w) => el('li', {}, w)))) : null;
}

/** Download text as a file (an ES module for material / shape code). */
export function downloadText(name: string, text: string, type = 'text/javascript'): void {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

export const fileSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
