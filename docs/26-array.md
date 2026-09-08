# Part 26 — Array: direction and axis gizmos, commit to curves

Status: **built 2026-09-02**.

## 1. Why
The array modifier (docs/03 §1, one per plane) is typed as bare numbers, it can
only turn about the plane normal, and the copies are ghosts — nothing you can
select, edit, check per copy, loft from or patch as a fixture. Three things:

- **linear** — drag the direction and spacing in the viewport instead of typing
  `dx dy dz`.
- **circular** — an axis anywhere in space (a **point** and an **up
  direction**), dragged in the viewport; today it always turns about the plane
  normal through a point in the plane, so a ring of curves around a vertical
  post can only be built by hand.
- **commit** — bake the copies into real curve objects, welding ends that meet
  (**merge by distance**), the panel saying how many curves come out.

## 2. Model

```ts
type ArrayModifier =
  | { type: 'linear';   count: number; offset: Vec3 }                                   // unchanged
  | { type: 'circular'; count: number; center: Vec3; axis: Vec3; angle: number }        // center was Vec2; axis is new
```

- Everything is **plane-local mm** (`z` along the plane normal), like a spatial
  curve's vertices (docs/12).
- `axis` is a direction; its length is ignored (normalised on use).
  `{ x: 0, y: 0, z: 1 }` = the plane normal = exactly today's behaviour.
- `instanceMatrices` rotates about the **line** (`center`, `axis`):
  `T(center) · R(axis, step·i) · T(−center)`. Nothing downstream changes — the
  viewport, the emitter bake and the probes already take an arbitrary `Matrix4`
  per copy, so a copy is free to leave the plane.
- Migration (project version 12 → 13): `center: {x, y}` → `{x, y, z: 0}`,
  `axis: {x: 0, y: 0, z: 1}`. Old files array identically.

## 3. Gizmos

A **selected plane that has an array** draws its handles in the viewport
(helpers, like the reference-image handles):

| | handle | drawn |
|---|---|---|
| linear | the offset point, at plane-local `offset` | dashed line from the plane origin to it |
| circular | the axis **point**, at `center` | the axis line through it, dashed both ways |
| circular | the **up** handle, at `center + axis·L` | `L` = the plane's content radius, min 300 mm |

The panel's `◇` button next to a vector picks the same handle, for a plane whose
handles are hidden behind the geometry.

- Clicking a handle picks it (`selection.arrayHandle: 'offset' | 'center' |
  'axis' | null`); the transform gizmo attaches there in **translate** mode in
  the **plane frame** (X / Y / Z arrows + the XY square), so it drags in plane
  coordinates with the usual vertex / grid snapping. Rotate and scale are
  ignored while a handle is picked.
- Dragging writes the modifier live — **one drag = one undo step**, like every
  other gizmo drag (docs/25 §3).
- The up handle only aims: it sets `axis = normalize(handle − center)` and snaps
  back to `L`. The offset handle sets `offset` outright (distance is spacing).
- `Esc`, or clicking anything else, gives the gizmo back to the plane.
- The panel keeps its number fields (typing still works) and they follow the
  drag: `count` and `offset x y z` for linear, `count · angle`, `axis at x y z`
  and `axis up x y z` for circular (docs/25 rows).

## 4. Commit

The *Modifier* section gains a `merge` field (mm, default **0.5**), a live line
`3 copies × 2 curves → 4 curves`, and a **Commit** button. Past 200 copies the
line only counts them (welding them all is too slow to redo on every keystroke).

`cmd.commitArray(store, planeId, { merge })` → the new curve ids, one undo step:

1. Every copy of every curve on the plane becomes a **real curve object on the
   same plane**, its points transformed into plane-local coordinates. A copy
   that leaves the plane (a `z` offset, or an axis that is not the normal) comes
   out as a **spatial** curve (docs/12) — same plane, vertices carrying `z`.
2. **Merge by distance**: ends that meet within `merge` mm are welded — two ends
   of different curves become one curve (the shared vertex kept once, position
   the midpoint, the outer handles kept), the two ends of one curve **close** it.
   Repeated until nothing more meets, so a 6-copy circular array of an arc comes
   out as **one closed curve**. Only ends of **open curves of the same profile**
   weld; a copy crossing another in the middle stays two curves. `merge = 0`
   welds nothing.
3. Profile, params, material, constraints and pixels ride along; a welded curve
   keeps the first copy's settings, and pins move with their vertices.
4. `plane.array = null` — the copies are now the model. Undo brings the modifier
   back. Names: `Curve 1`, `Curve 1 · 2`, …; a welded chain keeps the first name.

The count in the panel and the command come from **one pure function**,
`commitArray(mod, curves, merge, taken?)` in src/geometry/array.ts — that is what
the tests drive.

Caveats: every copy of an LED fixture reads the *same* animation columns
(repatch after committing, docs/17 §3), and a loft whose curve was welded away
goes with it (docs/05 §2 — array copies were never lofted anyway).

## 5. Bridge

```js
cmd.setPlaneModifier(store, 'front', { type: 'circular', count: 8, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, angle: 360 })
cmd.setPlaneModifier(store, 'front', { type: 'linear', count: 5, offset: { x: 250, y: 0, z: 120 } })
cmd.commitArray(store, 'front', { merge: 0.5 })   // → new curve ids; overview() shows them
```

## 6. Out of scope

Arrays on objects (still one per plane) · arrays of arrays · mirror arrays ·
spacing modes (fit length / fit curve) · per-copy offset, rotation or scale
ramps · lofting array copies · keeping a live link after commit (commit is
one-way).
