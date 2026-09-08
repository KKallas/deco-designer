# Deco Designer — agent guide

3D designer for Decolight products: curves bent from aluminium profiles, drawn on
planes, lofted or filled with a shape, grouped into objects. Three.js (WebGPU) + Vite + TypeScript, all
units **mm**. Model → geometry → checks → view3d → ui → app; one store, every
mutation is a named command in `src/app/commands.ts`. The README explains the
UI, `docs/NN-*.md` are the agreed specs — work in parts: spec first, then code.

## See and change the document the user has open

The user works in the browser (`npm run dev`, http://localhost:5173). Talk to
that open document through the bridge (docs/07-agent-bridge.md):

```
node scripts/deco.mjs overview            # start here: one-screen tree with ids, lengths, violations
node scripts/deco.mjs curve <id>          # vertex ids / handles, constraints, violations
node scripts/deco.mjs exec '<js>'         # run in the page; one call = one undo step
node scripts/deco.mjs exec build.js       # or a file / `-` for stdin
node scripts/deco.mjs project | load f.json
node scripts/deco.mjs render out.png [3840]   # a still of the camera frame, full quality, through the post script (docs/32)
node scripts/deco.mjs archive ls | save <groupId> | add <name> [--into <groupId>] | show <name>   # the object archive folder ($DECO_ARCHIVE, ./archive) — docs/33
node scripts/deco.mjs help
```

In `exec` the names `store`, `project`, `cmd.*`, `examples.*`, `types.*`,
`viewer`, `overview()`, `curve(id)`, `setProject(p)`, `demo()`, `fit()` are in
scope. An expression returns its value; a statement body may `return` / `await`.

```js
// examples
cmd.addPlane(store, 'top')                                   // → new plane id
const id = cmd.addCurve(store, 'front'); cmd.setCurveProfile(store, id, 'round15');
cmd.addVertex(store, id, { x: 0, y: 0 }); cmd.addVertex(store, id, { x: 500, y: 300 }); cmd.exitEdit(store); return curve(id);
cmd.setPlanePlacement(store, 'top', { position: { x: 0, y: 3000, z: 0 } })
cmd.setPlaneModifier(store, 'front', { type: 'circular', count: 8, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, angle: 360 });   // a ring about a vertical axis — docs/26
cmd.commitArray(store, 'front', { merge: 0.5 })   // → the copies as real curves, ends welded, modifier gone
const sid = cmd.addShape(store, ['frame', 'cutout']); cmd.updateShape(store, sid, { expand: -25 })   // a surface over curves, the inner one a hole — docs/30
cmd.addShapeLayer(store, sid, { fillId: 'pvc-net', params: { pitch: 40 }, offset: 5 }); cmd.addShapeLayer(store, sid, { fillId: 'bubbles' })   // fill layers: sheet · pvc-net · bubbles
cmd.addOutlineLayer(store, 'front-left', { profileId: 'led-strip', offset: 14 }); cmd.addOutlineLayer(store, 'front-left', { profileId: 'led-strip', offset: -14, lift: 5 })   // outline layers: + outside / − inside — docs/30
cmd.updateOutlineLayer(store, 'front-left', 'led-strip', { visible: false }); cmd.setCurveProfile(store, ids, 'round15', 1)   // the one-profile commands take a layer index (default 0)
const lid = cmd.addLoft(store, 'front-left', 'front-right'); cmd.setLoftEdge(store, lid, 'a', { start: 300, end: -200, offset: 60, lift: 40 })   // trim/extend, across the ruling, out of the surface — docs/24
const copy = cmd.offsetCurve(store, 'front-left', 25); cmd.trimCurve(store, 'front-left', 300); cmd.filletVertex(store, 'front-left', curve('front-left').points[1].id, 60); cmd.filletCurves(store, 'leg-a', 'leg-b', 0)   // plane tools — docs/29
const shadows = cmd.projectCurves(store, ['front-left', 'front-right'], 'top')   // each curve's shadow along the plane's normal, as new planar curves there — docs/34
const rig = cmd.addGroup(store, { groups: ['object-1', 'object-2'], name: 'Rig' });   // objects hold objects — docs/18
cmd.setGroupPlacement(store, rig, { position: { x: 0, y: 1500, z: 0 } }); cmd.setGroupVisible(store, [rig], false); cmd.setGroupParent(store, 'object-3', rig)
cmd.selectPlanes(store, ['top', 'top-2']); cmd.setPlanePlacement(store, ['top', 'top-2'], { position: { y: 250 } })   // several of one class at once (lists beside planeId / loftId / shapeId / cameraId = the primary); the value commands take Id | Id[] — docs/35
examples.buildPost(store, { width: 400, height: 3000, origin: { x: 2000, y: 0, z: 0 } }); fit(); return overview();
const mid = cmd.addMaterial(store, { name: 'Gold', code: '(tsl, host) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.color.set(0xd4a017); m.metalness = 1; m.roughness = 0.3; return m; }', source: '', warnings: [] });
cmd.setCurveMaterial(store, ['front-left'], mid); cmd.setLoftMaterial(store, 'loft-1', mid)   // docs/10-materials.md
const tid = cmd.addTexture(store, { name: 'net', mime: 'image/png', data: 'data:image/png;base64,…', width: 64, height: 64, source: 'net.png' });
cmd.updateMaterial(store, mid, { code: "(tsl, host) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.colorNode = tsl.texture(host.texture('net'), host.uv.xy).rgb; return m; }" })
const sid = cmd.addProfile(store, { label: 'Tube 20', code: '(three, curve, params) => three.sweep(curve, three.circle(params.diameter / 2))', params: { diameter: 20 }, color: '#b9bcc4', limits: { minBendRadius: 60, maxLength: 6000 } });
cmd.setCurveProfile(store, ['front-left'], sid); cmd.setCurveParams(store, ['front-left'], { diameter: 25 })   // docs/14-shapes.md
cmd.addFill(store, { label: 'Dots', code: '(three, surface, params) => surface.sheet.clone()', params: {}, color: '#ffffff', metalness: 1, roughness: 0.1 })   // a fill program with its look — docs/30 §4
```

A plane can carry a **reference image** to trace over (docs/19-reference-image.md):
`cmd.setPlaneImage(store, planeId, { texture, center, width, rotation, opacity, visible, locked })`
(`null` removes it) — a project texture lying 8 mm behind the plane, locked = not
pickable. *Reference image* section in the panel, drop an image on the viewport,
*Set scale…* = click two points and type the mm.

Plane frames: `front` = XY (normal +Z), `top` = XZ (local y → world −z, normal +Y),
`side` = YZ. Curves are 2D in plane-local mm; `exitEdit` drops curves with < 2
points. A curve with `type: 'spatial'` (docs/12-3d-curves.md) also carries a
`z` offset along the plane normal per vertex: `cmd.setCurveType(store, id, 'spatial')`,
then `cmd.addVertex(store, id, { x, y, z })` / `cmd.moveVertices(store, id, [{ vid, p: { z: 250 } }], false)`
(new vertices are **polygon** — straight sides; `cmd.setVertexType(store, id, vids, 'equal' | 'free')` gives one handles, docs/27-vertex-types.md)
(planar curves ignore `z`; switching back to `'planar'` flattens). A curve's **outline** (docs/30) is a stack of layers, each a
**profile** (`flat25x2`, `round15` by default — code `(three, curve, params) => BufferGeometry` plus params, colour and limits,
docs/14-shapes.md) at a side `offset` and `lift`, with its own params, material and fixture; checks (bend radius / stock length;
straight two-vertex curves never violate) run per layer on the layer's own parallel curve. No layers = a construction line. A
**shape** (`project.shapes`) is a surface over one or more curves of a plane (even-odd: a curve inside another is a hole) with
**fill** layers (`project.fills`: `sheet`, `pvc-net`, `bubbles` — code `(three, surface, params) => BufferGeometry`).

## Object archive

An **item** is one object with everything under it saved as a **project of its
own** (`<slug>.deco.json` + a `.png` thumbnail) carrying only the profiles /
fills / materials / textures / animations it references — docs/33-object-archive.md.
An archive is a plain folder of them. `archiveItem(project, groupId)` cuts one
out, `cmd.importItem(store, json, { into })` brings one in: assets merge by id
(identical → reused, differing → renamed `round15-2`, the project's own never
change), then the subtree copies through `insertGroup` (src/app/insert.ts — the
same walk as ⌘D). In `exec`: `archive.item(id, { images, tags })`,
`archive.insert(json, { into })`, `archive.overview(json)`. GUI: ⤓ Archive /
▦ Insert on the left rail (folder via `showDirectoryPicker`, kept in IndexedDB).
`exportProject(project)` (`archive.export()`, topbar ⤓ Export) is the whole
file as one item — loose planes / several root objects wrapped in an object
named after the project, images and cameras kept — and topbar ⤒ Import brings
any item file in (docs/33 §13).

## Objects nest

An object (`project.groups`) holds planes **and objects**, and carries its own
rigid `placement` — everything inside is placed relative to it, so a plane's
world frame is `M(root) · … · M(parent) · M(plane.placement)`
(`planeWorld(project, plane)` in src/geometry/placement.ts; never read
`plane.placement` as world). Moving or rotating an object writes only its own
placement; **scale bakes** into the contents so profiles stay real mm. `visible`
hides a whole subtree (out of the viewport, the emitter bake and picking, still
checked). Selection carries several objects (`selection.groups`), ⌘G nests them,
a click selects the outermost object and a double-click steps in — docs/18-nested-objects.md.

## Shapes

A profile is a shape program `(three, curve, params) => BufferGeometry`
(src/geometry/shape.ts runs it with the curve's Bézier path, samples, frames
and plane normal; `three.sweep` in src/geometry/sweep.ts sweeps a cross-section
with mm uv). Presets and the legacy migration live in src/model/profiles.ts;
profiles and fills are edited on `shapes.html` — the programs page (src/shapes/main.ts, own tab over the
channel like materials) — docs/14-shapes.md, docs/30. Fills run in src/geometry/surface.ts over the surface a shape's curves enclose.

## Camera and post-processing

`project.cameras` are camera objects (film back, focal length, DOF, frame, pose;
`activeCamera` is looked through, null = the free 35 mm view) — src/model/camera.ts;
`project.post` is the post-processing **script**
`(post, params) => outputNode` with knobs, run by src/view3d/effects.ts over
the scene pass (bloom / lensflare / streaks / dof helpers; presets in
src/model/post-presets.ts). Cameras are outliner objects with properties in the
panel; the post script is edited in **post mode** (topbar *Post…*: the panel is
the editor, the viewport previews the draft; ✦ = `post.enabled`) — docs/15-camera.md.
`const cam = cmd.addCamera(store, { name: 'Hero', focalLength: 85, dof: { enabled: true, focusDistance: 2500, fStop: 2 } }); cmd.setActiveCamera(store, cam)`,
`cmd.setPost(store, { params: { ...project.post.params, radius: 0.5 } })`. `post.ssr(node, { intensity })` mirrors the
lamps on screen in the metals (docs/31-ssr.md; the Eevee knob `reflections`, metals only, screen-space).

## World (background and lighting)

Nothing lights the scene but the **camera's world** (`camera.world`, docs/16-world.md,
docs/36-camera-world.md — there is no project world): background (colour or
equirectangular HDR), environment (none / colour / studio room / HDR, strength,
rotation), one sun (azimuth clockwise from +Z, elevation, colour, strength,
shadows), the exposure of the always-on AgX view transform, and the emitters.
The viewport **always looks through a camera** (`project.activeCamera`, never
null; a project has ≥ 1 camera, the last one cannot be removed) and shows that
camera's world; `activeCameraOf(project)` (src/model/camera.ts) is the one in
force. To leave a camera where it stands, make a new one from the view (◉ on
the rail / the ▾ popup) — it copies the world it leaves. HDRs (`.hdr` / `.exr`)
are project textures (`mime: 'image/vnd.radiance'` / `'image/x-exr'`); the
autosave is IndexedDB. The camera panel's *World* section edits it;
`src/view3d/world.ts` (`WorldRig`) applies a world to a scene for the viewport and both pages.
`cmd.setWorld(store, { background: { kind: 'color', color: '#ffffff' }, environment: { kind: 'color', color: '#ffffff' }, sun: { enabled: false } })`   // the active camera's world,
`cmd.updateCamera(store, cam, { world: { environment: { kind: 'hdr', texture: 'sky' }, strength: 1.5 } })`, `cmd.addCamera(store, { name: 'Look', pose, world: activeCameraOf(project).world })`.

