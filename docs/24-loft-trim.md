# Part 24 — Loft trims and offsets

Status: **built 2026-09-01**. Builds on Part 5 (docs/05-loft.md).

## 1. What it is
A loft carries **two sets of edge settings, one per control curve** — A and B —
so each curve can be *pre-trimmed* before the surface is built:

```
Loft { …, edgeA: { start, end, offset, lift }, edgeB: { … } }   // mm, all 0 = the old behaviour
```

Each edge moves along the band's own three directions: **trim** along the curve
(start / end), **offset** across the ruling, **lift** out of the surface.

The control curves are never touched: they keep their length, their profile and
their checks. Only the span the loft is built over changes.

## 2. Trim — stay short or go past the control curve
- `start` / `end` are **millimetres of arc length** cut off that end of the
  curve *as drawn* (`start` = the end at the first vertex), measured after the
  curve is placed in the world.
- **Positive = stay short**, **negative = go past** the control curve: the edge
  is extended straight along the end tangent by that many mm.
- The trim happens **before** everything else: the automatic direction choice
  (and `flip`), the rulings, the strips and the uvs all see the trimmed edges.
- Nothing left (`length − start − end ≤ 0`) → the loft builds **no mesh**; it
  comes back as soon as the numbers make sense again.
- A closed curve is cut open by a non-zero trim (its start is the loop's seam).

## 3. Offset — inwards or outwards, in the surface
- `offset` moves that whole edge **across the ruling**: **+ = outwards** (away
  from the other curve, a wider loft), **− = inwards** (towards it, narrower).
- The direction at ruling *i* is `normalize(B_i − A_i)`, taken **before** either
  offset is applied, so both edges slide along the same line and a parallel band
  stays parallel. A ruling of zero length (the curves touch) doesn't move.
- An inward offset larger than the band's width crosses the other edge and the
  surface folds — not clamped, it is a legitimate shape.

## 3b. Lift — back and forth, out of the surface
- `lift` moves that edge **along the loft's own normal**: **+ = out of the front
  of the surface**, **− = behind it**. Lifting one edge tilts the band; lifting
  both by the same amount slides the whole surface off its control curves.
- The normal at ruling *i* is `normalize(cross(tangent of the band's centreline,
  ruling))` — so for a flat loft drawn on a plane it *is* that plane's normal
  (front plane: **+ towards the viewer**), and for a loft between two planes it
  is the surface's own normal, not either curve's plane normal.
- Read, like the ruling, from the trimmed edges **before** anything moves, so
  both edges lift along the same direction and a flat band stays flat. Where the
  frame degenerates (the ruling runs along the band) it falls back to the plane
  normal of curve A.

## 4. UVs
Unchanged in kind (docs/05 §2, mm of surface) but measured on the **trimmed and
offset** edges: `u = 0` at the trimmed start, `v = 0` on the offset edge A.

## 5. UI and bridge
- Loft section in the panel: a row per curve — `A trim start / end / offset`,
  `B trim start / end / offset` (mm, negative allowed).
- Bridge: `cmd.setLoftEdge(store, loftId, 'a' | 'b', { start: 200, end: -150, offset: 25 })`
  (a partial patch; `cmd.updateLoft` takes `edgeA` / `edgeB` whole). `overview()`
  prints the non-zero ones on the loft line.

## 6. Out of scope
Tapered offsets or lifts (per end) · trimming against another curve or surface ·
trimming the loft *across* (the `v` direction) · rounding the cut corners.
