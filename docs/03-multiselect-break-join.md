# Part 3 — Planes with several curves, multi-select, break apart

Status: **agreed 2026-08-25**, built. Builds on Parts 1–2.
Direction from Kaspar: hierarchy is **curve → plane → modifier**. One curve per
object; curves live on shared planes; later parts trim one curve with another
on the same plane and loft between curves on the same or different planes.

## 1. Model

```
Project  { version: 4, name, profiles, planes: Plane[], curves: CurveObject[] }
Plane    { id, name, placement: { preset, position, rotation }, array: ArrayModifier | null }
CurveObject { id, name, planeId, profileId, curve: { points: Vertex[], closed }, constraints }
```

- A **plane** is the shared drawing surface: position + rotation (presets Front / Top / Side or custom) and the **array modifier**, which repeats *everything on the plane*.
- A **curve** is one object: one profile (shape + limitations), one vertex list, its own constraints. Several curves can sit on one plane; vertex ids are unique across curves.
- Saved projects migrate: every Part-1/2 object becomes a plane + one curve; objects with identical placement *and* modifier share one plane.

## 2. Object mode

- The panel shows an **outliner**: planes as groups, their curves nested. Clicking a curve selects it (its plane becomes the active plane); clicking a plane selects the plane.
- `Shift`-click selects several curves. What is selected is what moves: dragging a selected **curve** offsets its vertices within the plane; dragging when the **plane** is selected moves the plane (all its curves). Position / rotation of the plane are edited in the panel.
- Top bar: `+ Plane` (choose preset) and `+ Curve` (on the active plane; creates the plane if there is none) → Edit mode on the new curve.
- A curve's panel has a **plane** dropdown to move it to another plane (plane-local coordinates are kept, i.e. the drawing is re-used on that plane).
- `⌘J` / *Join ends*: two selected **open** curves on the same plane become one curve, their nearest ends connected.
- Duplicate (`⌘D`) / Delete act on the selected curves; with the **plane selected** they duplicate / delete the plane with everything on it (the copy is shifted 200 mm along the plane's X and becomes the selected plane).

## 3. Edit mode (one curve)

- **Box select**: press on empty plane and drag → marquee; vertices inside are selected (`Shift` adds). A plain click still appends a vertex.
- `⌘A` selects all vertices, `Esc` clears the selection.
- **Moving a selection**: dragging any selected vertex moves *all* selected vertices by the same offset (snapping applies to the dragged one; the solver treats all of them as fixed).
- `Del` deletes all selected vertices; `V` sets the handle type of all selected.
- Other curves on the same plane are drawn (dimmed) for reference and are alignment-snap sources.

## 4. Break apart

`B` (or right-click → *Break apart*) breaks the curve at the selected vertices into separate curves on the same plane:
- an **open** curve broken at a middle vertex → two open curves; the vertex is duplicated (one copy ends the first piece, one starts the second);
- a **closed** curve broken at one vertex → one open curve starting and ending there; at two vertices → two open curves;
- a selected end vertex of an open curve does nothing.

Pieces are new curves with the same profile; constraints stay with the piece that keeps both vertices. Edit mode continues on the first piece.

## 5. Panel changes

- Object mode: outliner (planes → curves), Plane section (preset, position, rotation, modifier), Curve section (name, profile, plane dropdown), Join / Duplicate / Delete.
- Edit mode header: `Break (B)`; Curve section unchanged otherwise.

## 6. Decisions
- Array modifier belongs to the **plane** (repeats all curves on it). Planes are groups: two planes may have the same placement and still be separate groups.

## 7. Out of scope (next parts)
Trim curve with curve · loft between curves · welding vertices · mirror modifier.
