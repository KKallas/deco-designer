# Part 23 — Two toolbar rails, icon or icon + text

Status: **spec 2026-09-01**. Builds on Parts 8 (selection filter), 15 (post),
20 (viewport status bar), 21 (navigation cube).

## 1. What changes
The bar across the top of the viewport (Part 20) becomes a **rail on the right**,
mirroring the rail on the left. Both rails are the same widget: a stack of
**sections**, each a coloured card of buttons.

```
 icon mode                                   text mode (dragged wider)
┌────────────────────────────────┬───┐      ┌──────────────────────┬────────────┐
│ 2 curves · Front           ◳   │ ⊙ │      │ 2 curves · Front  ◳  │ FRAME      │
│                                │ ▤ │      │                      │ ⊙ Selected │
│ ┌───┐                          │ ⛶ │      │ ┌────────────┐       │ ▤ Plane    │
│ │ ▤ │  (navigation cube left   │ ⊥ │      │ │ ADD        │       │ ⛶ All      │
│ │ ○ │   of the rail)           ├───┤      │ │ ▤ Plane    │       │ ⊥ Plane view│
│ │ ◉ │                          │ ○ │      │ │ ○ Curve    │       ├────────────┤
│ ├───┤                          │ ◫ │      │ │ ◉ Camera   │       │ SELECT     │
│ │ ✥ │                          │ ▤ │      │ ├────────────┤       │ ○ Curve    │
│ │ ↻ │                          │ ▣ │      │ │ GIZMO      │       │ ◫ Loft     │
│ │ ⤢ │                          ├───┤      │ │ ✥ Move     │       │ ▤ Plane    │
│ ├───┤                          │ ✦ │      │ │ ↻ Rotate   │       │ ▣ Object   │
│ │ ✎ │                          │ ⚙ │      │ │ ⤢ Scale    │       ├────────────┤
│ │ ⧉ │                          └───┘      │ └────────────┘       │ RENDER     │
```

Nothing is added or removed — the same buttons, in a second rail. The
**selection text** stays where it is: a floating label at the top-left of the
viewport (`.view-label`), still a label and not a control.

## 2. The two rails

| rail | section | colour | buttons |
|---|---|---|---|
| left | **Add** | green | ▤ Plane (▾ front / top / side) · ○ Curve · ◉ Camera |
| left | **Gizmo** | blue | ✥ Move · ↻ Rotate · ⤢ Scale · ＋ Add points (edit) · ◎ Focus (object) |
| left | **Tools** | amber | ✎ Edit · ⧉ Duplicate · ⋈ Join · ◫ Loft · ▣ Group · ✕ Delete |
| right | **Frame** | violet | ⊙ Selected · ▤ Plane · ⛶ All · ⊥ Plane view |
| right | **Select** | teal | ○ Curve · ◫ Loft · ▤ Plane · ▣ Object (the Part 8 filter, keys 1–4) |
| right | **Render** | pink | ✦ Post on / off · ⚙ Edit the post script |

The colour is the section's own: a 2 px stripe down the outer edge of the card
in both modes, and the colour of the spelled-out title in text mode. A section
with nothing to show (Tools in Edit mode) is left out entirely.

## 3. Icon or icon + text — the width decides
One setting for **both** rails, stored in `localStorage` (`deco.rail.width`),
Blender's toolbar behaviour:

- Drag the rail's **inner edge** (the grip: a faint line down the right edge of
  the left rail, the left edge of the right rail). While the button is down the
  rail follows the pointer freely — no snapping, or the first 74 px out of the
  icon rail would feel dead. The drag runs on `window` listeners, *not* on
  pointer capture: every width change re-renders the rail and replaces the grip
  element, which would drop a captured pointer after the first pixel.
- Let go under **110 px** → *icon mode*: the rail snaps back to 36 px, labels hidden,
  the title of each section hidden — the tooltip still says everything.
- Let go at **110 px** or wider → *text mode*: `icon  Label` rows, section titles spelled
  out in the section colour. Clamped to 320 px.
- Both rails always share one width, so the viewport keeps a symmetric frame.
- A double-click on the grip flips between the two (36 ↔ the last text width).

## 4. What moves out of the way
- The **navigation cube** slides left by the right rail's width
  (`NavCube.rightInset`), so it always sits immediately left of the rail —
  its picking, its ▾ view tools and the camera frame follow the same rect.
- With the status bar gone, the cube goes back up to `top: 12` and the right
  rail starts at `top: 10`; the left rail stays at `top: 46`, under the label.

## 5. Decisions
1. The viewport bar **moves** — one home per control, as in Part 20. Nothing is duplicated into the app topbar.
2. One display mode and one width for both rails: they read as one toolbar system.
3. The drag *is* the mode control (Blender): no separate toggle button to find and no third state.
4. The selection text stays a wide floating label — a 36 px rail would cut every name.
5. Section colours are decoration with a job: they say *which group a button belongs to* when the labels are hidden.

## 6. Out of scope
Rearranging or hiding sections · a rail on the bottom · per-rail widths ·
tear-off / floating toolbars · user-editable colours.
