# Part 35 — Outliner selection and editing several things at once

Status: **built 2026-09-08** (asked for as "fix the outliner, so the name
typeins are disabled (use properties to change names) and make sure shift and
control select work as expected with same class of objects. if two objects are
selected then the properties that differ are shown as -- lines and if you set
the value then it is set for both"). Builds on Part 3 (multi-select of curves),
Part 18 (several objects), Part 30 (layers). Decisions taken without a round of
questions are in §6.

## 1. What changed
- The outliner **names are labels**, not inputs. A name is changed in the
  properties pane (every section now starts with a *name* row). The edit
  header in Edit mode keeps its name field — it is the curve's property row
  there.
- **Shift-click** selects a **range** and **⌘ / Ctrl-click toggles** one row,
  within one **class** of rows: curves with curves, planes with planes, objects
  with objects, lofts, shapes, cameras likewise. A modifier click on a row of
  another class replaces the selection.
- With several things of one class selected the properties pane shows **one
  set of fields for all of them**: a field whose values agree shows the value;
  one whose values differ shows `--`; typing, picking or dragging a field
  **sets it on every selected one**.

## 2. Selection model (src/app/store.ts)
`Selection` grows a list per class next to the single ids that already
existed — the singles are the **primary** (the last picked) and stay the
thing the gizmo, the status bar and the bridge summary name:

| class   | list      | primary                  |
|---------|-----------|--------------------------|
| curves  | `curves`  | last of the list         |
| objects | `groups`  | last of the list         |
| planes  | `planes`  | `planeId` + `planeSelected` |
| lofts   | `lofts`   | `loftId`                 |
| shapes  | `shapes`  | `shapeId`                |
| cameras | `cameras` | `cameraId`               |

`Store.validate` keeps the two in step whichever side a command wrote: a
single without its list becomes a list of one; a list's last id becomes the
single; ids that no longer exist drop out. So every old command (`selectPlane`,
`selectLoft`, `addPlane`'s selection, agent scripts) still works unchanged, and
`selectPlanes` / `selectLofts` / `selectShapes` / `selectCameras` (and the
existing `selectCurves` / `selectGroups`) set a whole list. `planeId` stays
the *active* plane when the plane list empties.

## 3. Picking (src/ui/multi.ts)
`pickIds(current, id, order, mode)` is the whole of the rule, pure and tested:
- `replace` → `[id]`.
- `toggle` (⌘ / Ctrl) → `id` leaves the list if it is in it, else joins at the
  end (so it is the primary).
- `range` (Shift) → from the primary (the last of `current`) to `id` in
  `order`, the rows of that class in outliner order as drawn (folded rows are
  not in it); the range **joins** what was selected, and `id` becomes the
  primary. Without a primary in `order` it is a toggle.
`current` is the list of the clicked class when the selection is of that
class, empty otherwise — a modifier click across classes replaces.

The viewport is unchanged: Shift-click there still adds a curve or object
(⌘-click is pan). Only the outliner has ranges.

## 4. Shared fields
`shared(items, get)` → `{ value, mixed }`: the primary's value and whether any
item disagrees (deep, by JSON). Every field builder in src/ui/dom.ts takes
`mixed`: a number or text field shows `--` as its placeholder and no value, a
dropdown gains a `--` entry at the top that is selected, a checkbox is
indeterminate, a colour swatch is marked. **Dragging a mixed number field
scrubs from the primary's value** and, like typing, sets all.

Per section, with the primary last:
- **Curve**: name, type, plane; then the primary's outline layers, each
  against the same-index layer of every selected curve (a curve without that
  layer is skipped — the "changes go to the same layer" rule of Part 30):
  profile, visible, offset, lift, params, look colour, material, fixture.
- **Object**: name, parent, position, rotation; the buttons act on all (Group
  ⌘G appears with several).
- **Plane**: name, object, preset, position, rotation. The **array modifier
  and the reference image stay single-plane** sections (shown for one selected
  plane only) — they hold structure, not values.
- **Loft**: name, curve A / B, material, resolution, strips, flip and the four
  edge rows for A and B.
- **Shape**: name, expand, resolution and the fill layers by index (fill,
  visible, offset, look, material, params); the curve chips (structure) show
  for one shape only.
- **Camera**: name, film back, lens, depth of field, frame, pose. *Look
  through* and *Set from view* act on the primary; the world's fields (every
  camera's own, docs/36) show for one camera only.

## 5. Commands
The one-id commands that a section writes take `Id | Id[]`:
`renameCurve`, `setCurveType`, `setCurvePlane`, `renamePlane`,
`setPlanePlacement`, `setPlaneGroup`, `renameGroup`, `setGroupPlacement`,
`setGroupParent`, `updateLoft`, `setLoftEdge`, `setLoftMaterial`,
`updateShape`, `updateCamera`. New: `updateShapeLayers(ids, index, patch)`,
`removeShapeLayers(ids, index)`, `moveShapeLayers(ids, index, to)` — the
shape-side mirrors of the outline-layer commands. `Store.batch(fn)` runs
several commands as one undo step synchronously (a transaction without the
promise). `deleteSelection` / `duplicateSelection` act on the whole loft,
shape and plane lists.

## 6. Decisions taken
- Shift = range, ⌘/Ctrl = toggle (Finder / Blender outliner convention); the
  old Shift-toggle in the outliner is gone. A range **joins** the selection
  rather than replacing it.
- A name field with several selected follows the same rule as every other
  field (`--`, and typing names them all) — one rule, no exception.
- Structure stays single: a plane's array and image, a shape's curve list, a
  camera's world fields. Values are shared.
- The primary drives what is *listed* (which layers, how many); the others
  are edited through it by index.
