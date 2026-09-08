import { attachScrub } from './scrub';

type Child = Node | string | number | null | undefined | false;

/** Tiny DOM builder: el('div', { class: 'row', onclick: fn }, 'text', otherEl). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'style') e.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

export function btn(label: string, onclick: () => void, opts: { title?: string; class?: string; active?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const b = el('button', { class: `btn ${opts.class ?? ''} ${opts.active ? 'active' : ''}`, title: opts.title, onclick: (e: Event) => { e.stopPropagation(); onclick(); } }, label);
  if (opts.disabled) b.disabled = true;
  return b;
}

/** `mixed`: the selected things disagree (docs/35-outliner-multi-edit.md §4) — the field shows `--`, and a value typed or dragged in goes to all of them. */
export interface NumOpts { step?: number; min?: number; max?: number; title?: string; mixed?: boolean }

/** Shown in place of a value the selected things disagree on. */
export const MIXED = '--';

/** A number field: type in it, or **drag it left / right to scrub** (docs/25-number-fields.md). A mixed one scrubs from `value` (the primary's). */
export function numField(label: string, value: number, onChange: (v: number) => void, opts: NumOpts = {}): HTMLElement {
  const input = el('input', {
    type: 'number', value: opts.mixed ? '' : String(value), placeholder: opts.mixed ? MIXED : undefined, class: opts.mixed ? 'mixed' : undefined, step: opts.step ?? 1, min: opts.min, max: opts.max,
    onchange: (e: Event) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) onChange(v);
    },
  });
  attachScrub(input, { ...opts, start: value }, onChange);
  return el('label', { class: 'field', title: opts.title }, el('span', {}, label), input);
}

/**
 * One parameter on its own row (docs/25-number-fields.md §2): the label on the left, the field
 * filling the rest. For parameters with names of their own — `x y z` triples stay on one row.
 */
export function numRow(label: string, value: number, onChange: (v: number) => void, opts: NumOpts = {}): HTMLElement {
  return el('div', { class: 'row num-row', title: opts.title }, el('span', { class: 'lbl' }, label), numField('', value, onChange, opts));
}

export function textField(value: string, onChange: (v: string) => void, opts: { placeholder?: string; class?: string; title?: string; mixed?: boolean } = {}): HTMLInputElement {
  return el('input', {
    type: 'text', value: opts.mixed ? '' : value, placeholder: opts.mixed ? MIXED : opts.placeholder, class: `${opts.class ?? ''} ${opts.mixed ? 'mixed' : ''}`.trim() || undefined, title: opts.title,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).value),
    onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); },
  });
}

/** The dropdown entry standing for "they differ" — picking it changes nothing. */
const MIXED_OPTION = '\u0000mixed';

export function selectField(value: string, options: { value: string; label: string; group?: string }[], onChange: (v: string) => void, opts: { class?: string; title?: string; mixed?: boolean } = {}): HTMLSelectElement {
  const s = el('select', { class: `${opts.class ?? ''} ${opts.mixed ? 'mixed' : ''}`.trim() || undefined, title: opts.title, onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v !== MIXED_OPTION) onChange(v); } });
  const groups = new Map<string, HTMLOptGroupElement>();
  if (opts.mixed) s.append(el('option', { value: MIXED_OPTION, selected: true }, MIXED));
  for (const o of options) {
    const opt = el('option', { value: o.value, selected: o.value === value }, o.label);
    if (!o.group) { s.append(opt); continue; }
    let g = groups.get(o.group);
    if (!g) { g = el('optgroup', { label: o.group }); groups.set(o.group, g); s.append(g); }
    g.append(opt);
  }
  s.value = opts.mixed ? MIXED_OPTION : value;
  return s;
}

/** A colour picker (hex string in, hex string out); a mixed one shows the primary's colour, marked. */
export function colorField(value: string, onChange: (hex: string) => void, opts: { title?: string; mixed?: boolean } = {}): HTMLInputElement {
  return el('input', { type: 'color', value, class: `color ${opts.mixed ? 'mixed' : ''}`.trim(), title: opts.mixed ? `${MIXED} they differ${opts.title ? ` — ${opts.title}` : ''}` : opts.title, onchange: (e: Event) => onChange((e.target as HTMLInputElement).value) });
}

/** A labelled checkbox; a mixed one is indeterminate, and the first click sets all of them on. */
export function checkField(label: string, checked: boolean, onChange: (v: boolean) => void, opts: { title?: string; disabled?: boolean; mixed?: boolean } = {}): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: opts.mixed ? false : checked, disabled: opts.disabled, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  if (opts.mixed) input.indeterminate = true;
  return el('label', { class: `chk ${opts.mixed ? 'mixed' : ''}`.trim(), title: opts.mixed ? `${MIXED} they differ${opts.title ? ` — ${opts.title}` : ''}` : opts.title }, input, label);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'sec' }, el('div', { class: 'sec-title' }, title), ...children);
}

/** A sub-section inside a section (Outline, Layers, Fixture …): small caps with a rule, actions on the right. */
export function subTitle(title: string, ...actions: Child[]): HTMLElement {
  return el('div', { class: 'sub-title' }, el('span', { class: 'grow' }, title), ...actions);
}

export function swatch(color: string): HTMLElement {
  return el('span', { class: 'swatch', style: `background:${color}` });
}

export function badge(count: number, color?: string): HTMLElement {
  return el('span', { class: `badge ${count ? '' : 'empty'}`, style: color && count ? `background:${color}` : undefined }, String(count));
}
