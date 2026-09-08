# Part 14 — Shapes as code (a profile is a program that renders a curve as a mesh)

Status: **built 2026-08-26** (asked for directly; spec written with the code —
the decisions in §5 are open to veto). **Part 30** (docs/30) renamed the concept in
the UI to *profile* (a curve now carries a stack of them, its *outline*), added the
*fill* program kind over a surface, and made the shapes page the *programs* page. Builds on Parts 1 (profiles and their
limits), 12 (3D curves) and 13 (materials page, channel). This is the
"program from a control curve" the 3D curve was made for.

## 1. What it is
The **shape** a curve is bent from — flat bar, round tube, so far four fixed
kinds with numbers — is now **code**:

```js
(three, curve, params) => three.BufferGeometry   // position, normal, uv (uv in mm), plane-local mm
```

`Profile` keeps its id, label, colour and bend limits (the checks are
unchanged) and gains `code` + `params`. The two defaults are the presets
*Flat bar* and *Round tube* with their numbers as params; *Box section* and
the **LED string** are presets too — the latter is `strands` wires twisted
around the curve (outer Ø `wireDiameter`, one turn per `twistPitch`) with an
LED every `pitch` mm standing on the wire in a seeded-random direction:
`ledWidth` square, `ledHeight` long, the outer `lit` fraction luminous
(emissive vertices), the rest white plastic like the wires. The curve's *shape* dropdown is the same one as
before, listing the project's shapes, plus a last line **Shape editor…** that
opens **/shapes.html** — the materials page's twin (own tab, mirrored over the
channel, no import): project shapes, presets, a browser library, a 3D preview
on a sample curve or any project curve with a 100 mm UV checker / the shape
colour / a project material, and the editor: name, colour, limits, a parameter
table, the code. Every curve bent from a shape re-renders when its code or
params change; a curve may override params (number fields under the
dropdown).

## 2. Data
```
Profile { id, label, code, params: Record<string, number>, color, limits }   // was: shape, a, b, t, rotate
CurveObject.params: Record<string, number>     // per-curve overrides of the profile's params
Project.version: 6                             // 5 → 6: profiles become code (same look), curves get params
```
Effective params of a curve = `{ ...profile.params, ...curve.params }`.
Old files: `flat` → *Flat bar* `{ width: a, thickness: b, rotate }`, `round` →
*Round tube* `{ diameter: a, wall: t }`, `square` / `rect` → *Box section*.

Commands: `addProfile`, `updateProfile` (label / code / params / colour /
limits), `removeProfile` (curves move to the first remaining; the last one
stays), `duplicateProfile`, `moveProfile`, `setCurveProfile(store, ids, id)`,
`setCurveParams(store, ids, patch | null)`, `setLimit` as before. `overview()`
lists `Shapes:` with params and limits and shows `params {…}` on curves.

## 3. The program
`buildShapeGeometry(code, input, params)` (src/geometry/shape.ts) runs the
code with

| argument | what it is |
|---|---|
| `three` | the three.js namespace (`BufferGeometry`, `TubeGeometry`, `ExtrudeGeometry`, `Vector3`, `Matrix4`, …) plus **`sweep`**, **`rect`**, **`circle`**, `mergeGeometries` |
| `curve` | `id`, `name`, `points` (control vertices with handles, plane-local mm), `closed`, `path` (the cubic Bézier `CurvePath`), `length` (mm), `samples` (every ~5 mm: `x y z t s curvature radius`), `frames(steps)` → `{ points, tangents, normals, binormals }` (parallel transport), `planeNormal` (`0 0 1`) |
| `params` | the effective parameters |

**`three.sweep(curve, outline, { holes, rotate, up, steps, caps, smoothAngle })`**
(src/geometry/sweep.ts) is what the stock presets use: an outline in mm
(x sideways in the plane, y along the plane normal), optional holes, swept
along the curve with sections perpendicular to it. `up: 'plane'` (default)
keeps the section's y on the plane normal — the stock orientation, **no roll
on 3D curves** (the question Part 12 left open); `up: 'frenet'` follows the
transported frame. uv: u = arc length, v = distance around the section (mm);
corners sharper than `smoothAngle` (40°) are hard edges, circles stay smooth;
open curves get end caps (a hollow tube shows its wall).

A program may also write **`color`** and **`emissive`** vertex attributes
(vec3): the default look (no material assigned) renders them — that is how
the LED string's tips glow; a project material may read
`attribute('emissive')` itself. The viewport and the page previews run a
Blender / Eevee-like chain (src/view3d/effects.ts): the AgX view transform
over a room environment the metallic stock reflects; a wide soft **bloom**
with a knee (threshold 0.8, knee 0.5 — Eevee's numbers) fed by the
**emissive channel** plus whatever the colour clips above 1, so the LED tips
(1.6) and hot reflections glow while the blue selection glow (0.45) does not;
four **glare streaks** and a pseudo **lens flare** (ghosts) from that bloom.
The topbar's **✦** toggles all of it (remembered per browser); off is the
plain render of the earlier parts. The chain's nodes are gated per render
call, not per frame id — with the viewer's loop the per-frame gating left
them frozen on their first frame. The result is checked: normals are computed
if missing, missing uvs are reported on the page. Code that throws makes the curve fall back to a thin
Ø8 tube with one console warning (as broken materials do).

## 4. UI
- **Curve section** (Object mode) and the Edit-mode constraints header:
  the *shape* dropdown as before plus **Shape editor…**; under it one number
  field per parameter — the effective value; typing overrides it on the
  selected curves (blue border), ↺ clears the override. The outliner shows
  the shape's label.
- **Shapes page** (shapes.html, src/shapes/main.ts): left *Project shapes*
  (drag to reorder, colour, curves bent from it) · *Presets* · *Library (this
  browser)* · *Preview on* (S-bend / closed loop / lifted 3D / a project
  curve) with *material* (UV checker 100 mm / shape colour / a project
  material). Centre: the mesh on that curve, the curve drawn through it.
  Bottom: name, *Use on selection*, *Duplicate*, *Save to library*, *Remove*;
  colour and limits (min bend R, max length); the parameter table (name,
  default, ×, ＋); the code editor with *Apply* (`⌘⏎`: build, preview, save —
  for a preset / library entry *Preview* only, *Add to project* takes the
  edits), *Revert*, *Copy*, *Download .js*; the status line shows vertices /
  triangles / uv / build time or the error.
- The channel whitelist gains the profile commands and `setLimit`.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **Shape = profile** (your clarification): one concept, the existing dropdown, the checks stay on it. There is no separate render-only layer.
2. **Sections stay flat to the plane by default** (`up: 'plane'`): a flat bar on a lifted curve does not roll; programs can ask for `'frenet'`.
3. **Parameters are numbers**, declared on the shape and overridable per curve — enough for sizes, pitches and counts; no dropdowns / colours in this part.
4. **The violation highlight in the viewport uses a fixed Ø24 tube** — the viewer no longer knows a shape's size; the program does.
5. Same page pattern as materials (own tab, channel, library in localStorage); no import on this page.

## 6. Out of scope
Lights as scene lights (the LED preset is emissive geometry with a material) ·
shapes on lofts · shape-driven checks · multi-material output.
