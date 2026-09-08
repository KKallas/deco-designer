# Part 11 — One navigation scheme, gizmo in Edit mode, add-points tool

Status: **built 2026-08-26** (asked for directly, spec written with the code).
Builds on Parts 3, 4 and 8.

## 1. Navigation — the same in both modes

| Input | Object mode | Edit mode |
|---|---|---|
| left drag on empty space | **box select** curves | **box select** vertices |
| `Shift` + left drag | orbit | orbit |
| `⌘` (Ctrl) + left drag | pan | pan |
| middle drag · right drag | orbit · pan | orbit · pan |
| wheel · trackpad **pinch** | zoom | zoom |
| `Shift`-click (no drag) | add / remove a curve | add / remove a vertex |
| `Alt` + box | adds to the selection | adds to the selection |
| plain click on empty space | deselect | deselect vertices (add tool: append a vertex) |

Before this part a plain left drag on empty space orbited in Object mode and
`Shift`-drag was the additive box in Edit mode; both modes now share one
scheme, so the trackpad gestures (`Shift` / `⌘` + drag, pinch) never depend
on the mode. `Shift` held *during* a drag still disables snapping.

Implementation: OrbitControls' left button is `null` by default; the viewer's
capture-phase `pointerdown` sets it per press (OrbitControls swaps rotate ⇄
pan when a modifier is held, so `Shift` → `PAN` gives an orbit and `⌘` →
`ROTATE` gives a pan) and remembers the press as a possible `Shift`-click,
resolved on `pointerup` if the pointer did not move. Object-mode box select
picks every curve with a vertex inside the box (only while the *Curve* level
of the selection filter is on).

## 2. Gizmo in Edit mode

The Move / Rotate / Scale gizmo of Part 4 also appears in Edit mode, on the
**selected vertices**: the same 2D in-plane gizmo as for curves (X/Y arrows +
square, one ring about the plane normal, X/Y/uniform scale), pivot = bounds
centre of the selected vertices. It transforms the vertices *and their
handles* (`cmd.transformVertices`, one undo step per drag); pinned vertices
stay, the constraint solver treats the moved vertices as fixed. Moving with
the gizmo uses the vertex-to-vertex / alignment / grid snapping of Part 4
with the vertex nearest the pivot as the anchor. Direct vertex dragging keeps
working; the gizmo is hidden while the add-points tool is active.

This supersedes Part 4, decision 2 ("Edit mode keeps direct vertex dragging"
only).

## 3. Add-points tool

The rail gets a fourth button in Edit mode: **`+` Add points (`A`)**. With it
active, a click on the plane appends a vertex and a click on the curve inserts
one there (and starts dragging it); vertices can still be selected and dragged.
`W` / `E` / `R` (or the rail) return to the gizmo tools, where clicks select
and drag on empty space box-selects — nothing is added by accident. A curve
that enters Edit mode with fewer than two points (`+ Curve`) starts in the
add tool; an existing curve starts with the gizmo.

## 4. Decisions
1. `Shift`-drag = orbit and `⌘`-drag = pan everywhere; the additive box moved to `Alt`.
2. The Edit-mode gizmo is the Part-4 curve gizmo applied to vertices — no new gizmo kind.
3. `A` = add-points tool (`⌘A` stays select all).

## 5. Out of scope
Numeric input while dragging · a lasso · touch box select.
