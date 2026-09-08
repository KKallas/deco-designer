# Part 21 — Navigation cube: drag to spin, one ▾ for the view tools

Status: **built 2026-08-31**. Builds on Part 11 (navigation) and Part 20
(status bar), which moved the cube down under the bar.

## 1. The cube is a controller
The cube is no longer only a set of click targets — a **drag on it pulls the
view around like a ball**:

- press and drag anywhere on the cube → the view orbits about the current
  pivot, exactly as a drag in the viewport does (the scene follows the
  pointer). Across the cube's width is half a turn (`dx / 110 px · 180°`),
  the same for the vertical.
- the pivot and the distance never change — only the direction, so a spin
  never loses what you were looking at.
- release without moving (< 4 px) → the old behaviour: snap to the face, edge
  or corner under the pointer.
- the hover highlight goes out while spinning; the cursor is `grab` over the
  cube and `grabbing` while it turns. A spin cancels a running snap animation.

`Viewer.spinCube` (src/view3d/viewer.ts) does it in the camera's own up frame
(the same quaternion trick OrbitControls uses), so it also works in Edit mode
where the camera is aligned to a plane; the polar angle is clamped just short
of the poles.

## 2. One ▾ under the cube
The camera and projection dropdowns no longer sit under the cube taking up two
rows: a single **▾** button sits centred under it and opens them in a popup
(`.view-tools .pop`, hanging from the cube's right edge). Its tooltip says what
the view is now — the camera being looked through and the projection (since
docs/36 there is always a camera; the dropdown's last entry makes a new one
from the view). The popup closes on a click anywhere else, on `Escape`, or on ▾ again,
and the whole thing is hidden in Edit mode as before.

## 3. Decisions
1. Drag = orbit with the same feel and signs as the viewport, not a trackball with roll: the cube keeps the world's up, so the horizon stays level.
2. The click-to-snap zones are unchanged — a drag and a click are told apart by the same 4 px the rest of the viewport uses.
3. The popup is a viewport widget, not a panel section: the view is a property of the viewport, not of the project.

## 4. Out of scope
Rolling the view (spinning about the view axis) · dragging the cube to *pan* ·
a home button on the cube.
