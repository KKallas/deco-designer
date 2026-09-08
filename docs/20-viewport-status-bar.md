# Part 20 — Viewport status bar and framing

Status: **built 2026-08-31**; the bar itself became the **right toolbar rail**
in Part 23 (docs/23-toolbar-rails.md) — the buttons, the wording of §2 and the
framing of §3 are unchanged, only the layout of §1 and §4 is superseded.
Builds on Parts 8 (selection filter), 11 (navigation), 15 (view tools).

## 1. What it is
One bar across the full width of the 3D viewport (`.view-bar`, above the gizmo
rail and the navigation cube, which moved down under it):

```
┌──────────────────────────────────────────────────────────────────┐
│ 2 curves · Front  ⊙▤⛶            ○◫▤▣             ✦⚙ │
└──────────────────────────────────────────────────────────────────┘
```

- **Left**: what is selected, in words, then the three framing buttons.
- **Centre**: the selection filter of Part 8 — same four toggles, same keys
  `1`–`4`, now icon buttons (curve `○`, loft `◫`, plane `▤`, object `▣`, the
  outliner's icons), centred on the viewport.
- **Right**: the render view — `✦` the post-processing script on / off, `⚙`
  (and since Part 32 `⧉` renders a still of the camera frame, docs/32) and `⚙`
  its editor (docs/15), moved off the app topbar.

Every group is the same segmented strip of 28 × 26 px icon buttons (`.seg`).
The gizmo rail moves down to sit under the bar.

## 2. The status text
The lowest thing that is selected wins, and it reads like the outliner:

| state | text |
|---|---|
| Edit mode | `Edit · <curve> · 2 / 7 points` (or `· 7 points` with none selected) |
| objects | `<name>` · or `3 objects` |
| plane | `Plane · <name>` |
| loft | `Loft · <name>` |
| curves | `<curve>` or `4 curves`, then `· <plane>` |
| camera | `Camera · <name>` |
| world | `World` |
| nothing | `Nothing selected` (dim) |

It is a label, not a control — clicking it does nothing.

## 3. Framing (Blender's numpad `.`)
Each button puts the orbit pivot on the centre of a bounding box and zooms the
view to its extents — the camera keeps its direction and only slides along it
(orthographic changes `zoom` instead), so framing never re-orients the view.
An empty or tiny box is padded to 200 mm so a single point does not zoom in
for ever.

| button | key | what it frames |
|---|---|---|
| **⊙ Selected** | `.` (numpad `.` too) | the selection: the selected vertices in Edit mode, else the selected objects (with everything inside them), plane, loft, curves or camera |
| **▤ Plane** | — | everything on the active plane |
| **⛶ All** | `F` | the whole scene (the existing *Fit*, unchanged) |
| **⊥ Plane view** | `Home` | not framing: looks straight at the active plane (moved off the app topbar) |

The box comes from the meshes actually in the scene, so array instances,
profile thickness and lofts all count; a plane with nothing on it frames its
origin. With nothing selected, ⊙ falls back to framing everything (rather than
doing nothing as Blender does) — a `.` should always leave you looking at
something. In Edit mode `F` and ⊙ keep the plane-aligned view of Part 11: only
the pivot and the zoom change.

## 4. Decisions
1. The status text stays a *label*; selection is still made in the viewport and the outliner.
2. The filter and the post buttons are **moved, not duplicated** — one home each.
3. No new shortcut for *Plane* framing; `.` = selected and `F` = all are enough, `Home` still aims at the plane.
4. The bar runs edge to edge (10 px margins) and the navigation cube moved down to `top: 46 px` to make room, so the render buttons reach the right edge of the frame and the filter centres on the viewport.

## 5. The rail owns *what to add*, the topbar keeps the project
The three creation buttons left the app topbar for the top of the viewport
rail, above the gizmo modes:

| button | what it does |
|---|---|
| **▤** | add a plane, with the preset the **▾** under it picks (Front (XY) / Top (XZ) / Side (YZ); picking one also adds a plane, and it is remembered for the next ▤) |
| **○** | add a curve on the active plane and edit it (creates a plane first if there is none) |
| **◉** | a camera object from the current view, looked through |

What is left in the app topbar is the project and nothing about the viewport:
the name, the mode badge, the animation transport, undo / redo and the backend
status. Framing (`⛶`), the plane view (`⊥`) and the post buttons (`✦ ⚙`) all
live on the viewport bar; the gizmo, the tools on the selection and now the
creation buttons on the rail.

## 6. Out of scope
Per-view statistics (vertex / triangle counts) · a pivot-point mode menu
(bounding box vs. median vs. cursor) · framing from the outliner rows.
