# Part 30 — Two layer stacks on a curve: the outline and the shape

Status: **built 2026-09-04** (asked for as "curves have two layer stacks:
outline — aluminium base, Decolight line on the inner side, on the outer side,
any combination; shape — a dynamic object that takes line(s) as base and has
layers to add PVC net, bubbles, …"). Replaces the one-profile curve of Part 14
and the panel of Part 28. Decisions taken without a round of questions are in
§8 — one word and any of them changes.

## 1. What it is
A curve is a **line**. Two stacks hang off it:

| stack | lives on | one layer is | examples |
|---|---|---|---|
| **Outline** | the curve itself (`curve.outline`) | a **profile** (a program *along the line*, Part 14) at a side offset and a lift, with its own params, material and fixture | aluminium flat bar on the line · LED string 14 mm outside it · LED string 14 mm inside it |
| **Shape** | its own object (`project.shapes`) built on **one or more curves** of a plane | a **fill** (a program *over the surface* the curves enclose), with params, material and a lift | the sheet · a PVC net · bubbles scattered over it |

Both stacks are ordered, every layer can be hidden, and both program kinds are
edited on the **programs page** (`shapes.html`, was the shapes page) — profiles
and fills side by side.

Vocabulary, because "shape" changes meaning: a **profile** is what the stock
dropdown always listed (the UI no longer calls it a shape); a **fill** is the new
program kind; the **outline** is the curve's profile stack; a **shape** is the
surface object. An **empty outline is legal**: the curve is then a construction
line that only shows as a thin guide — the base line of a shape, say.

## 2. Data (version 16)
```
OutlineLayer { id, profileId, params, materialId, color, offset, lift, pixels, visible }
CurveObject  { id, name, planeId, type, curve, constraints, outline: OutlineLayer[] }
                 // profileId / params / materialId / pixels → outline[0]

Fill         { id, label, code, params, color, metalness, roughness }   // project.fills; presets Sheet · PVC net · Bubbles
ShapeLayer   { id, fillId, params, materialId, color, offset, visible }
Shape        { id, name, curves: Id[], expand, resolution, layers: ShapeLayer[] }   // project.shapes (was panels)
```
- `OutlineLayer.offset`: mm **across the curve in its plane** — the sign rule
  of the offset tool (docs/29 §2): on a **closed** curve `+` is **outside**
  whichever way it was drawn, on an **open** one `+` is the **left-hand side**
  looking along it. `lift`: mm along the plane normal (+ in front). Both 0 =
  on the line, as before.
- `ShapeLayer.offset`: mm along the plane normal (the panel's `offset`).
  `Shape.expand` / `resolution` are the panel's, applied to every curve's loop.
- Effective params of a layer = `{ ...program.params, ...layer.params }`. A layer's
  `color` (null = the program's) is its look without a material; the card's *look*
  row has the picker in front of the material dropdown, ↺ goes back to the program's.
- 15 → 16: every curve's profile, params, material and fixture become its
  first outline layer (id `base`); every panel becomes a shape over its one
  curve with one **Sheet** layer carrying the material and offset;
  `project.fills` gets the Sheet preset when the file had none.

## 3. The outline
Each layer is built on **its own curve**: the drawn curve moved `offset` mm
sideways with the Tiller–Hanson offset of Part 29 (`offsetCurve`, mitred
corners, a curved side split where it strays > 0.2 mm) and lifted `lift` mm.
On a **spatial** curve the offset is taken in the plane (x, y) and every
vertex keeps its own z. The profile program then runs on that curve exactly
as in Part 14 — no program changes, the LED preset works on the inner and the
outer side alike.

- **Checks** run per layer on the layer's own curve against its profile's
  limits: a bar on the outside of a bend is longer and rounder, a string on
  the inside tighter. A violation names its layer (`Violation.layer`); the
  Constraints section lists the limits per layer.
- **Fixtures** are per layer (`layer.pixels`): the inner and the outer LED
  string are two fixtures with their own maps and columns. The pixel buffer
  keys its blocks by curve **and layer**.
- The fillet tool's default `r` is the **largest** minimum bend radius across
  the curve's layers — one click makes the bend legal for all of them.
- Array commit welds only curves whose outlines match (profiles, offsets and
  lifts, in order).
- Picking, selection, moving, editing: the curve is still one object; every
  layer mesh carries its `curveId`.

## 4. The shape
- **Curves**: any number, all on **one plane** (the first curve's; a curve on
  another plane is listed but skipped). Each curve gives one closed loop —
  an open curve is closed by the chord as in Part 28 — grown by `expand`
  outwards by its own winding. Loops nest **even-odd**: a loop inside one
  other loop is a **hole**, a loop inside two is an island, and so on — a
  frame with a cut-out is two curves.
- **The surface** handed to a fill program (plane-local mm, the plane matrix
  applied afterwards as for a panel):

  | field | |
  |---|---|
  | `loops` | the closed boundary loops after expand, `Vector3[][]` (outer anticlockwise, holes clockwise), every point with its own z |
  | `sheet` | the flat fill as a `BufferGeometry` — position, normal, uv in plane mm (what the Sheet preset returns) |
  | `area` | mm² |
  | `bounds` | `{ min, max }` in the plane |
  | `inside(x, y)` | even-odd test |
  | `heightAt(x, y)` | z of the sheet there (0 on planar curves) |
  | `clip(a, b)` | the pieces of the segment a→b that lie inside: `[Vector2, Vector2][]` |
  | `random(seed)` | a seeded generator → `() => number` in [0, 1) |
  | `planeNormal` | `(0, 0, 1)` |

  A fill is `(three, surface, params) => BufferGeometry`, `three` the same
  scope as a profile's (`sweep`, `rect`, `circle`, `mergeGeometries`, …).
  | `distanceToEdge(x, y)` | mm to the nearest edge of any loop (a hole's edge counts) |
- **Presets**: **Sheet** (`surface.sheet` — the panel; its colour is
  `checker`, the 100 mm board) · **PVC net** (`pitch` 50, `wire` Ø2,
  `angle` 0°: tubes along two families of lines clipped to the loops,
  following the sheet's height) · **Bubbles** (`count` 30 spheres in `sizes` 3
  different sizes — diameter `size` 60 down to half of it, the big ones placed
  first — every one at least `margin` 10 mm from the outline and from each
  other, resting on the sheet, `seed`ed; when the surface is too small for
  all of them the rest are left out).
- Default look of a layer without a material: the fill's **colour, metalness
  and roughness**, double-sided — Sheet and PVC net matte, Bubbles a polished
  red bauble (`#b3121e`, metalness 1, roughness 0.12; the colour stays a
  property of the fill, edited on the programs page). The colour `checker` =
  the 100 mm checkerboard.
- A shape is owned by the object that owns its first curve's plane (the
  panel's rule); deleting its last curve deletes it; duplicating an object
  brings it along.

## 5. UI
- **A layer card** has two parts that look different: the **head strip**
  (darker) names the layer — ▾ fold · 👁 · its number in the stack · the
  program dropdown (project entries, then *Add preset* / *Add from library*,
  which copy the program into the project when picked, then *… editor…*) ·
  a swatch, the violation badge and the offset in short (`+14 ↑5`) · ▲ ▼ · × —
  and the **body** below holds its properties. ▾ folds the body away for the
  session. Sub-sections (*Outline*, *Layers*, *Curves*, *Fixture*, *Vertex
  constraints*) have their own small ruled title with the actions on the
  right, distinct from a section's title.
- **Curve section** (Object mode): *type* and *plane*, then **Outline · n
  layers** with **＋ Layer**; a card's body: *place* (offset / lift, and the
  layer's own length when it is off the line), params (effective values,
  override in blue, ↺ clears), material, and the *Fixture* block when the
  profile numbers its lamps. With several curves selected a change goes to
  the same layer **index** on each.
- **Shape section**: the name, **Curves** as chips (× takes one out, the
  *＋ add…* dropdown adds another curve of the plane), *expand* / *res*, then
  **Layers · n** with **＋ Layer** (adds a Sheet); a card's body: *offset*,
  material, params.
- Long explanations moved from hints into tooltips; a hint is one line.
- **Outliner**: ▱ shapes under *Surfaces* (with their curves and layer count);
  a curve row shows its first profile.
- **Left rail › Surface**: ◫ Loft · **▱ Shape** — one shape over all the
  selected curves.
- **Programs page** (`shapes.html`): *Project profiles* · *Project fills* ·
  presets and library of both · the preview draws a profile on a curve and a
  fill on a surface (a 1000 × 600 sheet, a frame with a hole, or a project
  shape); the editor is the same for both kinds (a fill has metalness and
  roughness where a profile has limits).

## 6. Where it lives
- `src/geometry/surface.ts` (replaces panel.ts): loops, nesting,
  triangulation, `surfaceInput`, `buildFillGeometry`, the fill scope.
- `src/model/fills.ts`: the presets; `src/model/profiles.ts` unchanged.
- `src/checks`: `runChecks` per layer, `Violation.layer`.
- `Store.evals`: `CurveEval { sampling, layers: LayerEval[], violations, constraints }`,
  `LayerEval { layer, profile, curve, sampling, violations }`.
- Viewer: one mesh per (curve, layer) keyed `curve/layer` in the geometry,
  lamp and pixel caches; shapes built per layer.

## 7. Bridge
```js
const lid = cmd.addOutlineLayer(store, 'arch', { profileId: 'led-strip', offset: 14 })        // outside
cmd.addOutlineLayer(store, ['arch', 'heart'], { profileId: 'led-strip', offset: -14 })       // inside, one per curve
cmd.updateOutlineLayer(store, 'arch', lid, { lift: 5, params: { pitch: 30 }, visible: false })
cmd.moveOutlineLayer(store, 'arch', lid, 0); cmd.removeOutlineLayer(store, 'arch', lid)
cmd.setCurveProfile(store, ids, 'round15', 0)      // layer index, default 0 — also setCurveParams / setCurveMaterial / setCurvePixels / chainCurvePixels
const sid = cmd.addShape(store, ['frame', 'cutout'])                  // one shape, the second curve a hole
cmd.updateShape(store, sid, { expand: -10, resolution: 3, curves: ['frame'] })
const l2 = cmd.addShapeLayer(store, sid, { fillId: 'pvc-net', params: { pitch: 40 }, offset: 5 })
cmd.updateShapeLayer(store, sid, l2, { materialId: mid }); cmd.moveShapeLayer(store, sid, l2, 0); cmd.removeShapeLayer(store, sid, l2)
cmd.addFill(store, { label: 'Dots', code: '(three, surface, params) => …', params: {}, color: '#ffffff' })  // updateFill / removeFill / duplicateFill / moveFill
```
`overview()` prints `○ Arch · outline: flat25x2 · led-strip +14 ✦80px` and
`▱ Shape 1 · frame, cutout · layers: sheet · pvc-net`; `curve(id)` lists the
layers with their lengths and violations.

## 8. Decisions (mine, open to veto)
1. **Profile / fill / outline / shape** as the four words (§1). The stock
   dropdown says *profile* now; the page keeps its file name.
2. **Layers are real offset curves**, not a shader trick: the checks and the
   lengths a fabricator needs come out per layer.
3. **The offset sign follows the offset tool** (outside / left) rather than
   "inside / outside" words, because an open curve has no inside.
4. **A shape takes several curves and nests them even-odd** — the hole Part 28
   left out comes free; a loft stays a loft (no layers on it yet).
5. **Fills get their colour from the fill**, with `checker` for the sheet, so
   a fresh shape still reads as a surface.
6. **Panels are gone** (migrated); `addPanel` and friends are replaced by the
   shape commands.
7. Multi-curve commands address a layer by **index**, per-curve ones by id.

## 9. Out of scope
Layers on a loft · a fill that cuts the sheet (holes by texture) · trimming a
net to a profile's inner edge · a per-layer expand · offsetting the outline of
a spatial curve in 3D (it is offset in the plane) · thickness / solidify.
