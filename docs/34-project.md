# Part 34 — Project a curve onto another plane

Status: **built 2026-09-08** (asked for as "in edit tools can you make project:
if you select a curve it will ask popup for plane and then make a new projection
curve on the plane"). Builds on Part 29 (the Modify section), Part 12 (3D
curves), Part 18 (nested frames). Decisions taken without a round of questions
are listed in §6 — one word and any of them changes.

## 1. What it is
Select one or more curves, press **⇩ Project** (`P`) in the **Modify** section
of the left rail: a popup asks **which plane**, and each selected curve lands on
that plane as a **new planar curve** — its shadow, cast straight down onto the
plane along the plane's normal. The originals are untouched; the copies are
selected afterwards, on the target plane, in one undo step.

It is the CAD *project to plane*: the way to get a top-view outline of a curve
drawn on the front plane, to trim against something drawn on another plane
(docs/29 §8 said "project it first"), or to flatten a 3D curve.

## 2. Maths
- The curve's vertices and **handles** go to world through the curve's plane
  frame (`planeWorld`, so nested objects and spatial `z` offsets count), then
  into the target plane's frame and the component along its normal is dropped.
- That is an affine map, and the affine image of a cubic Bézier is the cubic
  Bézier of the mapped control points — so the copy is **exact**, no sampling,
  no extra vertices. A polygon vertex stays a polygon (straight sides stay
  straight), an equal vertex stays equal (collinearity survives), a free one
  stays free. Closed stays closed.
- The copy is **planar** (`type: 'planar'`, every `z` = 0) even from a spatial
  source. Projecting onto the curve's own plane gives a plain copy.
- A curve whose projection **collapses** (its control points span under 0.1 mm
  — a straight line along the target's normal) is skipped and the bar / popup
  says so; the others still land.

## 3. What the copy carries
Name `<name> on <plane name>`, the whole outline stack (profiles, params,
materials, fixtures — as an offset copy does) and no constraints: it is a fresh
drawing.

## 4. The popup
`askChoice` in the middle of the window: one button per plane, labelled with
the plane's object path (`Rig › Top`), `Esc` / Cancel does nothing. The planes
offered are every plane in the project except the one all the selected curves
already lie on. With no other plane the popup only says to add one.

## 5. Where it lives
- `src/geometry/project.ts` — pure: `projectCurve(curve, from, to)` on two
  `PlaneFrame`s → `Curve | null`. Tests in `tests/project.test.ts`.
- Command `cmd.projectCurves(store, ids, planeId)` → the new ids (one undo
  step; `[]` when nothing could be projected).
- `projectSelectionAsked(store)` in src/ui/confirm.ts is the popup, called by
  the rail button (src/main.ts) and the `P` key in Object mode (the viewer).

```js
const ids = cmd.projectCurves(store, ['front-left'], 'top')   // → ['front-left-on-top']
```

## 6. Decisions (mine, open to veto)
1. **Along the target plane's normal.** The other candidates — along the
   source plane's normal, or along the view — give different curves; the
   target's normal is what "project onto a plane" means in every CAD tool and
   needs no extra question in the popup.
2. **A rail action on the selection, not a hover tool**: the ask was "select a
   curve, popup, new curve". No tool bar, no preview.
3. **Exact Bézier mapping**, not re-sampled — the copy has the same vertices
   as the source, so it stays editable the same way.
4. **Own plane left out of the popup** (a copy is what ⌘D is for); the command
   itself accepts any plane.
5. `P` is the key: free in Object mode (in Edit mode it still pins a vertex).
6. Collapsed projections are skipped, not made as zero-length curves.

## 7. Out of scope
Projection along a chosen direction or the view · a live (linked) projection
that follows the source · projecting lofts or shapes · intersecting a curve with
a plane.
