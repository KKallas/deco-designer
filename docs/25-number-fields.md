# Part 25 — Number fields: one row per parameter, drag to scrub

Status: **built 2026-09-01**.

## 1. Why
A properties row is a label plus up to three fields — that fits `x y z` (docs/04)
and nothing longer: the loft trims (`start` / `end` / `offset`, docs/24) push
their last field off the edge of the panel. And every value has to be typed.

## 2. One row per parameter
- `numRow(label, value, onChange, opts)` (src/ui/dom.ts): a full-width row, the
  label on the left, **one** field filling the rest. For parameters with names of
  their own; `x y z` triples keep their single row (`Panel.vec`).
- The loft section becomes six rows: `A trim start`, `A trim end`, `A offset`,
  then the same for `B`.

## 3. Drag to scrub (like Blender)
- **Every number field in the app** scrubs: press on it and drag left / right.
  Under `DRAG_SLOP` = 3 px it is still a click, so click-into-the-field and type
  is unchanged; the drag never focuses the field.
- Sensitivity: **one step of that field per 8 px** (`PX_PER_STEP`), in whole
  steps, added to the value the drag started from — a field at 3 mm with a 10 mm
  step goes 3 → 13 → 23, it does not snap to the 10 mm grid.
- **Shift** = fine: tenths of a step. `min` / `max` clamp as they do when typing.
- The cursor is `↔` over a number field, text selection is off while dragging.
- **One drag = one undo step**: the designer opens a live edit for it
  (`store.beginLive()` / `store.endLive()` — the history suppression
  `transaction()` already used), and the materials / shapes pages send
  `live.begin` / `live.end` over the channel so their drags are one step in the
  designer too (docs/13 §2).
- A panel must not rebuild itself while a drag runs (the element under the
  pointer would be replaced): `isScrubbing()` joins the existing "don't
  re-render a focused field" guard in the panel, the materials page and the
  shapes page; they render once when the drag ends.
- The maths is pure and tested: `scrubValue(start, dx, { step, fine, min, max })`
  in src/ui/scrub.ts, the DOM wiring is `attachScrub` next to it.

## 4. Out of scope
Ctrl to snap to round values · dragging across x / y / z to set all three ·
scrubbing a slider or a colour · arrow-key nudging (the browser's own ↑ / ↓ on a
focused field already steps it).
