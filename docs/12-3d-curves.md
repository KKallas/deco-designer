# Part 12 — 3D curves (plane + offset along the normal)

Status: **built 2026-08-26** (asked for directly; spec written with the code —
the decisions in §5 are open to veto). Builds on Parts 1, 2, 4 and 11. This is
the control curve for the custom pipe objects and LED lights of a later part.

## 1. What it is
A curve object gets a **type**:

| Type | Vertices | Where it is edited |
|---|---|---|
| **Planar** (default, every curve so far) | `(x, y)` on the plane, `z` always 0 | in 2D on the plane, as today |
| **3D** | `(x, y)` on the plane **plus `z` = offset along the plane normal** (mm) | `x, y` in 2D on the plane as today; `z` with the gizmo's Z arrow, `Alt`-drag, or the number field |

Everything else stays: one profile, constraints, materials, lofts, array
copies, groups. A 3D curve is still *drawn on its plane* — the plane is its
2D frame, the offsets lift vertices (and handles) out of it. Switching a
3D curve back to planar flattens it (`z` → 0, undoable).

## 2. Data
```
CurveObject.type: 'planar' | 'spatial'     // 'planar' if absent
Vertex { id, x, y, z, type, in: Vec3, out: Vec3 }   // z and handle z are 0 on planar curves
VertexConstraint.at?: Vec3                  // pins remember z too
Project.version: 5                          // 4 → 5: z = 0 everywhere, type = 'planar'
```
Handles are relative 3D vectors; a *Polygon* vertex reads as zero handles,
*Equal* keeps in/out collinear in 3D (the types are Part 27's — this part was
written with Auto / Smooth / Corner). The store enforces
`z = 0` on planar curves (also for agent scripts).

## 3. Geometry and checks
- The path is a 3D cubic Bézier in plane-local `(x, y, z)`; world = plane matrix × local, so array copies, lofts and the pipe mesh need no special case.
- **Bend radius** is measured in 3D (angle between neighbouring tangents ÷ arc length); on planar curves this is exactly the Part 1 value. **Stock length** is the 3D length.
- The profile is swept along the 3D path with three.js Frenet frames: round tubes look the same everywhere; a **flat bar on a 3D curve may roll along the way** — a controlled orientation is part of the pipe / LED program (next part), not of the curve.
- Constraints: *horizontal* / *vertical* are plane relations (`y` / `x`) as before; *distance* is the **3D** distance on a 3D curve; *pin* holds `x, y, z`.

## 4. Editing
- **Curve section** (Object mode) and the Edit-mode **Curve** section get a *type* dropdown (Planar / 3D).
- In Edit mode the vertex row shows **x, y, z** number fields (z only on 3D curves) — type a value, the constraint solver runs as for a drag.
- The Edit-mode gizmo of a 3D curve shows the **Z arrow** in Move mode: it moves the selected vertices (and handles) along the normal, grid-snapped to 10 mm. The arrow points at the camera in the aligned plane view, so tilt with the navigation cube to grab it.
- **`Alt`-drag on a vertex** moves the selection along the normal: the mouse is projected onto the normal's screen direction (in the straight-on view, where the normal has no screen direction, up = +z). Snaps to 10 mm unless `Shift`.
- Vertices are dragged in the plane parallel to the drawing plane through the vertex (so a raised vertex stays under the pointer in a tilted view); a new vertex appended with the add tool takes the `z` of the previous vertex.
- Feedback: on a 3D curve every vertex with `z ≠ 0` gets a thin dashed **drop line** to its foot on the plane; the panel and `curve <id>` in the bridge print `z`.
- Object-mode moves / rotations / scales of curves are in-plane and leave `z` alone; scaling a whole **object** scales `z` with it (the object stays similar).

## 5. Decisions (taken to keep moving — say so if you want them changed)
1. A 3D curve is a **type of the existing curve object**, not a new object kind, so lofts, groups, arrays and materials work unchanged.
2. `z` is stored **per vertex in plane coordinates** (not world space): moving or rotating the plane carries the curve with it.
3. Bend-radius / length checks apply to 3D curves exactly like planar ones; profile roll along a 3D curve is left to the next part.
4. Alt-drag = move along the normal (Alt on empty space is still the additive box).

## 6. Out of scope
Rotating vertices out of the plane (X/Y rings) · profile twist / up-vector control · 3D alignment snapping (guides stay in-plane) · a free-form 3D polyline without a plane.
