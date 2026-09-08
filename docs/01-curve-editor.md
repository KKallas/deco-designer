# Part 1 — Curve objects and the curve editor

Status: **agreed 2026-08-25**, being built.
Decisions: the curve is edited **in the 3D viewport, aligned to its plane**
(one viewport); an object is **exactly one curve**; the earlier live-file
workspace / JS rule editor / library code was removed from the repo (archived
at `/private/tmp/deco-designer-parked-2026-08-25.tar.gz`) and will be redone
cleanly in a later part.

## 1. Concepts

| Term | Meaning |
|---|---|
| **Object** | One 2D curve, bent from one **profile**, placed on one **plane** in 3D, with an optional **array modifier**. The unit you select and move in Object mode. |
| **Curve** | Control points + open/closed flag. Smooth spline through the points. Always edited in 2D, on the object's plane. |
| **Profile** ("shape") | The stock the curve is bent from: **flat bar 25×2 mm** (default) or **round tube Ø15 mm**. Each profile carries its **limitations**. |
| **Limitation** | A check that applies to every curve using that profile: minimum bend radius, stock length, (later more). Violations are drawn on the curve in the editor and listed in the constraints window. |
| **Plane** | Where the curve lives: a preset (Front XY, Top XZ, Side YZ) or a custom position + rotation. Chosen when creating an object, editable afterwards. |
| **Array modifier** | Repeats the object like Blender's Array: **linear** (count, offset) or **circular** (count, centre, total angle) around the plane normal. Instances are previews of the same curve; checks run on the base curve. |

An object has exactly one curve. Several curves on the same plane = several objects with the same plane.

## 2. Modes

### Object mode (global)
- 3D viewer shows all objects (with their array instances).
- Click selects an object; drag (or type in the panel) moves it **within its plane**; the plane itself can be changed in the panel.
- Actions: **New object** (pick plane → enters Edit mode with an empty curve), Duplicate, Delete.
- `Tab` or double-click enters Edit mode on the selected object.

### Edit mode
- 2D editor on the object's plane: draw points, drag points, insert/delete points, open/close.
- **Constraints window** (panel): choose the profile for this object → the profile's limitations are listed with their values and current status (✓ / ✗ with the reason). Nothing else in this window for now.
- **Modifier section**: none / linear / circular with their parameters; the 3D viewer shows the instances live.
- Editing: click on the plane appends a point, click on the curve inserts one there, drag a point to move it (grid snap 10 mm, `Shift` = free), `Del` removes the selected point, `C` opens/closes.
- `Tab` / `Esc` returns to Object mode (an object left without a curve is dropped).

## 3. Viewer
- One 3D viewport (WebGPU, WebGL2 fallback) with a **navigation cube** in the corner: click a face / edge / corner to snap the camera to that view; drag anywhere (middle mouse, or left mouse on empty space in Object mode) to orbit; right mouse pans; wheel zooms.
- **Edit mode is in the same viewport**: entering Edit mode snaps an orthographic camera onto the object's plane, and points are picked by projecting the pointer onto that plane — so the curve is always edited *in 2D on its plane*, even if you tilt the view with the cube to inspect it. The `⊥` button (or `Home`) returns the camera to the plane view.
- Object mode uses a perspective camera.

## 4. Data model (JSON, mm)

```ts
Project   { version: 3, name, profiles: Profile[], objects: DecoObject[] }
Profile   { id, label, shape: 'flat' | 'round' | 'square' | 'rect', a, b, t, rotate, color,
            limits: { minBendRadius: number, maxLength: number } }
DecoObject{ id, name, profileId, plane: Placement, curve: { points: Vec2[], closed },
            array?: { type: 'linear', count, offset: Vec3 }
                  | { type: 'circular', count, center: Vec2, angle: number } }
Placement { preset?: 'front' | 'top' | 'side', position: Vec3, rotation: Vec3 /* degrees */ }
```

Defaults: `flat25x2` → minBendRadius 15, `round15` → minBendRadius 45 (both to be confirmed); maxLength 6000.

## 5. UI layout

```
┌ top bar: project name · mode badge · New object (plane) · undo/redo ──────┐
│ 3D viewport + nav cube                                  │ panel            │
│  Object mode: all objects + instances, click to select, │  Object mode:    │
│               drag to move in plane                     │   Objects list   │
│  Edit mode:   ortho view onto the plane, grid, points,  │   Placement      │
│               violations in colour                      │  Edit mode:      │
│                                                         │   Constraints    │
│                                                         │   Modifier       │
└─────────────────────────────────────────────────────────┴──────────────────┘
```

Keys: `Tab` edit/object · `Esc` back/deselect · `Del` delete point/object · `C` open/close · `G` snap · `F` fit · `Home` plane view · `⌘Z`/`⇧⌘Z` undo/redo.

## 6. Code pattern (to keep it tidy)

```
src/model/      types + pure functions: project, object, profile, placement, array
src/geometry/   pure geometry: curve sampling & bend radius, profile shape, instancing
src/checks/     limitation checks (pure): (object, profile) → violations[]
src/view3d/     renderer, scene builder, navigation cube, in-viewport editing
src/ui/         panel sections (objects, constraints, modifier)
src/app/        state store, commands (undoable), modes
docs/           one spec per part, written before the code
```

Rules of the pattern: one state store; UI only dispatches named **commands** (undoable); views render from state; no DOM in `model`, `geometry`, `checks`; no three.js in `model`, `checks`.

## 7. Out of scope for Part 1 (kept for later parts)
Lofts and lights · editable JS rule layers UI · live JS-file workspace · library save/load · BOM/export.
