# Deco Designer

A simple 3D designer for **Decolight** products. You draw curves on planes,
each curve is bent from an aluminium profile (flat bar or round tube) and the
profile's limitations are checked while you draw. Later parts add lofted
areas, LED strings, bill of materials and export.

Built with **Three.js on WebGPU** (WebGL2 fallback), Vite and TypeScript.
UI style follows Plasticity: dark, minimal, one viewport. All units are **mm**.

The project is built in parts; each part has a spec in [docs/](docs/) that is
agreed before the code is written:
[01 — Curve objects and the curve editor](docs/01-curve-editor.md) ·
[02 — Handles, alignment snapping, vertex constraints](docs/02-handles-snapping-constraints.md) ·
[03 — Planes with several curves, multi-select, break apart](docs/03-multiselect-break-join.md) ·
[04 — Transform gizmos and vertex-to-vertex snapping](docs/04-gizmos-snapping.md) ·
[05 — Loft object](docs/05-loft.md) ·
[06 — Objects (groups of planes and lofts)](docs/06-object-groups.md) ·
[07 — Agent bridge: overview and direct manipulation](docs/07-agent-bridge.md) ·
[08 — Selection filter](docs/08-selection-filter.md) ·
[09 — Blender material import](docs/09-blender-import.md) ·
[10 — Materials on curves and lofts](docs/10-materials.md) ·
[13 — Material editor](docs/13-material-editor.md) ·
[14 — Shapes](docs/14-shapes.md) ·
[15 — Cameras and post-processing](docs/15-camera.md) ·
[16 — World: background and lighting](docs/16-world.md) ·
[17 — Emitters: LEDs light the scene, pixel animations](docs/17-emitters.md) ·
[11 — One navigation scheme, gizmo in Edit mode, add-points tool](docs/11-navigation-edit-gizmo.md) ·
[12 — 3D curves (plane + offset along the normal)](docs/12-3d-curves.md) ·
[18 — Nested objects](docs/18-nested-objects.md) ·
[19 — Reference image](docs/19-reference-image.md) ·
[20 — Viewport status bar and framing](docs/20-viewport-status-bar.md) ·
[21 — Navigation cube: drag to spin, ▾ view popup](docs/21-navcube-drag.md) ·
[22 — The transport is a clock: in / out and loop](docs/22-transport-in-out.md) ·
[23 — Two toolbar rails, icon or icon + text](docs/23-toolbar-rails.md) ·
[24 — Loft trims and offsets](docs/24-loft-trim.md) ·
[25 — Number fields: one row per parameter, drag to scrub](docs/25-number-fields.md) ·
[28 — A plane out of a curve](docs/28-panel-surface.md) ·
[29 — Offset, trim and fillet on a plane](docs/29-offset-trim-fillet.md) ·
[30 — Outline and shape layers](docs/30-outline-and-shape-layers.md) ·
[31 — Screen-space reflections: the lamps in the metal](docs/31-ssr.md) ·
[32 — Frames on demand, cheap while moving, a still at full quality](docs/32-render-on-demand.md) ·
[34 — Project a curve onto another plane](docs/34-project.md) ·
[35 — Outliner multi-select and multi-edit](docs/35-outliner-multi-edit.md) ·
[36 — The world belongs to the camera; always a camera](docs/36-camera-world.md).

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build in dist/
npm test           # headless API tests (vitest, Node) — see tests/
node scripts/deco.mjs overview   # agent bridge: inspect / change the document open in the browser (docs/07)
```

WebGPU needs a recent Chrome/Edge (or Safari 26+ / Firefox with WebGPU enabled);
otherwise the viewport falls back to WebGL2. Work is autosaved in the browser.

## Using it

**Model**: *curve → plane → modifier*. A **plane** is a placed drawing surface
(Front / Top / Side preset or custom) that groups any number of curves and
carries the **array modifier** (linear / circular) that repeats everything on
it. A **curve** is one object with its own profile and constraints. A plane can
also carry a **reference image** — a scan of a drawing to trace shapes over.

The panel has two panes that scroll on their own: the **outliner** on top,
**tools and properties** below, so the buttons and the selected object's
settings never scroll away. Drag the bar between them to resize; click the
Outliner header to fold it away. Every object, plane and *Surfaces* row has its
own ▾ chevron to fold its children (all of this is remembered).

**Every number field can be dragged** left / right to change it, like Blender
(docs/25-number-fields.md): one step of that field per 8 px, `Shift` for tenths
of a step, and the whole drag is a single undo step. A click without moving
still puts the cursor in it to type. Parameters with names of their own sit one
per row (the loft trims); `x y z` stay three to a row.

**Object mode** — the outliner lists planes and their curves. Click a curve to
select it (in the outliner `Shift`-click selects a range and `⌘`-click adds or
removes one, within rows of one kind — curves, planes, objects, surfaces,
cameras; in the viewport `Shift`-click adds, or drag a box on empty space),
drag to move the selection within its plane; click a plane row to select the
plane and drag to move everything on it. Outliner names are labels: rename in
the *name* row of the properties. **With several of one kind selected the
properties pane edits them all** (docs/35-outliner-multi-edit.md): a field whose
values agree shows the value, one whose values differ shows `--`, and a value
typed, picked or dragged in goes to every selected one.
The top of the left rail says what to add: **▤** a plane (the **▾** under
it picks front / top / side and remembers it), **○** a curve on the active
plane — which enters Edit mode — and **◉** a camera from the current view. `⌘D` duplicates the selection — the whole plane with its curves when the plane
is selected. A **gizmo** (rail: `W` move · `E` rotate · `R` scale) sits on the
selection: a 3D one for a plane, a 2D in-plane one for curves (scaling a plane
bakes into its curves). While moving, the vertex nearest the grab point
**snaps onto other curves' vertices** (pink ring) — drop things exactly
vertex-on-vertex; otherwise alignment guides and the grid apply. Select two
curves and press **Loft** (`⌘L`) to create a **loft**: both curves resampled
(2× their vertex count), ruled point-to-point and gridded black / white; lofts
are listed in the outliner with their own settings (resolution, strips, flip).
Each loft also **trims its two control curves** before building the surface
(docs/24-loft-trim.md): rows of `trim start` / `trim end` / `offset` / `lift` in
mm for each of the two curves — a positive start or end stays short of the
curve's end, a negative one runs past it straight along the end tangent, the
offset moves that edge across the rulings (**+ outwards**, away from the other
curve, **− inwards**) and the lift moves it out of the surface along the loft's
own normal. The curves themselves keep their length and their checks.

The **Modify** section of the left rail holds three CAD tools that work between
curves on one plane (docs/29-offset-trim-fillet.md); each has a bar under the
selection label with its number and a hint. **⇉ Offset** (`O`): drag from a
curve to the side you want and let go — a parallel copy lands there, on the grid
unless `Shift` (or click the curve to use the `d` in the bar; `+` is outwards
on a closed curve, the left of travel on an open one). **✂ Trim** (`T`): hover a
curve and the piece between its crossings with the other curves on the plane
turns pink; click and it is gone (a middle piece leaves two curves; with no
crossing nothing happens). **⌒ Fillet** (`L`): click a corner to round it with
radius `r` — which starts at the profile's minimum bend radius, so one click
makes a sharp bend legal — or click two open curves and they are joined at their
corner (trimmed or extended straight to it) and rounded; `r = 0` leaves the
corner sharp. `Esc` leaves a tool. **⇩ Project** (`P`, docs/34-project.md):
select curves, press it, pick a plane in the popup — each curve's shadow, cast
along that plane's normal, lands there as a new planar curve (exact Bézier
image, same vertices and types, the outline copied); the originals stay.

Select one curve or several on a plane and press **▱ Shape** in the same
section to fill their outline — a **shape** (docs/30-outline-and-shape-layers.md,
replacing the panel of docs/28): the acrylic, net or print inside the aluminium
frame. An open curve is closed by a straight chord from its last vertex back to
its first, and a curve inside another cuts a **hole**. `expand` (mm in the plane:
**+ bigger**, **− smaller**, corners mitred) and `resolution` shape the outline;
what covers it is a stack of **layers**, each running a **fill** program — the
*Sheet*, a *PVC net* (pitch, wire, angle), *Bubbles* (count, base size, number of
sizes, a clean margin from the edges and from each other, seed — polished red
baubles by default; a fill's colour, metalness and roughness are its look) or
your own — with its own `offset` along the plane normal, material and params.
The curves are untouched, and the shape is its own outliner row.

A curve carries a stack of its own, the **outline**: each layer bends a
**profile** along the line — the aluminium bar on it, an LED string `offset`
mm to the **outside** (on a closed curve; the left-hand side of an open one)
and another to the inside, `lift`ed off the plane — with its own params,
material and fixture; bend radius and stock length are checked per layer on
the layer's own parallel curve. A curve with no layers is a construction line.

**Reference image** (docs/19-reference-image.md) — put a drawing on a plane and
draw the shapes over it instead of typing coordinates. The *Reference image*
section of the plane loads an image (or drop an image file on the viewport
while the plane is active); it lies just behind the plane, faded, under
everything drawn on it. **Set scale…** is what makes it real: click two points
on the image, type how far apart they are in mm (the drawing's own dimension),
and the image is scaled to match — everything traced on it is then in true mm.
While it is **unlocked** it shows four corner handles: drag it to move, drag a
corner to scale. **Lock** it (the normal state) and clicks, box select and the
gizmo pass straight through, so tracing cannot disturb it.
**Group** (`⌘G`) turns the selected plane (or the plane of the selected curves)
into an **object**: planes, their curves and the lofts between them move,
rotate, scale (gizmo) and duplicate as one; the Plane section's *object*
dropdown adds more planes to it. **Objects hold objects** (docs/18): `⌘`-click
object rows in the outliner and `⌘G` again to make a parent, or use the Object
section's *parent* dropdown. Every object carries its **own placement** — moving
or rotating it moves everything under it and touches nothing inside (scaling
still bakes into the contents, so profiles stay real millimetres), and the
placement fields of anything inside it read as **local to it** (the panel shows
where that lands in the world). The eye on an object row **hides** it: its
planes, curves, lofts and LED lamps leave the viewport, the lighting and
picking — children follow their parent, and checks keep running. A click in the
viewport selects the outermost object, a double-click steps one level in;
*Ungroup* (`×`) lifts the contents into the parent without moving anything. Deleting an object (`⌫`, the rail's `✕`, the panel's *Delete…*) asks first: *Delete with contents* or *Explode* — explode keeps everything and only drops the object. `⌘J` joins the nearest ends of two open curves. `Tab` / double-click edits the selected curve.
A label at the **top-left of the viewport** says what is selected; the
**right-hand rail** (the navigation cube sits left of it) carries *Frame* —
**⊙** frame the selection (`.`, Blender's numpad `.`: the pivot moves onto it
and the view zooms to its extents), **▤** everything on the active plane,
**⛶** everything (`F`), **⊥** look straight at the active plane (`Home`) —
then *Select* and *Render*: `✦` runs the post-processing script over the
viewport, `⚙` opens its editor.
Both rails are **icon-only** until you drag the grip on their inner edge wider
than 110 px, when each button spells out its name and each section its title in
the section's colour (a double-click on the grip flips back; the width is one
setting for both rails and is remembered) — docs/23.
The **selection filter** (curve `○` · surface `◫` (lofts and shapes) ·
plane `▤` · object `▣`, keys `1`–`4`) says which levels a click may select: a click
picks the lowest enabled level the hit belongs to — turn *Curve* off and
clicking a curve selects its plane; leave only *Object* on and it selects the
object (a surface hit does the same through the object holding its curves).

**Materials and textures** — every *material* dropdown (Curve and Loft
sections) lists the project's materials, the browser library under *Add from
library* (picking copies it into the project, so files stay self-contained)
and ends with **Material editor…**, which opens the **materials page**
(`/materials.html`) in its own tab — it mirrors the open project and every
change there is an undoable step in the designer, shown in its viewport and
on the page's own preview (1 m box / sphere / bent tube / loft / your `.obj`).
There materials are renamed, reordered (drag; that is the dropdown order),
duplicated, edited as **TSL** code (`⌘⏎` applies) and saved to the library; **textures** (PNG / JPEG / WebP, kept in the project)
are added by file or drop, renamed, replaced and sampled in code with
`texture(host.texture('id'), host.uv.xy)`; and a `.blend` can be opened (or
dropped) to convert its materials — packed images come along as textures.
Lofts and the sheet show a 100 mm checkerboard by default, curves their profile
colour; uvs are millimetres on all three, `host.uv` metres, so patterns and images keep their
physical size. See [docs/13-material-editor.md](docs/13-material-editor.md),
[docs/10-materials.md](docs/10-materials.md) and, for the `.blend` reader and
the node → TSL conversion, [docs/09-blender-import.md](docs/09-blender-import.md).

**Profiles and fills** — the stock an outline layer is bent from (the layer's
*profile* dropdown: flat bar, round tube, …) is **code**: `(three, curve, params) =>
BufferGeometry` (uv in mm) run on the layer's curve, on every array copy, with the
layer's material. Profiles declare numeric *params* with defaults (width,
diameter, pitch …); each layer can override them (number fields under the
dropdown), and the profile's colour and bend limits still drive the checks. A
**fill** is the same idea over a shape's surface: `(three, surface, params) =>
BufferGeometry`, `surface` giving the loops, the flat sheet, `inside`, `heightAt`,
`clip` and a seeded `random`. *Profile editor…* / *Fill editor…* open the
**programs page** (`/shapes.html`, own tab, mirrored like the materials page):
project profiles and fills, presets of both (flat bar, round tube, box section, a
braided LED string whose tips glow through the post script; sheet, PVC net,
bubbles), a browser library, a preview on a sample or project curve — or a sample
or project surface — with a 100 mm UV checker, the parameter table and the code
editor (`⌘⏎`). `three.sweep(curve, outline, { holes, rotate, up })` sweeps a
cross-section with mm uv and end caps — flat to the plane on 3D curves. See
[docs/14-shapes.md](docs/14-shapes.md) and [docs/30-outline-and-shape-layers.md](docs/30-outline-and-shape-layers.md).

**Cameras and post-processing** — cameras are objects in the outliner
(**◉** on the viewport rail makes one from the current view): their properties
in the panel set the film back (full frame, APS-C, phone, …) and lens — the
field of view, shown as Blender's camera frame in the viewport (the film-back
rectangle inscribed, the outside darkened by the passepartout) — depth of
field (f-stop; the focus is set with the ◎ focus tool: click on any geometry)
and pose. The viewport **always looks through a camera** (a new project
starts with *Camera 1*; the last one cannot be deleted): the **▾** under the
navigation cube opens the view popup with the camera looked through
(navigating then moves it), *+ New camera from this view* — the way to leave
a camera where it stands: the new one takes the current view, a copy of the
world you leave and the default lens — and perspective / orthographic (a
detour that leaves the camera's pose alone). The viewport rail
holds the selection tools in three sections: *Edit* (edit, duplicate, join),
*Surface* (loft, shape) and *Object* (group, delete).
Post-processing is a **script with knobs**, like shapes and materials —
`(post, params) => outputNode` with `post.ssr / bloom / lensflare / streaks / dof`
— edited in **post mode** (**⚙** on the viewport bar): the panel becomes the
editor with presets (*Eevee glow* is the default: AgX, the lamps mirrored in
the metals, soft bloom with a knee, glare streaks, lens flare, DOF), a browser library and the knob table, while
the viewport previews the draft until you commit. **✦** switches the script
off and on; **⧉** renders a still of the camera frame (3840 px wide, through the
script, without helpers) and downloads it. The viewport only draws a frame when
something changed, at half the pixels while the camera moves
([docs/32](docs/32-render-on-demand.md)). See [docs/15-camera.md](docs/15-camera.md).

**World** — every camera carries its **world** (the *World* section of its
panel): the background and the lighting (Blender's world) — a colour or an
equirectangular HDR behind the objects, the environment that lights them
(none, a uniform colour, the studio room, or the HDR — strength, rotation),
one sun (azimuth / elevation, colour, strength, shadows) and the exposure.
Nothing lights the scene that is not there. The viewport shows the world of
the camera looked through, so a hero shot on an HDR and a catalogue shot on
plain white live in one file as two cameras; a new camera copies the world
of the one it is made from. HDR files are project textures (add them from
the world section or the materials page). See
[docs/16-world.md](docs/16-world.md) and
[docs/36-camera-world.md](docs/36-camera-world.md).

**Emitters and pixel animations** — an LED string numbers its lamps, and
each lamp is a **pixel**. An outline layer becomes a **fixture** (curve panel ›
the layer's *Fixture* rows): 1–3 daisy-chained chains of 80 pixels reading an **animation
map** — a PNG where x = LED id and y = frame — from a column offset, so
several strings share one map — each fixture reads its own map, several
maps play at once. The topbar **transport** is the one clock they share:
play / hold, ⏮ back to *in*, the **in / out** range in seconds (out empty =
the longest map patched), **loop**, and — while it plays — the clock with the
rate the viewport is drawing at (red when that falls behind the fastest map,
which means rows are skipped, not that the animation runs slow); a map shorter than the range repeats,
and the fixture's own frame shows in its panel section. Switch on
*Emitters* in the world and the lamps **light the scene**: no lights are
placed, the emissive geometry is the source, with soft shadows from the
structure. See [docs/17-emitters.md](docs/17-emitters.md).

**Edit mode** — the camera snaps straight onto the curve's plane (orthographic);
the curve is always edited in 2D on that plane, even if you tilt the view with
the navigation cube to inspect it. With the **`+` Add points** tool (`A`) a click on the
plane adds a point and a click on the curve inserts one; with the Move /
Rotate / Scale tools (`W` / `E` / `R`) the **gizmo** sits on the selected
vertices and clicks select. Drag vertices and their Bézier **handles** (`V`
cycles Polygon / Equal / Free, or right-click — new vertices are **Polygon**,
so a fresh curve is a polyline until you round a vertex, docs/27),
`Del` removes the selection,
`C` opens/closes the curve, drag on empty plane box-selects (`Alt` adds), `⌘A`
selects all, dragging any selected vertex moves the whole selection, `B`
**breaks the curve apart** at the selected vertices. While dragging, vertices **snap into alignment** with
other vertices (pink guides) and to the 10 mm grid. `Shift`-click selects
several vertices; right-click (or `H`, `⇧V`, `D`, `P`) adds **vertex
constraints** — keep horizontal / vertical / distance / pin — that the solver
keeps true when you move things. The **Constraints** window shows every outline
layer's profile with its limitations (live ✓/✗) and the vertex constraints;
A curve can be switched to **3D** (*type* dropdown): it is still drawn on its plane, but every vertex gets a `z` **offset along the plane normal** — set it in the vertex row (x, y, z), `Alt`-drag a vertex, or grab the gizmo's Z arrow after tilting the view with the cube; raised vertices show a dashed drop line to the plane, and bend radius / length are checked in 3D. Switching back to planar flattens the curve. This is the control curve for the coming custom pipe / LED objects.
violations are painted on the curve. The **Modifier** section adds a linear or
circular **array** (docs/26): linear repeats by an offset, circular turns about a
**line** — an axis point and an up direction, so a curve drawn on the front plane
can ring a vertical post. Select the plane and the array's handles appear in the
viewport (amber): click one — or its ◇ button in the panel — and the move gizmo
goes to it, in plane coordinates, snapping like everything else. **Commit** bakes
the copies into real curve objects (spatial ones when they left the plane) and
drops the modifier; ends closer than **merge** mm weld into one curve, so six
copies of an arc come out as one closed ring. The line under the button says how
many curves that will be.

| Key | Action |
|---|---|
| `Tab` | Edit ⇄ Object mode |
| `Esc` | Back to Object mode / deselect |
| `Del` | Delete selected vertices (Edit) or curves / plane (Object) |
| `B` · `⌘A` · `⌘J` · `⌘L` · `⌘G` | Break apart · select all vertices · join two open curves · loft two curves · group into an object (objects too — docs/18) |
| `C` | Open / close the curve |
| `V` · right-click | Cycle vertex type Polygon → Equal → Free · context menu |
| `H` / `⇧V` / `D` / `P` | Keep horizontal / vertical / distance between 2 selected vertices · pin |
| `G` | Toggle 10 mm grid snap (`Shift` while dragging = no snap) |
| `F` · `.` | Frame everything · frame the selection (the selected vertices in Edit mode) · `Home` look at the plane |
| `W` / `E` / `R` · `A` | Gizmo: move / rotate / scale (both modes) · Add-points tool (Edit) |
| `O` / `T` / `L` | Offset · Trim · Fillet tools between curves on a plane (Object, docs/29) |
| `P` | Project the selected curves onto another plane — a popup asks which (Object, docs/34) |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| Mouse | left: select / edit, drag on empty: box select · `⇧`+drag or middle: orbit · `⌘`+drag or right: pan · wheel / pinch: zoom · cube: click snaps to a view, **drag spins the view like a ball** |

### Object archive

An **archive** is a folder of **items** — each one object with everything under
it, saved as a project file of its own (`chelsy-250.deco.json` with a
`chelsy-250.png` thumbnail beside it), carrying only the profiles, fills,
materials, textures and animations it uses. Every item opens on its own, and
a file saved today still reads in a later version.

- **⤓ Archive** (left rail, *Object*) saves the selected object to the archive
  folder. **▦ Insert** opens the browser: pick the folder once (Chrome / Edge
  keep it across reloads; elsewhere *Open…* reads one for the session and
  saving downloads the file), filter by name or tag, click a thumbnail to bring
  the object in under the selected object — or drop a `.deco.json` on the
  viewport.
- Bringing in never changes what is already there: an identical profile or
  material is reused, a differing one with the same id comes in renamed.
- **⤓ Export / ⤒ Import** (topbar, beside the file name) do the same for the
  **whole file**: Export saves it as one item — loose planes and several
  objects get an enclosing object named after the project, so Import (or ▦
  Insert) brings the work into the next file as a single object; the file
  also opens on its own, cameras and post script included (docs/33 §13).
- From the terminal: `node scripts/deco.mjs archive ls | save <objectId> |
  add <name> | show <name>` on `./archive` (or `$DECO_ARCHIVE`) — docs/33.

## Project layout

```
docs/NN-*.md              the agreed spec of each part
tests/post.test.ts        headless API test: builds a 400×400×3000 tube post with lofted walls
scripts/deco.mjs          agent CLI → dev-server bridge (vite.config.ts) → the open browser tab
CLAUDE.md                 how an agent should look at and change the open document
src/
  main.ts                 wiring: store, viewer, panel, autosave
  model/                  plain data + helpers (types.ts), defaults & demo, Bézier handles, constraint solver, alignment snap
  geometry/               curve sampling & bend radius, profile shapes, extrusion, plane frames, array instances + commit
  checks/                 limitation checks: (curve, profile) → violations; constraints window statuses
  app/                    store.ts (single state, undo, transactions) · commands.ts (every mutation) · examples.ts (products built via commands) · overview.ts · bridge.ts
  view3d/                 viewer.ts (scene, cameras, in-plane editing) · world.ts (background, environment, sun) · pixels.ts (live LED colours) · emitters.ts (light from the LEDs) · effects.ts (post script) · navcube.ts
  ui/                     panel.ts · topbar.ts · contextmenu.ts · dom.ts · scrub.ts (drag a number field)
```

Pattern: one state store; UI and viewport only call named commands; views
render from state; no DOM in `model` / `geometry` / `checks`, no three.js in
`model` / `checks`.

## Open questions

- Minimum bend radii for flat 25×2 (15 mm) and round Ø15 (45 mm) are placeholders — confirm with the bending shop.
- Flat bar stands on its edge by default (25 mm along the plane normal); set the profile's *rotate* to 90° for a bar lying flat.