## Emitters: LED pixels and animations

An LED shape numbers its lamps with a `pixel` vertex attribute; each lamp is
a pixel (docs/17-emitters.md). A curve patched as a **fixture**
(`curve.pixels = { chains: 1..3, animation, offset, reverse }`, 80 pixels per
chain) reads an **animation** — `project.animations`, a PNG project texture
where x = LED id and y = frame — on the project's one clock
(`project.playback` — play / hold, in / out in seconds and loop, docs/22; the
current time is viewer state). `world.emitters`
makes the lamps **light the scene**: a transfer matrix from the lamps to a
grid of SH probes is baked in background slices (with voxel visibility for
soft shadows) and multiplied by the live colours every frame — no lights are
placed, diffuse only, `post.ssgi` adds the near-field bounce.
src/geometry/probes.ts is the maths, src/view3d/pixels.ts the colours,
src/view3d/emitters.ts the scene side.
`const a = cmd.addAnimation(store, { name: 'Chase', texture: tid, fps: 30, frames: 600, width: 240 });`
`cmd.setCurvePixels(store, ids, { chains: 1 }, layerIndex); cmd.chainCurvePixels(store, ids, a, layerIndex); cmd.setPlayback(store, { playing: true, start: 0, end: null, loop: true });`   // a fixture is an outline layer (index 0 by default)
`cmd.setWorld(store, { emitters: { enabled: true, strength: 1.5 } })`

## Materials, textures, Blender

Users manage materials on the **materials page** (`materials.html`,
src/editor/main.ts, its own tab opened from any material dropdown —
docs/13-material-editor.md): rename / reorder / edit code with a 3D preview,
project **textures** (`project.textures`, base64 images sampled with
`texture(host.texture('id'), host.uv.xy)`), the browser library
(src/materials/library.ts) and .blend import. The page mirrors the designer
tab's store over a BroadcastChannel and sends commands back (src/app/channel.ts)
— the designer stays the single store; the bridge only talks to the designer
tab. The parser (src/blend/parser.ts) reads materials and packed images
(src/blend/shaders.ts); src/blend/tsl.ts converts a node tree to TSL source run
by src/materials/runtime.ts (docs/09-blender-import.md).
The fixture `tests/fixtures/golden-net.blend` + `.json` is regenerated with
`/Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/blend-fixture.py`.

## Verify

`npm test` (vitest, Node, headless — `tests/`), `npm run typecheck`, `npm run build`.
