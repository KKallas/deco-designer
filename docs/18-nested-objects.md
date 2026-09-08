# Part 18 — Nested objects (objects in objects, with their own frame)

Status: **built 2026-08-31**. Builds on Part 4 (gizmos), Part 6
(objects), Part 8 (selection filter). Lifts Part 6 §3 "nested objects · out of
scope".

## 1. What it is
An object may contain **objects** as well as planes, it carries its **own
placement**, and it can be **hidden**.

```
ObjectGroup { id, name, planes: Id[], groups: Id[], placement: Placement, visible: boolean }
Project.version: 10        // 9 → 10: groups = [], placement = identity, visible = true
```

- A plane belongs to at most one object; an **object belongs to at most one
  parent object**; a cycle is refused (a group can never be its own ancestor).
- The placement is the plane placement type (`position` + `rotation`,
  `preset: 'custom'`) — **rigid, no scale**: see §5.2.
- Everything inside an object — planes, their curves, the lofts between them,
  child objects and everything under *them* — is placed **relative to it**.

## 2. Frames (the one real change)

World matrix of a plane = `M(root object) · … · M(parent object) · M(plane.placement)`.
One helper next to the existing ones in `src/geometry/placement.ts`:

```ts
export function groupMatrix(project: Project, groupId: Id | null): THREE.Matrix4  // the ancestor chain
export function planeWorld(project: Project, plane: Plane): PlaneFrame            // × plane.placement
```

Every `planeFrame(plane.placement)` / `planeMatrix(plane.placement)` call site
(16: `src/view3d/viewer.ts`, `src/geometry/loft.ts`) goes through `planeWorld`.
Consequences:

- Curves stay 2D in **plane-local mm**; profiles, bend radius, stock length,
  snapping, array copies, pixels are untouched — the composed frames stay
  orthonormal, so mm stay mm.
- Moving or rotating a parent writes **one** placement (its own): no baking into
  descendants, no drift from repeated bakes, one small undo step, and a child
  keeps its own local placement so it can still be moved on its own afterwards.
- The Plane section's position / rotation fields are **local to the parent
  object** (labelled `local` when the plane is in one), with the world position
  as a dim readout beside them. Same for a child object's fields.
- `movePlane`, plane drags and vertex-to-vertex snapping keep working in world
  space: the drag delta is converted into the parent's frame before it is
  written (`worldToLocal` of the parent chain).

## 3. Grouping, selection, transforms

- **Selection carries objects**: `Selection.groups: Id[]` replaces `groupId`.
  Click an object row to select it, **shift-click** to add more (as curves).
- **⌘G** makes a parent from the selected objects **and** planes (mixed is
  fine). The new object's origin is the **bounds centre** of its contents and
  their placements are rebased into it, so nothing moves on screen.
- The Object section gets a **parent** dropdown (like the Plane section's
  *object* dropdown) — `cmd.setGroupParent`; choosing a new parent (or *none*)
  rebases the placement so, again, nothing moves.
- **Ungroup** (`×`) dissolves one object: its planes and child objects move up
  into its parent (or to the top level) with its placement baked into theirs.
- **Gizmo / drag act on the highest selected object**: dragging a curve whose
  plane sits three levels down inside the selected object moves the selected
  object. W/E moves and rotates it by writing its own placement; **R (scale)
  stays the Part 6 bake** (§5.2). The pivot is the bounds centre of the whole
  subtree, as today. With several objects selected the gizmo sits at the bounds
  centre of all of them and each one's own placement is written.
- **Clicking in the viewport** with the `object` filter selects the **outermost**
  object (the root of the chain); **double-click steps in** one level (root →
  child → … → plane), so a post inside a rig is still reachable by mouse.
- **⌘D** duplicates the whole subtree (planes, curves, constraints, lofts, child
  objects).
- **Deleting an object asks first** (⌫ / the rail's `✕` / the panel's *Delete…*):
  a small question in the middle of the window — *Delete with contents* removes
  the whole subtree, *Explode* removes only the object and its contents move up
  into the parent (the same as *Ungroup*), *Cancel* or Escape does nothing. An
  **empty** object holds nothing to lose, so it goes without the question, and
  with several objects selected the answer applies to all of them.
- Outliner: child objects nest under their parent, ordered objects first, then
  planes, then the object's lofts.

## 4. Visibility

- Every object row gets an eye toggle: `👁` visible, `◌` hidden —
  `cmd.setGroupVisible(store, ids, boolean)`, undoable, also in the Object
  section.
- Hidden = **not built in the viewport**: its planes' curves, the lofts inside
  it, its grid helpers and its LED lamps are all left out of the scene.
- **Inherited**: everything under a hidden object is hidden. A child's own eye
  keeps its state and is drawn dimmed while an ancestor hides it.
- A hidden object does **not light the scene** (its lamps leave the emitter
  bake, which re-bakes) and is **not pickable** in the viewport; it is still in
  the project, still exported, still checked — `overview` prints `hidden` on the
  row and still counts its violations.
- Selecting a hidden object from the outliner still works (gizmo and panel show;
  nothing is drawn).

## 5. Decisions (say so if you want them changed)
1. **Multi-select objects + ⌘G** to nest (asked for), so `Selection.groupId`
   becomes `Selection.groups: Id[]` across store, panel, viewer and pick.
2. **Object placement is rigid** — position + rotation, no scale. Scaling an
   object keeps the Part 6 behaviour: R **bakes** into the descendants' plane
   positions and curve vertices. Reason: a scale in the frame would scale the
   swept profile with it (a 20 mm tube drawn at 2× becomes 40 mm) and the bend
   radius / stock length checks would stop meaning millimetres of real
   aluminium. Say the word and scale joins the placement.
3. Objects still do not own curves or lofts directly: membership is planes, and
   a **loft belongs to the deepest object that contains both its curves' planes**.
4. Clicking selects the outermost object, double-click steps in.
5. Hidden objects are dropped from the viewport, the emitter bake and picking,
   but keep their checks.
6. Deleting an object is a question, not a straight delete: *Delete with
   contents* or *Explode*. Reason: an object is a container, and losing a whole
   subtree to one ⌫ is the expensive mistake. Empty objects skip the question.

## 6. Bridge

```js
const rig = cmd.addGroup(store, { planes: [], groups: ['object-1', 'object-2'], name: 'Rig' })
cmd.setGroupParent(store, 'object-3', rig)          // null = top level; rebased, nothing moves
cmd.setGroupPlacement(store, rig, { position: { x: 0, y: 0, z: 1500 } })
cmd.setGroupVisible(store, [rig], false)
cmd.ungroup(store, rig)                              // children move up, placement baked in
overview()                                           // nests objects, marks hidden ones
```
`cmd.addGroup(store, planeIds)` (the Part 6 signature) keeps working.

## 7. Verify
`tests/nested.test.ts` (13 cases): world frame of a plane two levels down;
parent move leaves the child placements and curve points untouched and moves
world points by exactly the delta; a selected parent + child transform once;
scale bakes into the contents and leaves the frames rigid; ⌘G rebase and
ungroup bake are both no-ops on screen; reparenting refuses cycles; hiding a
parent hides the subtree while the child keeps its own eye; duplicate copies
the subtree with its lofts; a click resolves to the outermost object; a loft
inside an object follows it; migration of a version 9 project.

## 8. Out of scope
Instancing / linked duplicates · per-object modifiers · per-plane and per-curve
visibility · animating an object's placement · drag-to-reorder in the outliner ·
scale in the object frame (§5.2).
