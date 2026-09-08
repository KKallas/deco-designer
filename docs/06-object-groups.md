# Part 6 — Objects (groups of planes and lofts)

Status: **built 2026-08-25**. Builds on Parts 1–5.

## 1. What it is
An **object** groups planes. Everything on those planes (curves) and every loft
whose two curves are inside the object belong to it. The object can be moved,
rotated, scaled, duplicated and deleted **as one**.

```
ObjectGroup { id, name, planes: Id[] }        // lofts are implied: both curves inside
```
**Part 18 supersedes the model below**: an object also holds child objects and
carries its own placement — docs/18-nested-objects.md.

- A plane belongs to at most one object; planes outside any object stay top-level.
- Transforms are applied to the member planes' placements (no nested coordinate
  system): move adds a translation, rotate turns the placements about the
  object's pivot (bounds centre of all its vertices), scale is uniform about the
  pivot — plane positions scale and the curves' vertices scale with it.
- Duplicate copies planes, curves, constraints and the lofts between them (fresh ids), shifted 200 mm in X.

## 2. UI
- Outliner: objects are top-level rows (▣) with their planes, curves and lofts nested; ungrouped planes and lofts follow.
- **Group** (`⌘G`): makes an object from the selected plane (or the plane of the selected curves). The Plane section has an **object** dropdown to move a plane in / out of objects.
- Click an object row to select it: a 3D gizmo appears at its pivot (W/E/R); dragging any of its curves moves the whole object (with vertex-to-vertex snapping, world space).
- `⌘D` duplicates the object; the row's `×` **ungroups** (contents stay); **Delete** with the object selected removes everything in it.

## 3. Out of scope
Nested objects (done in Part 18) · per-object modifiers · instancing.
