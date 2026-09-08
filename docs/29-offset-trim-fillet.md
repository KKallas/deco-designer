# Part 29 — Offset, trim and fillet on a plane

Status: **built 2026-09-04** (asked for as "tools for the same plane:
offset, trim, fillet"). Builds on Part 3 (several curves on a plane, break /
join), Part 23 (rails), Part 25 (number fields), Part 27 (vertex types).
Decisions taken without a round of questions are listed in §7 — one word and
any of them changes.

## 1. What it is
Three CAD tools that work **between curves lying on the same plane**, in Object
mode, from a new **Modify** section on the left rail. No new data: each one
reads curves and writes ordinary curves, one undo step per click.

| tool | key | what a click does |
|---|---|---|
| **⇉ Offset** | `O` | a parallel copy of the curve, `d` mm to the side — drag from the curve to the side you want, or click it for the number in the tool bar |
| **✂ Trim** | `T` | removes the piece of the curve under the pointer, between the nearest crossings with other curves on the plane |
| **⌒ Fillet** | `L` | rounds the corner under the pointer with radius `r`; or click two open curves and they are joined at their corner (trimmed or extended to it) and rounded |

A **tool bar** under the selection label shows the active tool, its number
(`d` / `r`, a scrubbable field — docs/25) and a one-line hint. `Esc`, `W` /
`E` / `R` or the button again leave the tool, as the focus tool does.

## 2. Offset
- The copy is a **new curve on the same plane**, same profile, params and
  material, named `<name> offset`, selected afterwards; the source is untouched.
