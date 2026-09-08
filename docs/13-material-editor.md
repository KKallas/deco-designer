# Part 13 — Materials page (materials, textures, Blender import in one tab)

Status: **built 2026-08-26** (asked for directly; spec written with the code —
the decisions in §5 are open to veto). Builds on Parts 9 (Blender import) and
10 (materials on curves and lofts).

## 1. What it is
The topbar *Blender ↗* button is gone. Every **material dropdown** (Curve
section, Loft section) ends with **Material editor…**; picking it opens
**/materials.html in its own tab** (reused if already open), which absorbs the
old importer page: it mirrors the designer's project over a `BroadcastChannel`
(src/app/channel.ts) and runs its changes as commands in the designer tab —
undoable there, visible in its viewport at once — while its own 3D preview
(1 m box / sphere / bent tube / loft / your .obj) shows the picked material.
A separate tab closes on its own and keeps the designer's layout untouched
for a phone UI later. On the page you

- **rename and organize materials**: the project's materials in a list (drag
  to reorder — that is the dropdown order), rename, duplicate, remove, put on
  the selection, save to the library; the browser **library** (shared with the
  importer page) below it — add to the project, rename, remove;
- **edit the code** of a material (TSL, *Apply* `⌘⏎`, *Revert*), with the
  warnings from the conversion and the textures it uses;
- **manage textures**: images (PNG / JPEG / WebP) the project's materials
  sample — add from a file (or drop it on the window), rename, replace the
  image, remove; each shows a thumbnail, size and which materials use it;
- **import from Blender**: open a `.blend` (or drop it on the window); its
  materials are listed, clicking one converts it (Part 9) into a *draft* whose
  code / warnings / textures are shown; *Add to project* or *Add to library*.
  Packed images come along as textures; unpacked ones are named in a warning
  so you can add the file yourself.

## 2. Data
```
Texture  { id, name, mime, data (base64 data URL), width, height, source }
Project.textures: Texture[]                 // absent in older files → []
Material                                    // unchanged; its code references textures by id
Library entry = Material & { textures?: Texture[] }   // the textures a library material needs travel with it
```
Textures are copied into the project like materials (Part 10, decision 1):
a saved file carries its images. Ids are slugs of the name, kept stable across
renames (code references them).

Commands: `addTexture`, `updateTexture` (name / image), `removeTexture`,
`moveTexture(store, id, index)`, `moveMaterial(store, id, index)`,
`duplicateMaterial`, `addLibraryMaterial`. The bridge sees textures in
`overview()`.

**Channel** (src/app/channel.ts, `BroadcastChannel 'deco-designer'`): the
designer answers `hello` with `{ project, selection }` and re-sends it
(coalesced, 120 ms) after every store change while a page listens; the page
sends `call { calls: [{ name, args }] }` — a whitelist of the material /
texture commands, run in one `store.transaction` (one undo step), `'$prev'`
in an argument = the previous call's return value (assign a just-added
material to the selection) — and gets `result`. `show { materialId }` moves
an open page to a material. Same origin only; nothing leaves the browser.

## 3. Textures in material code
`host.texture(id)` (src/materials/runtime.ts) returns a three.js texture for a
project texture — sRGB, repeating — or a mid-grey placeholder if the id is
unknown; sample it with TSL's `texture(host.texture('net'), host.uv.xy)`.
`host.uv` is metres of surface (Part 9), so an image tiles **once per metre**
unless the material scales its coordinates — the same physical size on every
piece, as with procedural textures.

The viewer keeps one three.js texture per texture id and swaps the image in
place when the data changes, so compiled materials need no rebuild when a
texture is renamed, replaced or added later.

**Blender › Image Texture** now converts: `texture(host.texture('<image id>'),
<Vector>.xy)` (`.rgb` for Color, `.a` for Alpha). The image id is the slug of
the image datablock name without its extension (`net.png` → `net`). The
converter reports the images the material needs (`Converted.images`: id, name,
file path, packed bytes if the image is packed in the .blend). Extension modes
other than *Repeat* and non-flat projections are approximated (warning).

## 4. UI
- **Open**: *Material editor…* in a material dropdown (the dropdown springs
  back to its value) opens or focuses the `deco-materials` tab at that
  material (`?material=<id>` on a fresh open, a `show` message otherwise).
  Without a designer tab the page still previews, keeps the library and
  imports .blend files; the project sections say so.
- **Left column**: *Project materials* (drag handle, name, uses, ⚠) ·
  *Textures* (thumbnail, name, size, uses) · *Library* (this browser) ·
  *Blender* (open / drop a .blend → its materials with node counts) ·
  *Preview on* (shape). `＋ Material` makes a plain grey material,
  `＋ Texture…` opens a file picker.
- **Centre**: the 3D preview of the picked material; **bottom** shows the
  picked item:
  - project material: name, source, *Use on selection* (when curves or a loft
    are selected in the designer), *Duplicate*, *Save to library*, *Remove*;
    warnings; textures it references (missing ones flagged); code editor with
    *Apply* (`⌘⏎`: preview + save) / *Revert* / *Copy* / *Download .js*;
  - library material: name, *Add to project* (also assigns it to the
    selection), *Remove from library*; warnings; code (read-only until added);
  - Blender draft: name, *Add to project* / *Add to library*, warnings, the
    images it needs (packed ✓ / not packed), code (*Preview* compiles edits
    onto the shape; *Add* uses them);
  - texture: the image, name, size, source, *Replace image…*, *Remove*.
- Every change is a command in the designer (undoable, one step per action);
  adding a Blender material with its packed images and assigning it is one
  step. The page is one column below 800 px.
- The panel's old *Materials* section is gone — the page is the place;
  the dropdowns keep their *Add from library* group.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **Textures are project data** (base64 in the project file, like materials are code) rather than a browser-only asset store — files must open elsewhere. Large images make large project files; nothing is resized.
2. **A separate tab, not an overlay** (your call, 2026-08-26): it replaces `/import.html`, keeps the importer's shape preview, and the designer tab stays the single owner of the store (commands over a BroadcastChannel). With the two tabs side by side the viewport shows the change as well.
3. **Image tiling is physical**: 1 image per metre of `uv`, consistent with Part 9's coordinate rule. Blender's own UV layout of the mesh is not reproduced (curves and lofts have generated uvs anyway).
4. Reordering is the only "organizing" structure — no folders or tags. The list order is the dropdown order.
5. Unpacked images are not read from disk (a browser cannot); the warning names the file to add.

## 6. Out of scope
Normal / bump maps · image colour-space options (non-colour data) · texture
painting or cropping · exporting materials back to Blender.
