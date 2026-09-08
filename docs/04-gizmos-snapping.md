# Part 4 — Transform gizmos and vertex-to-vertex snapping

Status: **agreed 2026-08-25**, built. Builds on Parts 1–3. Note: a curve gizmo acts on the selected curves that share the primary curve's plane.

## 1. Gizmos

A gizmo appears at the selection's pivot; its **mode** is Move / Rotate / Scale
(viewport rail buttons or keys, see decisions). Dragging directly on curves
(without the gizmo) keeps working as today.

| Selection | Gizmo | Pivot | What changes |
|---|---|---|---|
| **Plane** (Object mode) | 3D: move arrows X/Y/Z + plane squares XY/YZ/XZ, rotate rings X/Y/Z, scale handles | plane origin | Move / rotate write the plane's placement (preset becomes *custom* when rotated). Scale is **baked into the curves** on the plane (vertices ×sx, ×sy about the origin; the plane has no scale of its own). |
| **Curves** (Object mode) | 2D, in the plane: move X/Y arrows + centre, one rotate ring about the plane normal, scale X/Y + uniform | bounds centre of the selected curves | Vertices (and handles) of the selected curves are transformed in plane coordinates; distance constraints and pins follow. |

Rotate snaps to 15° and scale to 0.1 while grid snap is on; `Shift` disables snapping during a gizmo drag as elsewhere. One undo step per gizmo drag.

## 2. Vertex-to-vertex snapping while moving ("closest point" snap)

When a **move** starts — with the gizmo, or by dragging a curve / plane directly — the
**anchor** is the vertex of the moved curves closest to where the drag started
(for the gizmo centre: the vertex closest to the pivot). While dragging, the anchor snaps onto the **closest vertex
of any curve that is not being moved** near the mouse (10 px), and the whole
selection follows — so a curve can be dropped exactly vertex-on-vertex.

- 2D moves (curves, vertices): candidates are all other vertices projected onto the plane. When no vertex is near, the existing **alignment snap** (pink guides) and grid snap apply to the anchor instead of the raw delta.
- 3D plane moves: candidates are all vertices of other planes in **world** space. The gizmo's constraint decides which coordinates snap: an axis handle snaps that coordinate only, a plane handle (XY / YZ / XZ) the two in-plane coordinates, free move all three.
- Feedback: a pink ring on the target vertex while the snap holds.

## 3. Rail and keys

Viewport rail (left): **Move (W) · Rotate (E) · Scale (R)** toggles; the active mode is highlighted. `Esc` in Object mode deselects; the gizmo shows whenever a plane or curves are selected in Object mode.

## 4. Implementation notes
three.js `TransformControls` drives both gizmos through a proxy object: for planes it is the plane transform (world space for move, local for rotate / scale); for curves / vertices it is aligned to the plane frame with the Z axis hidden, so only in-plane X/Y and the normal-axis rotation remain. Each drag records the original vertices; every change is re-applied from those originals (no drift), snapping adjusts the proxy before the transform is applied.

## 5. Decisions
1. Gizmo keys: **W / E / R** = Move / Rotate / Scale; `G` stays the grid-snap toggle.
2. Gizmos for **planes and curves only** (Object mode); Edit mode keeps direct vertex dragging. *Superseded by Part 11: the curve gizmo also acts on selected vertices in Edit mode.*

## 6. Out of scope
Numeric input while dragging · mirror · snapping to curve midpoints / intersections · trim / loft.
