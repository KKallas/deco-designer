# Part 28 — A plane out of a curve, and the tool rail in subsections

Status: **built 2026-09-04**, then **replaced by Part 30** (docs/30-outline-and-shape-layers.md,
same day): a panel is now a *shape* over one or more curves with fill layers; the
boundary, expand and mitre rules below still hold, per loop. Builds on Part 5 (loft), Part 8 (selection filter),
Part 23 (toolbar rails), Part 24 (loft trims).

## 1. What it is
A second kind of surface next to the loft: one curve in, a **flat sheet filling
it** out. The frame is aluminium, this is the thing inside the frame — a panel,
an acrylic, a mesh, a printed graphic.

```
Panel { id, name, curve: Id, materialId, offset, expand, resolution }   // mm
```

Three numbers do the work:

| | |
|---|---|
| **offset** | mm along the plane normal — **+ in front** of the curve, **− behind** it (the loft's `lift`, docs/24 §3b) |
| **expand** | mm in the plane — **+ bigger** than the curve, **− smaller**; 0 = exactly on it |
| **resolution** | `4 × resolution` samples per **curved** side; a straight side keeps just its own vertices, so a polygon comes out exactly as drawn |

The curve is never touched: it keeps its profile, its length and its checks. A
panel is its own object in the outliner, deleted and duplicated on its own.

## 2. The boundary
- A **closed** curve is the boundary as drawn.
- An **open** curve is **closed by a straight chord** from its last vertex back
  to its first, and that region is filled. One rule for both, and drawing three
  sides of a shape gets you the sheet.
- **Spatial** curves (docs/12): the boundary is triangulated **in the plane**
  (the curve seen flat, its `z` ignored for the triangulation) and every point
  then keeps its own `z` — a warped sheet, a tent, not a re-projected flat one.
- A boundary that **crosses itself** is filled as it comes out of the
  triangulator: not cleaned, not clamped, the same stance as an inward loft
  offset. Fewer than 3 samples, or zero area → **no mesh**, and it comes back as
  soon as the curve makes sense again.

## 3. Expand and shrink
`expand` slides every **side** of the outline along its own outward normal in
the plane — away from the interior (the winding decides which way is out, so a
clockwise and an anticlockwise curve both grow outwards when the number is
positive) — and puts each point back where its two offset sides **meet**:

- Corners are **mitred**, so a rectangle grown by 10 mm is a rectangle, not a
  chamfered one. A corner sharper than the mitre limit (4 × `expand`) is cut off
  instead of shooting away.
- The whole loop moves, the chord of an open curve included.
- The offset is applied to the **samples**, before triangulation, so a round
  corner stays round and a sharp one stays sharp.
- Nothing is cleaned up afterwards: a shrink deeper than a curved outline's own
  radius makes the boundary cross itself and the sheet folds. Legitimate, and
  visible — the same stance as an inward loft offset.

## 4. Look
- Default material: the loft's **100 mm checkerboard**, double-sided, so a fresh
  panel reads as a surface and not as a hole.
- `materialId` takes any project material, like a loft.
- **UVs are plane-local millimetres**: `u` = local x mm, `v` = local y mm of the
  plane the curve is drawn on. So a texture keeps its physical size, and two
  panels on the same plane line up.

## 5. Where it lives
- `project.panels: Panel[]`, version **15** (older files load with `panels: []`).
- Owned by the object that owns the curve's plane, exactly like a loft's owner
  rule (docs/18) — it moves with the object, hides with it, exports with it.
- **Picking**: `PickHit` grows a `panelId`; `selection.panelId` is the selected
  one. The right rail's **◫** filter (key 2) is renamed from *Loft* to
  **Surface** and covers both lofts and panels — no fifth level, no fifth key.
- Deleting the curve (or its plane, or the object around it) deletes its panels;
  duplicating an object brings them along, as it does the lofts.
- The outliner's *Lofts* subsection is now **Surfaces**: ◫ lofts, then ▱ panels.

## 6. UI
- Left rail, new **Surface** section (orange), taken out of *Tools*:
  **◫ Loft** (2 curves) · **▱ Plane** (1+ curves — one panel per curve).
- Panel section in the properties panel when one is selected: *Curve* (read
  only), *Offset*, *Expand*, *Resolution*, *Material* — scrubbable number fields
  (docs/25).

### 6.1 The rail in subsections
Today's left rail is Add · Gizmo · **Tools** (✎ ⧉ ⋈ ◫ ▣ ✕), and Tools is where
everything unrelated has been landing. It splits into named cards, same widget,
same colours-with-a-job rule (docs/23 §2):

| rail | section | colour | buttons |
|---|---|---|---|
| left | **Add** | green | ▤ Plane (▾) · ○ Curve · ◉ Camera |
| left | **Gizmo** | blue | ✥ Move · ↻ Rotate · ⤢ Scale · ＋ Add points · ◎ Focus |
| left | **Edit** | amber | ✎ Edit · ⧉ Duplicate · ⋈ Join |
| left | **Surface** | orange `#e08a4f` | ◫ Loft · ▱ Plane |
| left | **Object** | amber | ▣ Group · ✕ Delete |

A section with nothing to show is left out, as before (Edit mode still shows Add
and Gizmo only). The right rail is unchanged apart from *Loft* → *Surface*.

## 7. Bridge
```js
const pid = cmd.addPanel(store, 'front-left');                  // → new panel id (one curve)
cmd.addPanel(store, ['a', 'b']);                                // → one panel each
cmd.updatePanel(store, pid, { offset: -12, expand: -3, resolution: 4 });
cmd.setPanelMaterial(store, pid, mid); cmd.removePanel(store, pid);
```
`overview()` prints panels under their owner as `▱ Name [id] · curve · offset / expand`.

## 8. Decisions
1. **One curve, one surface** — not a "surface" object with a mode switch. A
   loft needs two curves and rulings; a panel needs one and a triangulator.
2. **Open curves fill** (chord-closed) rather than greying the tool out.
3. **One signed offset**, not up + down: a sheet, not a slab. Thickness, if it
   is ever wanted, is a modifier on top and not two numbers here.
4. **`expand` offsets the samples**, not the Bézier — cheap, exact enough at
   `resolution × vertices`, and it never changes the curve.
5. The model, the outliner and the bridge call it a **Panel**, because `Plane`
   is already the drawing plane (▤ Plane in Add, in Frame and in Select). The
   **rail button says ▱ Plane**, as asked, tooltip *"Plane from the selected
   curve"*. One word from you and I will make both say the same thing.

## 9. Out of scope
Holes (a panel inside a panel) · thickness / solidify · trimming a panel against
another surface · filling the gap between two curves (that is a loft) · cleaning
up the self-intersections a deep shrink makes · repeating with the plane's array
modifier (a panel is built once, as a loft is) · anything unfolding to a cut sheet.
