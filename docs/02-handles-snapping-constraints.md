# Part 2 — Handles, alignment snapping, vertex constraints

Status: **agreed 2026-08-25**, built. Decisions: partner vertex follows the drag (solver); three handle types Auto / Smooth / Corner; alignment snapping considers every object projected onto the edit plane.

> **Superseded in part:** § 1's three types (Auto / Smooth / Corner) became
> **Polygon / Equal / Free**, Polygon the default — docs/27-vertex-types.md.
> Everything else here (snapping, constraints) still stands.

## 1. Curve handles

The curve becomes a cubic Bézier through **vertices**; each vertex has an
*in* and an *out* handle and a **type**:

| Type | Behaviour | Default for |
|---|---|---|
| **Auto** | Handles computed automatically (same smooth shape as today). Dragging a handle turns the vertex into *Smooth*. | new vertices |
| **Smooth** | In/out handles stay collinear (mirrored through the vertex); dragging one rotates both, lengths independent. | |
| **Corner** | In/out handles independent. Handle length 0 on both sides = sharp corner. | |

- `V` cycles the type of the selected vertex (Auto → Smooth → Corner → Auto).
- Right-click on a vertex opens a small menu with the three types (and, with two vertices selected, the constraints below).
- Handles are drawn only for the primary selected vertex, as a thin accent line with round ends; drag them like points. Auto handles are drawn dimmer.
- Inserting a vertex on the curve splits the Bézier (de Casteljau) so the shape is kept; neighbouring *Auto* vertices recompute their handles, which can shift the shape by a few mm — as in Blender.
- Bend-radius checks run on the Bézier exactly as today; a Corner vertex with zero handles is a sharp bend → flagged.

Data: `Vertex { id, x, y, type: 'auto' | 'smooth' | 'corner', in: Vec2, out: Vec2 }` (handles relative to the vertex). Existing projects migrate: every point becomes an *Auto* vertex, shape unchanged.

## 2. Alignment snapping (pink guides)

While dragging a vertex or handle, it snaps to be **horizontally and/or vertically aligned** with:
- the other vertices of the same curve,
- vertices of every other object, projected onto the edit plane,
- for handles: also their own vertex (exactly horizontal / vertical tangent).

Rules: snap distance 8 px on screen; horizontal and vertical snap independently, so both can hold at once (the point lands on the intersection). A held snap draws a **pink guide line** through the aligned vertices, with a small marker on the source vertex. Grid snap (10 mm) still applies when no alignment snap holds; `Shift` disables all snapping. A toggle in the Curve section turns alignment snapping off.

## 3. Vertex constraints

Constraints are attached to vertices of one object and kept true whenever anything moves:

| Constraint | Between | Meaning |
|---|---|---|
| **Keep horizontal** | 2 vertices | same Y (plane coordinates) |
| **Keep vertical** | 2 vertices | same X |
| **Distance** | 2 vertices | fixed distance (default = current, editable in the panel) |
| **Pin** | 1 vertex | does not move (optional, cheap to add) |

- Create: select two vertices (`Shift`-click), then right-click → constraint, or shortcuts `H` (horizontal), `Shift+V` (vertical), `D` (distance).
- Constrained vertices show a small glyph (— | ↔ ⌖) next to them, and a line for distance with the value.
- The **Constraints** window gets a second list: vertex constraints of this object, each with delete and (for distance) an editable value. A constraint that cannot be satisfied is shown red.
- Solver: small iterative projection (a few passes per move); the vertex being dragged is treated as fixed — see the open decision below.

Data: `DecoObject.constraints: { id, type, a: vertexId, b?: vertexId, value?: number }[]`.

## 4. Decisions
1. Dragging a constrained vertex: the **partner follows**; pinned vertices never move (a pinned vertex cannot be dragged).
2. Handle types: **Auto / Smooth / Corner**; corner vertices are drawn as diamonds.
3. Alignment snapping uses **all objects**, their vertices projected onto the edit plane.

## 5. Out of scope
Angle / parallel / equal constraints · snapping to curve midpoints or intersections · constraints between objects.