- **Sign**: for a **closed** curve `+` is **outwards** (whichever way it was
  drawn — the same rule as a panel's `expand`, docs/28 §3); for an **open**
  curve `+` is the **left-hand side** looking along the curve (the side its
  signed curvature calls positive). Dragging never asks: the copy follows the
  pointer's side and perpendicular distance, snapped to the grid unless `Shift`.
- **Maths**: Tiller–Hanson per Bézier segment — each leg of the control polygon
  slides along its own normal by `d`, the new control points sit where the
  offset legs meet. A straight side comes out exactly parallel; a curved side
  is checked against the true parallel and **split in two where it strays by
  more than 0.2 mm** (a 90° arc becomes two or four spans), so the copy gains
  equal vertices at those splits. Vertices keep their type: a polygon stays a
  polygon (so the corners are **mitred**, a rectangle stays a rectangle), an
  equal vertex stays equal. A corner sharper than the mitre limit (4 × `d`) is
  cut off instead of shooting away.
- The **bar's `d`** is the last distance used (a drag writes it back), 20 mm to
  start. Constraints are not copied — the copy is a fresh drawing.

## 3. Trim
- The cutters are **all other curves on the same plane**, crossings found on
  the sampled curves and refined; the curve's own self-crossings do not count.
- The piece removed runs from the crossing before the pointer to the crossing
  after it, or to the curve's end when there is none on that side. An open
  curve therefore leaves **zero, one or two** curves (a middle piece cut out
  makes two, like *Break apart*); a **closed** curve needs at least two
  crossings and becomes **one open** curve. With **no crossing at all nothing
  happens** — deleting a whole curve is what `Del` is for.
- Cut points are inserted with a de Casteljau split (the shape does not move);
  constraints stay with the piece that keeps both their vertices; the second
  piece is a new curve named `<name> 2`, same profile and material.
- Hovering shows the piece that would go in pink.

## 4. Fillet
### 4.1 A corner of one curve
- A **corner** is a vertex where the tangent turns: a polygon vertex, or a free
  vertex with a kink. Hovering within 12 px rings the nearest one.
- The corner is cut back `t = r · tan(φ/2)` along each side (`φ` = the turning
  angle) and the two new points are joined by a **circular arc of radius `r`**
  when the sides are straight — one cubic per 50° of turn (control length
  `4/3 · tan(step/4) · R`), so a right angle is two spans with an equal vertex
  in the middle and the radius holds along the arc to a twentieth of a percent.
  On a curved side the tangent at the cut is used, so the join is still
  tangent-continuous, with the radius only approximate.
- The new points are **free** vertices: the arc's handle on one side, the
  side's own shape (nothing, on a straight side) on the other. Neighbouring
  polygon vertices keep their zero handles, so the straight sides stay straight.
- Too big a radius (the cut-back would eat a whole side) does nothing and says
  so in the bar.
- **`r` starts at the profile's minimum bend radius** of the curve clicked —
  one click makes a sharp bend legal — and then remembers what you set.

### 4.2 Two open curves
- Click one open curve, then another on the same plane: their **nearest ends**
  are brought to the corner — **trimmed** back to it when the curves cross,
  **extended** straight along the end tangents to where those meet otherwise
  (a straight end that overshoots that point is trimmed back to it) — merged
  into one vertex, joined into **one curve** (the
  first keeps its id, name and material) and that vertex is filleted with `r`.
  `r = 0` gives the sharp corner: the "extend / trim to corner" that Trim alone
  cannot do.
- Parallel ends, or a corner that lies behind a *curved* end, do nothing.

## 5. Where it lives
- `src/geometry/modify.ts` — pure: `offsetCurve`, `intersections`, `trimSpan` /
  `trimPieces`, `filletCorner`, `cornerJoin` plus the helpers (`cutAt`,
  `vertexArcLengths`, `signedDistance`, `turnAt`). Tests in `tests/modify.test.ts`.
- `src/geometry/curve.ts`: each Bézier segment now keeps a 1000-entry arc-length
  table (three.js's default 200 put cuts a few hundredths of a millimetre off).
- Commands: `cmd.offsetCurve(store, id, d)` → the copy's id;
  `cmd.trimCurve(store, id, s)` → the ids left (`s` = arc length under the
  pointer); `cmd.filletVertex(store, id, vid, r)` → true when it rounded;
  `cmd.filletCurves(store, a, b, r)` → the joined id.
- Viewer: `planeTool: 'offset' | 'trim' | 'fillet' | null` next to `focusTool`,
  `toolValues` for `d` / `r`, `filletFirst`; hover previews live in their own `toolGroup`.
- The tools pick curves **directly** (nearest sampled point within 10 px),
  not through the selection filter, and only **planar** curves: a spatial curve
  (docs/12) is skipped.

## 6. Bridge
```js
const copy = cmd.offsetCurve(store, 'front-left', 25)          // + = outwards / left
cmd.trimCurve(store, 'front-left', 300)                         // remove the piece around s = 300 mm
cmd.filletVertex(store, 'front-left', curve('front-left').points[1].id, 60)
cmd.filletCurves(store, 'leg-a', 'leg-b', 0)                    // corner join, sharp
```

## 7. Decisions (mine, open to veto)
1. **Tools, not modifiers**: an offset is a real curve you go on editing — the
   ask was "tools", and a live offset modifier would be a fourth thing on the
   plane next to the array.
2. **Sign** as in §2: outwards for closed, left for open. One rule per case
   rather than "left" everywhere, which would make a ring grow or shrink
   depending on which way it happened to be drawn.
3. **Trim with nothing to trim against does nothing.** No silent deletes.
4. **Fillet does two jobs** (a corner, or two curves) because in CAD they are
   one command, and the two-curve form with `r = 0` is the corner join the trim
   tool otherwise leaves missing.
5. **Default `r` = the profile's minimum bend radius**: the number a fabricator
   would type first.
6. `O` / `T` / `L` are the keys; `⌘L` stays the loft.
7. **The bend-radius check gained half a percent of slack** (`BEND_SLACK` in
   src/checks/index.ts): a cubic arc's radius wavers about 0.05 % along it and
   the sampled estimate has noise of its own, so without it a fillet at exactly
   the minimum radius stayed flagged. Nothing a fabricator can measure.

## 8. Out of scope
Offset as a live modifier · trimming against a curve on another plane (project
it first) · trim-to-self · extending a curved end along its arc (ends extend
straight) · fillets with two radii or chamfers · offsetting a spatial curve.
