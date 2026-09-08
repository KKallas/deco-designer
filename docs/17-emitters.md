# Part 17 — Emitters: LEDs light the scene; pixel animations from PNG maps

Status: **built 2026-08-27** (spec agreed the same day; §5 lists what was
decided on the way). Builds on Part 14 (shape programs with `color` /
`emissive` attributes), Part 15 (post script, bloom) and Part 16 (world =
the only light).

## 1. What it is
Before this part an LED tip was only *bright*: emissive colour, bloom,
nothing lit by it. Part 17 makes **every LED a pixel with a live colour that
lights the scene** — no lights are placed, the emissive geometry is the
source of truth — and plays **pixel animations** stored as PNG maps, at
real-time rates (measured: 120 fps with the pattern running on a 240-lamp
scene; the per-frame lighting cost is 0.8 ms and does not depend on how fast
the pattern changes).

- **Pixels**: one LED = one pixel. A string is a chain of **80** pixels; up
  to **3** chains daisy-chained make a fixture of 80 / 160 / 240 pixels.
  Pixel *i* is the *i*-th lamp along the curve (`reverse` counts from the
  other end). Lamps past the pixel count stay dark; pixels past the lamps
  light nothing.
- **Animation maps**: a PNG in the project textures where **x = LED id** and
  **y = frame** (row 0 = first frame). A curve is patched to a map with a
  **column offset** (its first LED's x), so three chains of one fixture, or
  several curves, share one 240-wide map. Colour order RGB (alpha ignored),
  linear playback at the map's `fps`.
- **Lighting from the pixels** (emissive only, no classical lights): a grid
  of spherical-harmonic probes over the scene; for each probe the
  contribution of each lamp at unit radiance — cosine, 1/d², and
  **visibility by ray marching a voxel grid** (an arch shadows the floor
  behind it, softly) — is **baked once per geometry change** into a transfer
  matrix. Per frame the GPU-bound work is a small multiply of that matrix by
  the live pixel colours; every surface then samples the probes. The bake
  runs in background slices while the viewport keeps drawing.
- **The lamps themselves** read their colour from the same pixel buffer
  (scaled by the colour the shape baked in, so a string's `glow` still sets
  how bright "white" is), and bloom as before.

## 2. Data
```
Profile code: a shape may write a `pixel` vertex attribute (float, -1 = not a lamp) — the LED string numbers its tips
Animation { id, name, texture: Id, fps, frames (= image height), width (= image width) }
Project.animations: Animation[]
CurveObject.pixels: { chains: 1|2|3, animation: Id | null, offset, reverse } | null   // null = not a fixture
Project.playback: { playing, loop, start, end: number | null }  // one clock, in seconds — docs/22-transport-in-out.md
World.emitters: { enabled (default off), strength (1), probeSpacing (250 mm), visibility (true) }
```
Version 9: `animations` / `playback` are added, curves get `pixels: null`,
the world gains `emitters`, and **a stored LED string profile is upgraded**
to the one that numbers its lamps (`upgradeLedCode` in src/model/profiles.ts)
— without the `pixel` attribute nothing could drive or light from it.

Commands: `addAnimation`, `updateAnimation`, `removeAnimation` (its fixtures
go back to their own colour), `moveAnimation`, `setCurvePixels(store, ids,
patch | null)` (merges onto the fixture, `null` un-patches),
`chainCurvePixels(store, ids, animation)` (one block of columns each, in
order), `setPlayback` (no undo step). `overview()` prints `✦ <n> px
<animation>@<offset>` on a curve and an `Animations:` line.

```js
const tex = cmd.addTexture(store, { name: 'chase', mime: 'image/png', data: 'data:image/png;base64,…', width: 240, height: 600, source: 'chase.png' });
const anim = cmd.addAnimation(store, { name: 'Chase', texture: tex, fps: 30, frames: 600, width: 240 });
cmd.setCurvePixels(store, ['front-left', 'front-right'], { chains: 1 });
cmd.chainCurvePixels(store, ['front-left', 'front-right'], anim);   // columns 0–79 and 80–159
cmd.setPlayback(store, { animation: anim, playing: true });
cmd.setWorld(store, { emitters: { enabled: true, strength: 1.5 } });
viewer.setPixels /* not a command: */ ; viewer.pixels.colours                // the live RGB of every lamp
```

## 3. Rendering
- **Pixel buffer** (src/view3d/pixels.ts): one RGB per lamp of the project in
  a `DataTexture`, refilled each frame from the animation row (or from the
  colour the shape baked in, when a curve is not patched). A lamp material
  reads its slot with `textureLoad`; a vertex with `pixel < 0` (the wire)
  stays black. Slots are laid out before any material is built, and a curve's
  first slot is a uniform, so materials never have to be rebuilt.
- **Transfer bake** (src/geometry/probes.ts — pure maths, headlessly
  tested): the lattice covers the content with `probeSpacing`; each probe
  keeps its `K = 24` strongest lamps (unshadowed `area / r²`), blocked ones
  dropped so a shadowed lamp does not take a slot from one that shines. The
  occluders are the **structure** — LED strings are skipped (a string would
  mostly shadow itself and its triangles are the bulk of the scene) and the
  soup is stride-sampled to 40 000 triangles.
- **Per frame** (src/view3d/emitters.ts): `probeSH = T · colours`, uploaded
  into four half-float `Data3DTexture`s (bands 0 and 1), and every lit
  material adds `IrradianceNode(probes)` through three's own lighting
  context — so the light is multiplied by the surface's BRDF like any other.
  A uniform gates it, so switching emitters on and off rebuilds nothing.
- **Diffuse only**: the probes put no specular glints in metal — the world's
  environment reflects through the material, and the lamps on screen through
  `post.ssr(node)` (docs/31-ssr.md). `post.ssgi(node)` in the post script adds
  the near-field screen-space bounce; the scene pass carries a `normal`
  channel for both.
- **Calibration**: a shape's emissive value is tuned for the *look* (the LED
  preset's `glow` of 6 makes a sub-pixel lamp bloom), not as a radiance —
  physically a 190 mm² tip at 6 lights almost nothing. `strength: 1` folds in
  a fixed constant (300, measured against the LED preset) so that "as bright
  as it looks" becomes "as bright as a lamp".

## 4. UI
- **Curve panel › Fixture** (shown when the curve's shape numbers lamps):
  *driven by an animation*, chains 1 / 2 / 3 (with the pixel count), the map,
  the column offset, *reverse*, and — with several curves selected —
  *Chain n fixtures*. The hint says which columns it reads and warns when the
  shape's lamp count and the pixel count differ.
- **Topbar transport**: ▶ / ‖, ⏮, the animation the counter shows, *loop*,
  and the frame counter (written straight into the DOM, so a running
  animation does not re-render the app).
- **Camera panel › World › Emitters** (the world is the camera's since
  docs/36): *the LEDs light the scene*, *shadows*, strength, probe spacing.
- **Materials page › Pixel animations**: a PNG texture offers *Use as
  animation*; each animation shows its map, fps, and which fixtures read it.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **Pixel = lamp index along the curve**, fixture = curve, 80 per chain,
   ≤ 3 chains. The shape's `pitch` decides how many lamps exist. (Fixing the
   curve length to the chain length is your later part.)
2. **Animation = PNG texture + fps**, x = LED id, y = frame, RGB, alpha
   ignored. A 240 × 3600 PNG (2 min at 30 fps) is ~2 MB in the file.
3. **Lighting via precomputed transfer to SH probes** rather than lights:
   constant per-frame cost, soft shadows from baked visibility, colour bleed;
   **diffuse only** — bands 0 and 1 (4 coefficients), which is a soft
   gradient, not a sharp shadow edge.
4. **One playback clock per project**, and **the current time is viewer
   state, not project data** (a change from the draft): 30 store updates a
   second would re-render the panel and rewrite the autosave. `playback`
   keeps only *which* animation the transport shows, playing and loop —
   every fixture plays the map it is patched to, on that one clock.
5. **`bounce` is not a world setting** (a change from the draft): the
   screen-space bounce is `post.ssgi` in the post script, where the effects
   live, instead of a second mechanism in the world.
6. **`strength` was added** to the world's emitters, with the calibration
   above — without it the physically correct answer is "almost black".
7. The `pixel` attribute is the whole shape API: any shape program can make
   emitters, and the old stored LED string is upgraded on load.
8. **Emitters are off by default**: the bake costs a second or two on a big
   scene, and Part 16's look should not change without asking.

## 6. Out of scope
Art-Net / DMX ingestion · timeline editor, easing, blending of animations ·
curve lengths locked to chain lengths · lamp textures · specular from the
pixels · path-traced stills · per-camera playback · a compute-shader
transfer (the CPU multiply is 0.8 ms for 4 440 probes; it would matter for
tens of thousands).
