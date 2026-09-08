# Part 15 — Cameras and post-processing: film back, lens, depth of field; the post script

Status: **built 2026-08-26** (asked for directly; spec written with the code —
the decisions in §5 are open to veto). Builds on Parts 13 (pages over the
channel) and 14 (programs with params; the effects chain).

## 1. What it is
Cameras are **objects in the outliner** with their **properties in the
panel**, and the post-processing is a **script edited in the panel** while
the viewport previews it:

- **Camera** objects — film back (sensor size in mm: full frame 36×24, APS-C,
  Micro 4/3, phone, custom) and lens focal length (mm) give a camera its field
  of view physically: `2·atan(w / 2f)` × `2·atan(h / 2f)`. **The frame is the
  camera**: the film-back rectangle is inscribed in the viewport (full height
  on a wider viewport, full width on a taller one) and shows exactly that
  view; what lies outside is extra, as in Blender's camera view.
- **Depth of field** — on/off, focus distance (mm), f-stop, per camera.
  Circle of confusion from the thin-lens formula, scaled by the film back.
  The focus is set with the **focus tool** (◎ in the viewport's rail): a
  click puts the focus on the first geometry under the pointer (meshes, or a
  curve's centre line within 8 px) — its depth along the view — and switches
  DOF on (on the camera looked through — there is always one, docs/36).
  A marker shows the point while the tool is
  active. *Focus on selection* in the panel does the same for the selection's
  centre.
- **Frame** — Blender's passepartout: the inscribed film-back rectangle
  outlined, everything outside darkened by `passepartout` (0..1, default
  0.5). Perspective view only; off in edit mode.
- **Post-processing as a script** (your call): the effects chain is a program
  with knobs, like shapes and materials:

```js
(post, params) => outputNode      // post.scene.color / emissive / viewZ, post.bloom / lensflare / streaks / dof, post.tsl
```

  with presets (*Eevee glow* — the Part 14 look, *Bloom only*, *Depth of field
  only*, *No effects*), a browser library, a knob table and the code editor —
  in **post mode** (topbar *Post…*): the panel becomes the editor, the
  viewport renders the **draft** so you preview before you commit.

## 2. Data
```
Camera { id, name, filmBack: { width, height }, focalLength, dof: { enabled, focusDistance, fStop },
         frame: { show, passepartout }, pose: { position, target }, world }   // new: 50 mm on 36×24, DOF off, frame 0.5
Project.cameras: Camera[]           // camera objects — at least one, each with its own lens, DOF, frame, pose and world
Project.activeCamera: Id            // looked through — never null (docs/36-camera-world.md: the free view is gone)
Project.post: { enabled, label, code, params }   // default: the Eevee glow preset, on
```
Version 7: a Part 15 project's single tuned camera becomes *Camera 1*
(looked through); an untouched one is dropped. Commands: `addCamera`,
`updateCamera` (nested patches merge), `setCameraPose` (no undo step: the
view moves the active camera), `removeCamera`, `duplicateCamera`,
`moveCamera`, `setActiveCamera(store, id)`, `setPost`. The topbar's
**✦** toggles `post.enabled`. `overview()` prints `Cameras:` (◉ = active)
and `Post:` lines.

**Looking through a camera**: choosing one in the viewport's dropdown
(under the navigation cube) moves the view to its pose and applies its lens,
frame, DOF and world; navigating then moves the camera (its pose follows the
view, debounced). There is no free view (docs/36-camera-world.md, which
replaced *None*): to look around without moving a camera, make a new one from
the view (*+ New camera from this view* in the dropdown, ◉ on the rail). The
cube's second dropdown chooses **perspective or orthographic** for whichever
camera is looked through (per browser session, not saved; orthographic
leaves the camera's pose alone and returns to it).

## 3. The post script
`createEffects(renderer, scene, camera, post, cameraSettings)`
(src/view3d/effects.ts) compiles the code and runs it with

| `post.…` | what it is |
|---|---|
| `scene.color` | the HDR colour of the scene (a texture node) · `scene.emissive` the emissive channel (MRT) · `scene.viewZ` view-space depth |
| `bloom(src, strength, radius, threshold, knee)` | three's bloom, `knee` = its smoothWidth |
| `lensflare(node, opts?)` | three's pseudo lens flare (ghosts) |
| `streaks(node, length)` | four glare streaks at 512² (Part 14) |
| `dof(node, bokeh = 1)` | depth of field from `post.camera`: focus distance, f-stop, focal length, film back → the blur range |
| `ssgi(node, opts?)` | screen-space bounce of the lit and emissive pixels (docs/17-emitters.md) |
| `ssr(node, opts?)` | `node` plus the reflections of what is on screen in the metals (docs/31-ssr.md) |
| `rtt(node, w, h)`, `tsl`, `three` | render-to-texture and the namespaces |
| `camera` | `{ focalLength, filmBack, aspect, dof (true only with the perspective camera), focusDistance, fStop }` |
| `params` | the knobs (numbers) |

Helpers clamp their knobs to what the nodes accept — bloom radius and knee
0..1, streak length 0..0.5 of the screen (samples outside the image count
as black, no wrapping), the rest ≥ 0 — so a stray value cannot wreck the
image. The result must be a node; it is tone-mapped (AgX) and colour-managed
by the pipeline. Knob changes rebuild the chain (numbers are baked), which is a
few milliseconds. All chain nodes are gated per render call (Part 14's
freeze fix), and anything drawn *after* the pipeline in a frame (the
navigation cube) renders with tone mapping off — with it on, the renderer
would blit its stale internal framebuffer over the finished frame. The
materials and shapes page previews run the default preset.

**Checking the look**: `node scripts/deco.mjs exec scripts/look-probe.js`
(or `tests/look.test.ts`, skipped without a designer tab) renders a straight
LED string in the open designer, reads the frames the screen *presents* with
the script on and off, and measures the halo around the lamp tips and the
brightness along the four streak directions versus between them; it also
returns the frame as a JPEG to look at.

## 4. UI
- **Viewport rail** (left): Move / Rotate / Scale, ◎ focus tool, then the
  selection tools that used to be the panel's *Tools* section — ✎ Edit (Tab),
  ⧉ Duplicate (⌘D), ⋈ Join (⌘J), ◫ Loft (⌘L), ▣ Group (⌘G), ✕ Delete — which
  act on a selected camera too (duplicate / delete).
- **Under the navigation cube**: the camera dropdown (*None — free view*, the
  cameras) and the projection dropdown (perspective / orthographic; disabled
  while a camera is active or in Edit mode).
- **Topbar**: *+ Camera* makes a camera from the current view (50 mm on full
  frame), looks through it and selects it; *Post…* enters post mode; **✦**
  toggles the post script.
- **Outliner**: a *Cameras* group — ◉ marks the one looked through; click
  selects (properties below), double-click looks through / stops, × deletes.
- **Panel · Camera** (a camera selected): *Look through* / *Stop looking
  through*, *Set from view*; name; film back preset + size; lens with presets
  and the resulting FOV; depth of field (enabled, *Focus on selection*, focus
  mm, f-stop with presets, the blur range); frame (show, passepartout); pose
  (position, target).
- **Panel · post mode**: header with *Cancel* / *Commit*, the script's name,
  *on*, *Save to library*; the status line (the draft's script error, or what
  it is doing); *Knobs* (name, value, ×, ＋ — a change previews at once);
  *Script*: *Presets ▾* (presets and the browser library load into the
  draft), *Revert* (the project script), *Preview ⌘⏎*, and the code. The
  outliner is hidden meanwhile, as in Edit mode. *Commit* saves the draft as
  the project script (one undo step); *Cancel* discards it.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **One post script per project** (not a list): it is the look of the file; presets and the library are the way to keep several.
2. **Knobs are baked** into the chain and a change rebuilds it — simple and exact; a knob change in post mode previews immediately, the code on ⌘⏎.
3. **DOF is physical but approximate**: the blur range comes from the thin-lens circle of confusion (0.03 mm on full frame, scaled by the film back, ×6 for "fully blurred"); `bokeh` scales the blur size for taste. Off with the orthographic (edit-mode) camera.
4. Cameras are objects with a saved **pose**; the free view's pose is not saved (it is for looking around). While a camera is looked through, navigating moves it — Blender's "lock camera to view", always on — without undo steps.
5. The per-browser ✦ flag is gone; `post.enabled` in the project replaces it. The free view's projection (perspective / orthographic) is viewer state, not project data.
6. **No camera page** (your call): cameras are outliner objects, the post script is edited in the panel with the viewport as the live preview; the materials and shapes pages stay as they are.

## 6. Out of scope
Saved views / turntables · per-page post scripts (previews use the default) ·
exposure / white balance as camera settings (the script can do it) · film grain.
