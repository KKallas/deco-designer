# Part 9 — Blender material import

Status: **built 2026-08-26**; Part 13 (2026-08-26) folded this page into
**/materials.html** (src/editor/main.ts) — same preview and code editor, plus
the project's materials and textures — made **Image Texture** nodes convert
(packed images become project textures) and removed the topbar button. The
parser / converter description below still holds. Builds on Part 5 (loft uvs in mm).

## 1. What it is
A second page (now **/materials.html**), that opens a `.blend`
file in the browser, lists its materials, converts the chosen one's shader
node tree to **TSL** (three.js node material code) and previews it live on a
1 m box, a 1 m sphere, a bent Ø15 tube (the curve mesh), a lofted band or a
custom `.obj`. The generated code is shown in an editor — edit, *Apply*
(`⌘⏎`), *Copy* or *Download .js*. Nothing is uploaded; the file is parsed in
the tab.

```
.blend ──parser──▶ materials + node trees ──convert──▶ (tsl, host) => MeshPhysicalNodeMaterial
src/blend/parser.ts   src/blend/shaders.ts            src/blend/tsl.ts   →   src/materials/runtime.ts
```

## 2. The .blend reader
- Reads the file's own DNA, so struct layouts come from the file, not from
  us. Classic header (`BLENDER-v405`) and the Blender 5 large-file header
  (`BLENDER17-01v0501`, 32-byte block heads) both work; zstd and gzip
  compression are handled (`fzstd`, `DecompressionStream`).
- Materials (`MA` blocks) → `nodetree` → nodes, sockets (identifier, type,
  default value, availability), links (muted flag), node storage as a flat
  object, colour ramps, node groups by reference.
- Verified against Blender's own Python view of the same file:
  `scripts/blend-fixture.py` writes `tests/fixtures/golden-net.blend` **and**
  `golden-net.json`; `tests/blend.test.ts` compares them node by node,
  including a material with one node per enum value (Math operations, Mix
  blend types, Voronoi features …) so every numeric table in `tsl.ts` is
  checked, not remembered.

## 3. Conversion (Blender node → TSL)
Readable output: one `const vN = …; // Node name` per node output, helpers
only when used, a header listing everything that was not converted 1:1.

| Blender | TSL |
|---|---|
| Principled BSDF | `{ color, roughness, metalness, ior, opacity, transmission, clearcoat, sheen, iridescence, emissive }` → `MeshPhysicalNodeMaterial` |
| Emission, Diffuse, Glossy/Metallic, Glass/Refraction, Transparent | shader closures; **Mix Shader** lerps every property, Add Shader = 50/50 |
| Math (all 41 ops, clamp), Vector Math (all 30), Clamp, Map Range (linear / stepped / smooth / smoother, float & vector) | chained TSL math; Ping-Pong, wrap, smooth min as helpers |
| Mix (float / vector / colour, 15 blend modes, clamp factor / result), legacy MixRGB | `mix` / `blend(mode, …)` |
| Color Ramp (linear, constant), Invert, Gamma, Bright/Contrast, Hue/Saturation, RGB to BW, Separate/Combine XYZ & Color | `ramp` / `rampStep` helpers, `hue`, `saturation`, `luminance` |
| Texture Coordinate, UV Map, Geometry, Mapping (point / texture / vector / normal), Vector Rotate | `host.*` coordinates, `eulerXYZ` (Blender's X → Y → Z order) |
| Voronoi F1 / F2 (Euclidean, randomness), Noise (fBM, detail, roughness, lacunarity), Checker, Gradient (all 7) | `sqrt(mx_worley_noise_float)`, `mx_fractal_noise_*`, inline |
| Node groups (nested), Reroute, muted nodes | inlined / passed through |
| Fresnel, Layer Weight | approximated from the view vector |

**Image Texture** (Part 13): `texture(host.texture('<id>'), Vector.xy)` —
the image becomes a project texture when it is packed, else a warning names
the file to add; extension modes other than Repeat and non-flat projections
are approximated. Not converted (a warning is listed and a neutral value
used): normal / bump maps,
curves nodes, Wave / Magic / Brick / Musgrave, HSV / HSL blend modes,
Voronoi smooth-F1 / edge / radius / non-Euclidean metrics / fractal detail,
non-fBM noise, displacement, volumes.

**Coordinates.** The host supplies them in Blender's units (metres). An
**unlinked texture Vector uses `uv`** — metres of surface (mesh uvs are mm on
curves, lofts and the preview shapes) — so a pattern keeps its physical size:
a 2 m loft gets twice the cells of a 1 m one, a narrow band is not stretched.
(Blender would use *Generated*, 0..1 over the bounding box, which stretches
with the object; it is still there as `host.generated` when a Texture
Coordinate › Generated is linked.) `object` = local position / 1000,
`position` = world / 1000, `normal`. A 4D texture's `W` offsets the 3D pattern
(there is no 4D noise in TSL) — the look changes with W as in Blender, the
exact pattern does not match.

## 4. Using a converted material in the app
The downloaded module is `export default (tsl, host) => material`; run it with
`buildMaterial(code, hostFor({ bounds, uvScale }))` (src/materials/runtime.ts)
and put the material on a curve's pipe mesh or a loft mesh. Assigning
materials to curves / lofts inside the designer is the next part.

## 5. Decisions
1. Parse `.blend` in the browser (no Blender install needed to import); Blender is only used to build the test fixture.
2. Emit source code, not an in-memory graph — it is the editor's content, the download, and what the app will load.
3. `host` supplies coordinates, so the same code works on a 1 m preview box and on a 3 m loft.

## 6. Out of scope
Image textures / packed images · Cycles-only shading (SSS, volumes, hair) · normal maps · exporting back to Blender.
