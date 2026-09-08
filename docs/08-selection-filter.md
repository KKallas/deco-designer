# Part 8 — Selection filter

Status: **built 2026-08-25**. Builds on Parts 4–6.

## 1. What it is
A bar at the top centre of the viewport with four toggles — **Curve · Loft ·
Plane · Object** (keys `1`–`4`) — that says which levels a click in the
viewport may select. Several can be on at once (default: all). A click selects
the **lowest enabled level the hit belongs to**:

```
hit a curve  →  curve  →  its plane  →  its object
hit a loft   →  loft   →  the object holding both its curves
```

If no enabled level applies (e.g. only *Object* is on and the curve is not in
an object) the click counts as a click on empty space. Hover shows the pointer
cursor only where a click would select something; double-click enters Edit
only when the hit resolves to a curve.

## 2. Behaviour after the pick
- Curve: as before — select (`Shift` adds) and drag within its plane; if the
  curve's plane / object is already selected, the drag moves that whole
  plane / object (Part 4 / 6 behaviour kept).
- Plane: selects the plane and dragging moves everything on it (same as
  dragging a selected plane row's curves).
- Object: selects the object; dragging a curve of it moves the object; a loft
  hit only selects (lofts are not draggable).
- Loft: selects the loft (settings in the panel).

`resolvePick` (src/model/pick.ts) is pure and tested (tests/pick.test.ts);
the filter lives in the viewer (`viewer.pickFilter`, `viewer.setPickFilter`,
`viewer.togglePickLevel`) like the gizmo mode — it is UI state, not project
state, and is not saved.

## 3. Decisions
1. "Group" in the request = **plane** (the group of curves with one placement); "object" = the object group of Part 6.
2. Toggles, not radio buttons: the point is to say which levels are *allowed*, the lowest one wins.
3. All off is allowed and means viewport clicks select nothing (orbit only).

## 4. Out of scope
Filtering the outliner · remembering the filter. (Box-select in Object mode: Part 11.)
