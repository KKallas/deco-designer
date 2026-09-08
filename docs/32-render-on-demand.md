# Part 32 — Frames on demand, cheap while moving, a still at full quality

Status: **built 2026-09-04** (asked for as "the GUI feels sluggish and seems
to render this over and over: if nothing changes we can stop; drop the
resolution while interacting and upscale; an offline render for high
quality"). Decisions taken without a round of questions are in §5 — one word
and any of them changes.

## 1. What it is
Until now the viewport drew a frame ~60 times a second whatever happened —
with Part 31's reflections and a retina canvas (2940 × 2010 px) that is the
whole GPU, all the time. Three changes:

1. **A frame only when something asks for one.** The loop still ticks, but it
   returns at once unless a frame is wanted. A frame is wanted by: any store
   change (the scene is rebuilt), the camera moving (orbit, damping, the
   fly-to animation, the navigation cube), any pointer / wheel / key event on
   the viewport (hover, tool previews, gizmo drags), a resize, the post preview
   or look changing, an animation playing, the emitter bake progressing.
   `viewer.invalidate()` asks for one by hand (the bridge does).
2. **Half the pixels while interacting.** While a button is held, the wheel
   turns, the fly-to runs or the camera moves **2 px or more per tick**, the
   canvas renders at half the pixel ratio (retina: 1 instead of 2 — a quarter
   of the pixels; never below 0.5) and the browser scales it up; 150 ms after
   the last such tick one sharp frame is drawn at the full ratio. The
   controls' damping eases the camera for seconds at sub-pixel speeds: that
   tail is judged on screen — half a pixel of drift since the last drawn frame
   earns a sharp frame, less is ignored (first cut used the controls' own
   "moved" flag, which is true down to a millionth of a millimetre, and the
   sharp frame came seconds late or, with a wiggle, seemingly never).
   Playback and the bake stay at full resolution (they are the look, not a
   gesture).
3. **A still at full quality.** `⧉ Still` on the viewport rail (render
   section) renders the camera's frame — the film-back aspect, the camera's
   own field of view, no passepartout, no helpers — at **3840 px wide**
   through the post script and downloads it as a PNG named after the project
   and camera. An orthographic view renders the viewport's aspect. From the bridge:
   `node scripts/deco.mjs render out.png [width]` (width ≤ 8192).

## 2. How
`src/view3d/viewer.ts`:
- `needsFrame` + `invalidate()`; `touch(interactive)` on the input events;
  `frameLoop` runs the clock / bake tick and the controls every tick (they set
  the flag themselves), switches the pixel ratio when the *interacting* state
  changes, and returns before the render when nothing asked for a frame.
  `renderCount` counts drawn frames (the bridge reads it to prove idleness).
- `renderStill({ width })`: hides the helpers, tool previews, floor grid and
  gizmo, sets the perspective camera's aspect and fov to the picture, resizes
  the renderer to `width × height` at pixel ratio 1, renders once through the
  same pipeline, reads the canvas as a PNG data URL, restores everything and
  asks for a frame. `saveStill()` downloads it. `stillSize()` in
  src/model/camera.ts is the size rule (tested).

## 3. Checking it
- Idle: `viewer.renderCount` stops growing within a second of the last input
  (the bridge's `exec` itself asks for one frame, so read it twice).
- Moving: `viewer.pixelRatioNow` is the low ratio while the camera moves ≥ 2 px
  a tick and the full one after. Release with velocity from the bridge
  (`viewer.controls._sphericalDelta.theta = 0.06`) and sample every 100 ms:
  measured ratio 1 for 450 ms, then 2, ~25 tail frames over 2 s, quiet after.
- Still: `node scripts/deco.mjs render /tmp/still.png 1920` writes a
  1920 × (1920 / film aspect) PNG whose middle is not black.

## 4. Things that stay
The topbar's fps counter counts drawn frames (during playback that is every
tick, as before). The look probes render presented frames and are unaffected.
The materials and shapes pages keep their own loops.

## 5. Decisions (taken autonomously — say if you want them otherwise)
1. **Pointer events over the viewport always cost a frame** (hover, tool
   previews) rather than a precise dirty-tracking of every overlay: a moving
   mouse is a gesture, an idle one is idle.
2. **Interactive ratio = half the full ratio, at least 0.5**, restored 150 ms
   after the last movement. No SSR-specific downgrade: the ratio covers it.
3. **The still is 3840 px wide by default**, PNG, the camera frame or the
   viewport aspect, through the same pipeline (so DOF, bloom, reflections
   apply). No supersampling, no tiles: above 8192 px is refused.
4. **Helpers are hidden in the still** (grid, plane outlines, vertices,
   gizmo, tool lines); the reference images are content and stay.
5. Rendering the still resizes the visible canvas for one frame; the loop
   redraws the viewport right after.

## 6. Out of scope
Progressive refinement (accumulating samples while idle) · a render queue /
turntable · tiles for prints wider than 8192 px · a resolution setting in the UI.
