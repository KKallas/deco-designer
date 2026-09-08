# Part 19 — Reference image on a plane (trace the drawing)

Status: **built 2026-08-31**. Builds on Parts 1 (planes and curves), 4 (gizmos
and snapping), 13 (project textures).

## 1. What it is
A plane can carry one **reference image** — a scan or a PDF export of a
drawing — lying on the plane behind the curves, so shapes are drawn **by hand
on top of it** instead of being guessed from numbers. It can be moved, scaled,
rotated, faded, hidden and **locked**, and locked is the normal state: a locked
image is never picked, never dragged and never selected, so drawing over it
cannot disturb it.

## 2. Data
```ts
interface PlaneImage {
  texture: Id;        // a project texture (png / jpg / webp) — saved with the project
  center: Vec2;       // plane-local mm
  width: number;      // mm across the image; the height follows the pixel aspect
  rotation: number;   // degrees in the plane
  opacity: number;    // 0..1, default 0.35
  visible: boolean;   // shown at all
  locked: boolean;    // not pickable, not draggable
}
interface Plane { …; image: PlaneImage | null }
Project.version: 11   // 10 → 11: planes gain `image: null`
```
One command: `setPlaneImage(store, planeId, patch | null)` — `null` removes it.
The image lives in `project.textures`, so it rides along with save / load, the
IndexedDB autosave and the bridge like every other texture.

## 3. In the viewport
- A double-sided quad 8 mm behind the plane (`IMAGE_Z`, so bars drawn on the
  plane stay in front of it), `MeshBasicMaterial`
  (`map`, `transparent`, `opacity`, `toneMapped: false`, `depthWrite: false`,
  sRGB) so it reads as the drawing, not as a lit surface — the world, the AgX
  transform and the post chain do not touch it. Drawn under the grid, the
  curves and the helpers.
- Shown whenever the plane is visible and `image.visible` — in Object mode and
  in Edit mode alike, because tracing happens in Edit mode.
- **Locked** (the default after placing): the quad is not raycast at all —
  clicks, box select and the gizmo pass straight through it.
- **Unlocked**: a dashed outline and four corner handles show. Dragging inside
  it moves it, dragging a corner scales it about the opposite corner (aspect
  kept); the whole drag is one undo step. A corner handle wins a click, the
  body loses to any curve, so the image never steals a selection. Snapping is
  off for the image. Object mode only — in Edit mode the clicks are the curve's.

## 4. In the panel
A **Reference image** section under *Plane · <name>* (Object mode and the Edit
header):
- *Image*: dropdown of the project's image textures + **Add image…**
  (file picker, `IMAGE_ACCEPT`) — or drop an image file on the viewport while
  the plane is active. New images come in at width 2000 mm, centred on the
  plane origin, unlocked, opacity 0.35.
- **👁** visible · **🔒** locked · **×** remove.
- *Opacity* slider · *Width* (mm) · *Centre X / Y* (mm) · *Rotation* (°).
- **Set scale…**: click two points on the image, type the distance between them
  in mm (e.g. the drawing's 1160), and the image is scaled to match, keeping
  the first point where it is (Escape cancels). This is what makes a dimensioned
  drawing usable — everything traced on top of it is then in real mm.

## 5. Decisions (open to veto)
1. **One image per plane**, not a stack. Several drawings = several planes,
   which is how the sheet's three elements already sit.
2. **Locked is a per-image flag, not a plane-wide lock.** Nothing else about
   the plane changes.
3. **Not lit and not tone-mapped** — a reference is a reference, not a texture.
4. **Rotation by number only** (no rotate handle) — drawings come in square.
5. **Set scale… is part of this part**, not a later one: without it the image
   is only roughly right and every traced curve inherits the error.

## 6. Built
`Plane.image` + `normalizePlaneImage` / `defaultPlaneImage` (src/model/types.ts,
version 11) · `setPlaneImage` (src/app/commands.ts) · the quad, the corner
handles and the two drags + the calibration clicks (src/view3d/viewer.ts) ·
the *Reference image* section (src/ui/panel.ts) · the viewport drop
(src/main.ts) · tests/reference-image.test.ts.

## 7. Out of scope
Perspective / corner-pin warping · several images per plane · images in the
world or on the ground · PDF import (export a PNG) · auto-tracing.
