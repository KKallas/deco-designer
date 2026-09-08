# Part 16 — World: background and environment lighting, per project and per camera

Status: **built 2026-08-27** (spec agreed the same day; §5 lists what was
decided on the way). Builds on Part 13 (textures in the project) and Part 15
(camera objects). **Changed by Part 36 (docs/36-camera-world.md, 2026-09-08):
there is no project world any more — every camera carries its own, the
outliner's World row is gone, and the viewport always looks through a camera.
The data and rendering below still hold; read "the project's world" as "the
active camera's world".**

## 1. What it is
Today the viewport lights every scene with a fixed rig that is not in the
project — a hemisphere light, a shadow-casting sun, a dark grey background
(`src/view3d/viewer.ts`), plus a studio *RoomEnvironment* in the reflections
and AgX tone mapping whenever ✦ (post) is on (`src/view3d/effects.ts`).
Nothing can switch it off or replace it.

Part 16 replaces that rig with a **World** — Blender's term — that the
project owns and a camera may override:

- **Background** — what the camera sees behind the objects: a **colour**, or
  an **HDR image** (equirectangular `.hdr` / `.exr`), optionally blurred.
- **Environment** — what lights the scene and shows in reflections: the
  **same HDR**, a flat **colour** (uniform light, like Blender's default
  grey world), or the built-in **studio room** (what ✦ uses today). Strength
  and a rotation about the vertical axis.
- **Sun** (optional, on/off) — one directional light with shadows: direction
  (azimuth / elevation), colour, strength, shadows. Enough for the "product
  on a table" shot without a lights part; proper light objects are Part 17.
- **Exposure** — one number, and the view transform is **always AgX**
  (today it flips between AgX and none with ✦, which changes the look more
  than the effects do).

Nothing lights the scene that is not in the world: environment *none* + sun
off = black, as in Blender.

**Per camera** (since Part 36): every camera carries its own world — so one
file can hold a hero shot on an HDR and a catalogue shot on plain white. The
viewport shows the world of the camera looked through; a new camera made
from the view copies the world of the camera it leaves. The materials and
shapes pages preview with the active camera's world.

## 2. Data
```
World {
  background: { kind: 'color', color: '#141416' }
            | { kind: 'hdr', texture: Id, blur: 0..1 }         // blur 0 = sharp image
  environment: { kind: 'none' }
             | { kind: 'color', color: '#808080' }
             | { kind: 'room' }                                // three's RoomEnvironment (today's ✦ look)
             | { kind: 'hdr', texture: Id },
  strength: number,            // environment multiplier, default 1
  rotation: number,            // degrees about +Y, HDR background and environment together
  sun: { enabled, azimuth, elevation, color, strength, shadows },   // default: on, 55° / 47° (the old sun), white, 2, no shadows
  exposure: number             // default 1
}
Camera.world: World            // every camera's own (Part 36); default: colour background #141416, room environment ×1, sun on
                               // (Project.world and the null override were dropped in version 18)
Texture.mime                   // adds 'image/vnd.radiance' (.hdr) and 'image/x-exr' (.exr); data stays a base64 data URL
```
HDRs are ordinary project **textures** (Part 13, decision 1: the file is
self-contained) — added on the materials page or from the world panel's
file button, listed there with a thumbnail (tone-mapped), size and which
worlds use them. Decoded with three's `HDRLoader` / `EXRLoader` into a
float texture, PMREM'd once per texture and cached.

Version 8: `world` is added with the default (which reproduces today's ✦-on
look, so existing files do not change appearance); `camera.world` defaults
to `null`.

Commands: `setWorld(store, patch)` (nested merge, one undo step; a `kind`
change keeps what the new kind can use), `updateCamera(store, id, { world })`
(`null` = the project's; a patch starts from the project's world when the
camera had none, then merges onto its own), `selectWorld(store)`;
`addTexture` accepts HDR files (`sniffMime` knows `#?RADIANCE` and the EXR
magic). `overview()` prints a `World:` line and `(own world: …)` after a
camera; HDR textures are marked in the `Textures:` line.

```js
cmd.setWorld(store, { background: { kind: 'color', color: '#ffffff' }, environment: { kind: 'color', color: '#ffffff' }, sun: { enabled: false } })   // catalogue white
const sky = cmd.addTexture(store, { name: 'sky', mime: 'image/vnd.radiance', data: 'data:image/vnd.radiance;base64,…', width: 1024, height: 512, source: 'sky.hdr' });
cmd.setWorld(store, { background: { kind: 'hdr', texture: sky, blur: 0.2 }, environment: { kind: 'hdr', texture: sky }, strength: 1.2, rotation: 90 })
cmd.updateCamera(store, 'hero', { world: { environment: { kind: 'none' }, sun: { elevation: 20, shadows: true } } })   // this camera's own
cmd.updateCamera(store, 'hero', { world: null })   // back to the project's
```

