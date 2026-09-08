# Part 5 — Loft object

Status: **built 2026-08-25**. Builds on Parts 1–4.

## 1. What it is
A **loft** is a top-level object (listed in the outliner like planes) that spans a
surface between **two curves**, which may lie on the same or different planes.
It is the basis for later material fills (PVC / garland) and for lofting
checks.

```
Loft { id, name, a: curveId, b: curveId, resolution: 2, strips: 4, flip: false }
```

## 2. Geometry
- Both curves are **resampled** by equal arc length into `n = resolution × max(vertices of a, vertices of b)` points (default resolution 2).
- Sample *i* of curve A is connected to sample *i* of curve B (the rulings). If the curves run in opposite directions the rulings would cross; the shorter total ruling length wins automatically, and **flip** overrides it.
- The band between the curves is divided into `strips` rows (default 4). Every cell of the resulting grid is filled **black or white in a checkerboard**, so the ruling grid is visible on the surface. The mesh is double-sided.
- Curves are taken as drawn (array-modifier copies are not lofted).
- The black / white **checkerboard is 100 mm squares of surface** (since 2026-08-26 painted from the uvs by a node material, so it no longer follows the resolution × strips grid); a project material replaces it (docs/10-materials.md).
- **UVs are millimetres of surface** (added 2026-08-26): `u` = the **mean arc length of the two edges at the ruling** — constant along a ruling, so lines of constant `u` are the rulings themselves (a fan between two arcs reads as sun rays) and the size is exact mid-band, a little smaller at the shorter edge and larger at the longer one; `v` = distance across the ruling from curve A. A material therefore keeps a constant physical size wherever the loft is wider or longer: `fitTextureToLoft(texture, tileMm)` (src/geometry/loft.ts) sets repeat wrapping and `repeat = 1 / tileMm`. Curved edges are sampled by equal arc length, so `u` follows the curve, not the chord.

## 3. UI
- Object mode: select two curves (Shift-click) → **Loft** button in the outliner bar or `⌘L`.
- Outliner gets a *Lofts* group: click selects the loft (highlighted on the surface); `Del` deletes it. Deleting a curve removes lofts that use it.
- Loft section in the panel: curve A / B dropdowns, resolution, strips, flip.

## 4. Out of scope
Material / colour fill (comes with the material part) · lofts with more than two curves.
**Trimming arrived as Part 24** (docs/24-loft-trim.md): each loft carries `edgeA` / `edgeB`
= `{ start, end, offset, lift }` mm, so both control curves are trimmed (or extended past
their ends), moved in / out across the rulings and lifted out of the surface before it is
built.
