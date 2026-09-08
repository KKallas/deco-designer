/**
 * Drag a number field to change it, like Blender (docs/25-number-fields.md):
 * press on the field and drag left / right, one step per PX_PER_STEP pixels,
 * Shift for tenths of a step. `scrubValue` is the whole of the maths (pure);
 * `attachScrub` is the DOM wiring, `setScrubHooks` lets the app group a drag
 * into one undo step and hold off its re-render while it runs.
 */

/** Pixels of drag per step of the field. */
export const PX_PER_STEP = 8;
/** Under this much movement the press is still a click: focus the field and type. */
export const DRAG_SLOP = 3;

/** `start`: where a drag begins when the field shows no value (a mixed field, docs/35 §4 — the primary's value). */
export interface ScrubOpts { step?: number; min?: number; max?: number; fine?: boolean; start?: number }

/**
 * Where a drag of `dx` pixels from `start` lands: whole steps of the field
 * (`fine` = tenths), **added to the value the drag started from** — a field at
 * 3 with a step of 10 goes 3 → 13 → 23, it does not snap to the grid.
 */
export function scrubValue(start: number, dx: number, opts: ScrubOpts = {}): number {
  const step = Math.abs(opts.step || 1) * (opts.fine ? 0.1 : 1);
  let v = start + Math.round(dx / PX_PER_STEP) * step;
  v = Math.round(v * 1e6) / 1e6;   // 0.1 + 0.2 arithmetic
  if (opts.min != null) v = Math.max(opts.min, v);
  if (opts.max != null) v = Math.min(opts.max, v);
  return v;
}

/** What the app plugs in: one undo step per drag, and no rebuild while it runs. */
export interface ScrubHooks { begin(): void; end(): void }
let hooks: ScrubHooks | null = null;
export function setScrubHooks(h: ScrubHooks | null): void { hooks = h; }

let dragging = 0;
/** True while a number field is being dragged — a panel must not rebuild itself then. */
export function isScrubbing(): boolean { return dragging > 0; }

/** Make one number input scrub on a drag. Called by `numField` — every number field in the app has it. */
export function attachScrub(input: HTMLInputElement, opts: ScrubOpts, onChange: (v: number) => void): void {
  let drag: { x: number; start: number; pointer: number; moved: boolean } | null = null;
  const stop = () => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    if (!moved) return;
    dragging--;
    document.body.classList.remove('scrubbing');
    hooks?.end();
  };
  input.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || input.disabled || input.readOnly) return;
    const typed = parseFloat(input.value);
    drag = { x: e.clientX, start: Number.isFinite(typed) ? typed : opts.start ?? 0, pointer: e.pointerId, moved: false };
  });
  input.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      drag.moved = true;
      dragging++;
      try { input.setPointerCapture(drag.pointer); } catch { /* a synthetic pointer has nothing to capture */ }
      input.blur();                                  // a drag scrubs, it never focuses the field
      document.body.classList.add('scrubbing');
      hooks?.begin();
    }
    const v = scrubValue(drag.start, dx, { ...opts, fine: e.shiftKey });
    if (v === parseFloat(input.value)) return;
    input.value = String(v);
    onChange(v);
  });
  input.addEventListener('pointerup', (e) => { const moved = drag?.moved; stop(); if (moved) e.preventDefault(); });
  input.addEventListener('pointercancel', stop);
  input.addEventListener('lostpointercapture', stop);
}
