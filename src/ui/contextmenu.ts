import { el } from './dom';

export interface MenuItem {
  label?: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

let current: HTMLElement | null = null;

export function closeContextMenu(): void {
  current?.remove();
  current = null;
}

/** Show a small context menu at viewport coordinates (CSS px). */
export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const menu = el('div', { class: 'ctx-menu', style: `left:${x}px; top:${y}px` },
    ...items.map((it) => it.separator
      ? el('div', { class: 'ctx-sep' })
      : el('div', {
        class: `ctx-item ${it.disabled ? 'disabled' : ''} ${it.checked ? 'checked' : ''}`,
        onclick: (e: Event) => { e.stopPropagation(); if (it.disabled) return; closeContextMenu(); it.onClick?.(); },
      }, el('span', { class: 'ctx-check' }, it.checked ? '✓' : ''), el('span', { class: 'grow' }, it.label ?? ''), it.hint ? el('span', { class: 'ctx-hint' }, it.hint) : null)),
  );
  document.body.append(menu);
  current = menu;
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${x - r.width}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${y - r.height}px`;
  const close = () => { closeContextMenu(); window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', onKey, true); }, 0);
}
