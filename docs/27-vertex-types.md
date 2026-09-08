# Part 27 — Vertex types: Polygon / Equal / Free

Status: **agreed 2026-09-03**. Replaces the Part 2 set (Auto / Smooth / Corner,
docs/02-handles-snapping-constraints.md § 1). Decisions: three types only —
*Auto* goes away; **Polygon is the default**, so drawing gives straight
segments; *Equal* is the old *Smooth* (collinear, lengths independent).

## 1. The three types

| Type | Handles | Drawn |
|---|---|---|
| **Polygon** (default) | ignored — both sides read as zero, so the neighbouring segments are straight lines | diamond, no handle line |
| **Equal** | in/out stay collinear; dragging one rotates both, the lengths stay independent | circle, accent handle line |
| **Free** | in/out independent | circle, accent handle line |

- `V` cycles **Polygon → Equal → Free → Polygon**; right-click on a vertex lists
  the three, as does the *Curve* section of the panel.
- New vertices are **Polygon**: a freshly drawn curve is a polyline, and every
  bend is a sharp one until the vertex is made Equal or Free (the bend-radius
  check flags sharp bends exactly as before).
- Turning a Polygon vertex into Equal or Free gives it handles derived from its
  neighbours (the old *Auto* maths) **when it has none** — otherwise the ones it
  already carries come back, so Equal → Polygon → Equal is lossless.
- Inserting a vertex on a curve still splits the Bézier (de Casteljau) and keeps
  the shape: the new vertex is **Equal**, or **Polygon** when the segment it
  splits is straight. Neighbouring Polygon vertices keep their zero handles.
- Welding two ends (array commit, join): **Free** wins over **Equal**, which
  wins over **Polygon**.

Data: `Vertex { id, x, y, z, type: 'polygon' | 'equal' | 'free', in: Vec3, out: Vec3 }`.

## 2. Migration (project version 13 → 14)

| was | becomes |
|---|---|
| `auto` | `equal`, with the handles the auto maths gave it — shape unchanged |
| `smooth` | `equal` |
| `corner`, both handles zero | `polygon` |
| `corner`, any handle | `free` |

Old files therefore look exactly as they did; only newly drawn vertices start
straight.

## 3. Out of scope
A "vector" type that points the handles at the neighbours · per-curve default ·
converting a whole curve to polygon in one action (select all + `V` does it).
