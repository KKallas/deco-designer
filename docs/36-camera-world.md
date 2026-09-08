# Part 36 — The world belongs to the camera; there is always a camera

Status: **built 2026-09-08** (asked for directly: "remove the world
subsection from the outliner, each camera has its own settings and they stay
with the active camera; to exit a camera, make a new camera and its
properties are used from that view"). Changes Parts 15 and 16; §4 lists the
calls made on the way, open to veto.

## 1. What changes
- **No World row in the outliner, no project world.** Background,
  environment, sun, exposure and emitters are the **camera's** — every camera
  carries a full world (`Camera.world`, never null). The *Project world / Own
  world* choice on the camera panel is gone: its *World* section always shows
  the camera's own fields. What the viewport shows is the world of the camera
  looked through; switching cameras switches the look.
- **No free view.** The viewport always looks through a camera:
  `activeCamera` is never null, a project always has at least one camera
  (a new project starts with *Camera 1*), the last camera cannot be deleted.
  *None — free view* leaves the ▾ popup, *Stop looking through* leaves the
  camera panel. To leave a camera without moving it, **make a new camera**:
  **◉** on the rail or *+ New camera from this view* in the ▾ popup — it stands
  where the view is now, takes a **copy of the world you are leaving** and the
  default lens (50 mm on full frame, DOF off, frame on), and is looked
  through; from then on its properties are what the viewport uses.
- **Perspective / orthographic stays**, now for whichever camera is looked
  through (viewer state, not saved). Orthographic is a detour: the frame and
  depth of field are off while it lasts, the camera's pose is not written,
  and going back to perspective returns the view to the camera's pose.
- The materials and shapes pages preview with the active camera's world.

## 2. Data
```
Camera.world: World            // always present; a new camera copies the world of the camera it is made from
Project.activeCamera: Id       // never null; validated against `cameras` (the first one when unknown)
Project.world                  // gone
Selection.world                // gone
```
Version 18: every camera without its own world gets a copy of the project's;
a project without cameras gets *Camera 1* (default pose) carrying the
project's world; a null `activeCamera` becomes the first camera; `world` is
dropped from the project. The archive item (docs/33) is an `emptyProject`, so
it carries *Camera 1* too — inserting an item never touches the target's
cameras.

## 3. Commands
- `setActiveCamera(store, id)` — an unknown id is a no-op (never null).
- `removeCamera(store, id)` — refused for the last camera; removing the one
  looked through looks through its neighbour (the previous, else the next).
- `addCamera(store, { name, pose?, world?, … })` — `world` given or the
  default; the UI's *new camera from this view* passes the active camera's.
- `updateCamera(store, ids, { world: patch })` — the patch merges onto the
  camera's world; `world: null` no longer means anything (ignored).
- `setWorld(store, patch)` — kept as a convenience: patches the **active
  camera's** world (the bridge scripts and the CLAUDE.md examples keep
  working). `selectWorld` is gone.
- `overview()`: the `Cameras:` line shows each camera's world; the `World:`
  line names the camera it belongs to: `World (camera-1): …`.

## 4. Decisions taken
1. **A new camera copies the world it is made from**, not the default: leaving
   a camera to look around must not change the lighting under you (an HDR you
   set up would vanish). Lens, DOF and frame are the defaults — a camera made
   to look around is a fresh camera.
2. **Orthographic without writing the pose.** Ortho stands 20 m from the
   target along the view direction (the old free-view detour); writing that
   back would move the camera. So ortho is read-only for the camera and
   perspective snaps back to it.
3. **Emitters are part of the world**, hence per camera: two cameras with
   different emitter settings re-bake the probes when you switch. The
   usual case (same settings copied on creation) costs nothing.
4. **The last camera cannot be deleted** rather than being replaced by a
   fresh one — deleting and getting a default camera back would be a surprise.
5. **Migration activates the first camera** when the file was in the free
   view: the view jumps to it on load (the free pose was never saved, so
   there is nothing else to go to).

## 5. Out of scope
Per-camera post scripts · a camera's own projection saved in the file ·
light objects.