## 3. Rendering
- Background colour / HDR → `scene.background` (+ `backgroundBlurriness`,
  `backgroundRotation`); environment → `scene.environment` via PMREM
  (`fromEquirectangular` for HDR, `fromScene(RoomEnvironment)` for room, a
  1×1 colour scene for *color*), `environmentIntensity` = strength,
  `environmentRotation`. Rebuilt only when the world key changes (as `fxKey`
  does for post).
- The sun is the one `DirectionalLight`; hemisphere light gone.
- `renderer.toneMapping = AgX` always, `toneMappingExposure = exposure`.
  With ✦ off the scene still renders through a pipeline — the scene pass and
  the view transform only (`fallbackEffects`): a direct `renderer.render`
  with the cube overlay presented a black frame. The post chain reads the
  same scene, so bloom sees HDR backgrounds (a sun disc in an HDR blooms).
- Edit mode (orthographic, drawing on a plane) keeps a neutral fixed look
  (`EDIT_WORLD` = the default world) — the world is for looking at the
  product, not for drawing.
- The materials and shapes pages reuse the same world → scene code (one
  class, `WorldRig` in `src/view3d/world.ts`) with the project world they
  mirror over the channel.
- HDR files: `src/materials/hdr.ts` decodes `.hdr` / `.exr` (three's
  loaders) to a float equirect `DataTexture`; the rig PMREMs it once per
  texture and drops it when the data changes. Thumbnails on the materials
  page are tone-mapped PNGs made on the fly. `TextureCache` (materials)
  leaves HDR ids grey — they are for worlds.

## 4. UI (as of Part 36)
- **Camera panel: the *World* section** — every camera's own: background
  kind + colour / HDR dropdown (+ *Add HDR…*) + blur; environment kind +
  colour / HDR + strength + rotation; sun on/off, azimuth, elevation, colour,
  strength, shadows; exposure; emitters. With several cameras selected the
  fields are edited one camera at a time.
- The outliner's *World* row, the *Project world / Own world* choice and the
  override warnings are gone (Part 36).
- The materials page's texture list accepts `.hdr` / `.exr` (drop or file
  button) and shows them like images, marked *HDR*.
- Bridge: `updateCamera(id, { world })`, `setWorld` (the active camera's),
  `addTexture`.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **Project world + per-camera override** (not only per camera): the usual
   case is one look for the file; a camera overrides when it needs its own.
   *Reversed by Part 36*: the world is per camera only; a new camera copies
   the world it is made from, which covers the "one look for the file" case.
2. **The hard-coded lights go**; the default world (room environment + sun)
   reproduces today's ✦-on look so nothing changes visually on load. There is
   no "inherit the old rig" option.
3. **AgX always**, exposure in the world — ✦ only adds the effects chain.
4. **HDRs are project textures** (self-contained files, same list, same
   commands) rather than a separate store. HDRs are large — a 2k `.hdr` is
   2–6 MB — and the autosave was `localStorage` (~5 MB). **Autosave moved
   to IndexedDB** (`src/app/autosave.ts`; an old localStorage save is read
   once and removed after the first IndexedDB save); the materials page
   shows each HDR's size and the hint suggests 1k for viewport use. Project
   files keep the base64 data URL.
5. **One sun in the world**, no light objects yet: covers the "product on a
   table" case; point / spot / area lights as outliner objects are Part 17.
   **Shadows default off**: the old rig's shadow camera never covered the
   scene (mm units), so nothing visible is lost, and thin profiles show
   acne easily — switch them on per world.
6. **HDR background is the full-resolution image, not the PMREM** (sharp
   horizon); `blur` uses three's `backgroundBlurriness` (three PMREMs the
   background itself when blurred).
7. The sun's **azimuth is clockwise from +Z seen from above** (0 = from the
   front, 90 = from the right), elevation above the horizon; the default
   55° / 47° is where the old fixed sun stood.

## 6. Out of scope
Light objects (Part 17) · sky models (Nishita / Preetham) · ground plane /
shadow catcher · per-page worlds on the shapes page · HDR rotation about
other axes · transparent background / alpha export.
