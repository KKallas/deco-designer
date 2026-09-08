/**
 * The two toolbar rails (docs/23-toolbar-rails.md): the same widget on the left
 * and on the right of the viewport — a stack of coloured sections of buttons,
 * icon-only or icon + text depending on how wide it has been dragged.
 */
import { el } from './dom';

/** One button on a rail. `icon` always shows, `label` only in text mode. */
export interface RailItem {
  icon: string;
  label: string;
  title: string;
  onclick: () => void;
  active?: boolean;
  class?: string;
  /** A ▾ next to the button (the plane preset): under it in icon mode, beside it in text mode. */
  menu?: { open: boolean; title: string; toggle: () => void; pop: () => HTMLElement };
}

/** A group of buttons: `key` picks its colour in the stylesheet (`.rail-sec.add` …). */
export interface RailSection {
  key: string;
  label: string;
  items: RailItem[];
}

export type RailMode = 'icon' | 'text';

const KEY_W = 'deco.rail.width';
/** The rail with the labels hidden: one 30 px button and its padding. */
export const RAIL_ICON_W = 36;
/** Dragged this wide, the labels appear; narrower snaps back to icons. */
export const RAIL_TEXT_MIN = 110;
export const RAIL_TEXT_MAX = 320;
const DEFAULT_TEXT_W = 150;

/** The width the grip settles on: the labels appear at the threshold, under it the rail snaps to icons. */
export function clampRailWidth(w: number): number {
  return w >= RAIL_TEXT_MIN ? Math.min(w, RAIL_TEXT_MAX) : RAIL_ICON_W;
}

/**
 * The one width both rails share, remembered across sessions. The width *is*
 * the mode (Blender's toolbar): under the threshold it snaps to the icon rail.
 */
export class RailPrefs {
  private w = RAIL_ICON_W;
  /** the width under the pointer while the grip is dragged: free, so the rail follows the hand */
  private live: number | null = null;
  /** the width to go back to when the grip is double-clicked out of icon mode */
  private lastText = DEFAULT_TEXT_W;
  private listeners: (() => void)[] = [];

  constructor() {
    const raw = Number(localStorage.getItem(KEY_W));
    if (Number.isFinite(raw) && raw > 0) this.w = clampRailWidth(raw);
    if (this.w >= RAIL_TEXT_MIN) this.lastText = this.w;
  }

  get width(): number { return this.live ?? this.w; }
  get mode(): RailMode { return this.width >= RAIL_TEXT_MIN ? 'text' : 'icon'; }
  get dragging(): boolean { return this.live != null; }

  /** While the grip is down: no snapping, so the edge stays under the pointer. */
  drag(w: number): void {
    const next = Math.max(RAIL_ICON_W, Math.min(RAIL_TEXT_MAX, Math.round(w)));
    if (next === this.live) return;
    this.live = next;
    this.notify();
  }

  /** Let go: the width settles — under the threshold it snaps back to the icon rail. */
  endDrag(): void {
    const w = this.live;
    this.live = null;
    if (w == null) { this.notify(); return; }
    this.w = clampRailWidth(w);
    if (this.w >= RAIL_TEXT_MIN) this.lastText = this.w;
    this.save();
    this.notify();
  }

  set(w: number): void {
    const next = clampRailWidth(w);
    this.live = null;
    if (next === this.w) return;
    this.w = next;
    if (next >= RAIL_TEXT_MIN) this.lastText = next;
    this.save();
    this.notify();
  }

  /** The double-click on the grip: icons ↔ the last width the labels were shown at. */
  toggle(): void { this.set(this.mode === 'text' ? RAIL_ICON_W : this.lastText); }

  onChange(f: () => void): void { this.listeners.push(f); }

  private save(): void { try { localStorage.setItem(KEY_W, String(this.w)); } catch { /* ignore */ } }
  private notify(): void { for (const f of this.listeners) f(); }
}

/** One button, with its label and its optional ▾ menu. */
function railButton(item: RailItem): HTMLElement {
  const button = el('button', {
    class: `btn rail-btn ${item.class ?? ''} ${item.active ? 'active' : ''}`,
    title: item.title,
    onclick: (e: Event) => { e.stopPropagation(); item.onclick(); },
  }, el('span', { class: 'ico' }, item.icon), el('span', { class: 'txt' }, item.label));
  if (!item.menu) return button;
  const { menu } = item;
  return el('div', { class: 'rail-group' },
    button,
    el('button', {
      class: `btn rail-btn caret ${menu.open ? 'active' : ''}`, title: menu.title,
      onclick: (e: Event) => { e.stopPropagation(); menu.toggle(); },
    }, '▾'),
    ...(menu.open ? [menu.pop()] : []),
  );
}

/**
 * Draw a rail into `root`. The grip on the inner edge sets the width both rails
 * share; `onResize` is called while it is dragged so the scene can follow.
 */
export function renderRail(root: HTMLElement, sections: RailSection[], prefs: RailPrefs, side: 'left' | 'right'): void {
  root.className = `rail ${side} ${prefs.mode}`;
  root.style.width = `${prefs.width}px`;
  root.replaceChildren(
    ...sections.filter((s) => s.items.length).map((s) => el('div', { class: `rail-sec ${s.key}` },
      el('div', { class: 'rail-title' }, s.label),
      ...s.items.map(railButton),
    )),
    grip(prefs, side),
  );
}

/**
 * The handle on the inner edge — drag to widen, double-click to flip the mode.
 * The drag runs on `window`, not on pointer capture: every width change re-renders
 * the rail, which replaces this very element, and a captured pointer would be lost
 * with it after the first pixel.
 */
function grip(prefs: RailPrefs, side: 'left' | 'right'): HTMLElement {
  return el('div', {
    class: `rail-grip ${prefs.dragging ? 'dragging' : ''}`,
    title: 'Drag to widen the toolbars (labels appear); double-click for icons only',
    ondblclick: () => prefs.toggle(),
    onpointerdown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const start = e.clientX, from = prefs.width;
      document.body.classList.add('col-resizing');
      const move = (ev: PointerEvent) => prefs.drag(from + (side === 'left' ? ev.clientX - start : start - ev.clientX));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.body.classList.remove('col-resizing');
        prefs.endDrag();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
  });
}
