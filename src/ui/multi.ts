/**
 * Several things of one class selected (docs/35-outliner-multi-edit.md):
 * picking rows with Shift (a range) / ⌘ or Ctrl (a toggle), and the shared
 * value of a property across the selection — the primary's value, or "mixed"
 * when any of them disagrees. Pure; the DOM side is `Fields` at the bottom.
 */
import type { Id } from '../model/types';
import { checkField, colorField, numField, numRow, selectField, textField, type NumOpts } from './dom';

export type PickMode = 'replace' | 'toggle' | 'range';

/** Shift = range, ⌘ / Ctrl = toggle, a plain click replaces. */
export function pickMode(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): PickMode {
  return e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace';
}

/**
 * The selection after clicking `id` (docs/35 §3): `current` is the selected ids of the clicked
 * class (empty when something else is selected — a modifier click across classes replaces),
 * `order` the rows of that class as the outliner draws them. The last id is the primary.
 */
export function pickIds(current: Id[], id: Id, order: Id[], mode: PickMode): Id[] {
  if (mode === 'replace') return [id];
  if (mode === 'toggle') return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  const anchor = current.length ? current[current.length - 1] : null;
  const a = anchor === null ? -1 : order.indexOf(anchor), b = order.indexOf(id);
  if (a < 0 || b < 0) return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  return [...current.filter((x) => x !== id && !span.includes(x)), ...span.filter((x) => x !== id), id];
}

export interface Shared<T> { value: T; mixed: boolean }

/** The primary's (the last item's) value, and whether any other item disagrees (deep, by JSON). */
export function shared<X, T>(items: X[], get: (x: X) => T): Shared<T> {
  const value = get(items[items.length - 1]);
  const key = JSON.stringify(value ?? null);
  return { value, mixed: items.some((x) => JSON.stringify(get(x) ?? null) !== key) };
}

/**
 * Field builders bound to the selected items: each reads one property off every item and
 * shows `--` when they differ; the setter it is given is the caller's, writing all of them.
 */
export class Fields<X> {
  constructor(readonly items: X[]) {}
  of<T>(get: (x: X) => T): Shared<T> { return shared(this.items, get); }
  num(label: string, get: (x: X) => number, set: (v: number) => void, opts: NumOpts = {}): HTMLElement {
    const s = this.of(get);
    return numField(label, s.value, set, { ...opts, mixed: s.mixed });
  }
  row(label: string, get: (x: X) => number, set: (v: number) => void, opts: NumOpts = {}): HTMLElement {
    const s = this.of(get);
    return numRow(label, s.value, set, { ...opts, mixed: s.mixed });
  }
  text(get: (x: X) => string, set: (v: string) => void, opts: { placeholder?: string; class?: string; title?: string } = {}): HTMLInputElement {
    const s = this.of(get);
    return textField(s.value, set, { ...opts, mixed: s.mixed });
  }
  select(get: (x: X) => string, options: { value: string; label: string; group?: string }[], set: (v: string) => void, opts: { class?: string; title?: string } = {}): HTMLSelectElement {
    const s = this.of(get);
    return selectField(s.value, options, set, { ...opts, mixed: s.mixed });
  }
  check(label: string, get: (x: X) => boolean, set: (v: boolean) => void, opts: { title?: string; disabled?: boolean } = {}): HTMLElement {
    const s = this.of(get);
    return checkField(label, s.value, set, { ...opts, mixed: s.mixed });
  }
  color(get: (x: X) => string, set: (hex: string) => void, opts: { title?: string } = {}): HTMLInputElement {
    const s = this.of(get);
    return colorField(s.value, set, { ...opts, mixed: s.mixed });
  }
}
