# Part 31 — Screen-space reflections: the lamps in the metal

Status: **built 2026-09-04** (asked for as "if I have an LED strip above a
golden plane I would see the reflection of the LEDs on the golden surface").
Decisions taken without a round of questions are in §5 — one word and any of
them changes.

## 1. What it is
The LEDs light surfaces through the diffuse probes (docs/17-emitters.md), and a
metal's reflection shows the world's environment alone — a gold plate under a
string got a warm glow but no lamps in it. This part adds **screen-space
reflections** (SSR) as one more helper of the post script: whatever is on
screen — the lamp tips, the structure, the sheet — is mirrored in every glossy
**metal**, blurred by the metal's roughness. The reflected lamps are hot
(HDR), so the Eevee preset's bloom picks them up like the lamps themselves.

It is *screen*-space: a lamp outside the frame, or hidden behind something
from the camera, leaves no reflection. That limit is the price of "every glossy
material at once, no extra scene renders"; a planar reflector for flat sheets
(exact, off-screen lamps included) is the next part if hero shots need it.

## 2. The helper
| `post.…` | what it is |
|---|---|
| `ssr(node, opts?)` | `node` plus the reflections traced in the scene pass — three's `SSRNode` (first-generation: one mirror ray, roughness → blur) |

`opts` (numbers, mm where it is a distance):

| knob | default | what |
|---|---|---|
| `intensity` | 1 | scales the reflection (0 = the node is not built at all) |
| `maxDistance` | 4000 | how far a ray goes before the hit fades out (mm) |
| `thickness` | 40 | how deep behind the depth buffer a hit still counts (mm) — smaller shows gaps behind thin bars, larger smears |
| `quality` | 0.5 | ray-march step budget 0..1 |
| `resolution` | 1 | the trace at a fraction of the screen (0.25..1) — 0.5 halves the cost, sub-pixel lamps then bloom instead of glint |

**What reflects**: only surfaces with `metalness > 0` are traced (three's
non-metal early-out — a noticeable saving), weighted by their metalness and
tinted by their specular colour, so gold reflects gold and chrome reflects
white. A glossy *dielectric* (lacquer, glass) keeps the environment only; a
"glossy grey" for tests is a grey metal (`m.color.set(0x808080); m.metalness = 1;
m.roughness = 0.1`). Materials that are not `MeshStandard` / `MeshPhysical`
(a basic material) have no metalness and do not reflect.

**The scene pass** carries one more target for it — `specular`: the specular
colour F0 (4 % for a dielectric, the base colour for a metal) with the
**roughness in its alpha** — and the `normal` the bounce already needed now has
the **metalness in its alpha**. Four half-float targets in all: WebGPU's
default budget is 32 bytes per sample, and a fifth target fails every
pipeline of the scene pass.

## 3. The Eevee preset
Gains the knob **`reflections`** (default 1, 0 = off); the reflections are
added to the scene colour *before* the glow is extracted, so a reflected lamp
blooms:

```js
let base = scene.color;
if (params.reflections > 0) base = post.ssr(base, { intensity: params.reflections });
const source = tsl.vec4(scene.emissive.rgb.add(tsl.max(base.rgb.sub(1), 0)), 1);
```

A project whose script is the untouched Part 15 Eevee code is **refreshed** on
load (version 17): the code becomes the new preset and the knob arrives; an
edited script is left alone (pick the preset again, or call `post.ssr` yourself).

## 4. Checking the look
`node scripts/deco.mjs exec scripts/ssr-probe.js` (the tab must be visible):
a straight LED string over a gold sheet 60 m above everything, seen from the
front 34° down (steep enough that the mirror image lands inside the sheet; the
looked-through camera is released for the shot and restored — it would pull
the view back to its pose); renders the presented frame with `reflections` 1 and 0
(bloom, streaks and flare at 0 so the difference is the reflections alone),
mirrors every lamp tip about the sheet and reads the pixel there: with SSR it
is bright, without it the plate is black. Measured 2026-09-04: 17 of 23 lamps
lit at their mirror, mean peak 0.32 vs 0. Returns the numbers and the frame as
a JPEG, then removes what it added.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **A post-script helper, not a world or material setting**: like the bounce
   (`post.ssgi`), reflections are part of the look and live where the effects
   live; the knob is on the preset.
2. **Metals only** (three's fast path) with the roughness blur; the stochastic
   GGX mode exists in three but wants a temporal denoiser we do not have.
3. **Defaults in mm** (4 m reach, 40 mm thickness): the node's defaults are in
   metres and in mm they trace nothing.
4. **Reflections before bloom** in Eevee, so reflected lamps glow; `ssgi` in a
   custom script belongs after `ssr` (the bounce reads the colour it is given).
5. **The old Eevee code is refreshed by the migration only when untouched**;
   an edited script is the user's.

## 6. Out of scope
Planar reflectors (exact, off-screen lamps) · glossy dielectrics · reflections
of the environment through SSR misses (the environment already reflects
through the material) · temporal denoising.
