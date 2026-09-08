# Part 10 — Materials on curves and lofts

Status: **built 2026-08-26**; Part 13 (2026-08-26) replaced §3's *Materials*
section and the importer's role with the material editor (rename, reorder,
code, textures, .blend import in one window) and added `Project.textures`.
Builds on Part 9 (Blender import).

## 1. What it is
A project carries its own **materials** — TSL source converted from Blender
(Part 9) — and every curve object and loft can point at one:

```
Material   { id, name, code, source, warnings }   // code: (tsl, host) => MeshPhysicalNodeMaterial
CurveObject.materialId: Id | null                 // null = the profile's colour
Loft.materialId: Id | null                        // null = the 100 mm checkerboard
Project.materials: Material[]
```

## 2. Getting materials in
- **Library** (`localStorage` `deco/material-library`, src/materials/library.ts):
  the importer's **Add to designer** button asks for a name (prefilled from
  the material, or from the code header) and puts the current code there; the
  designer's dropdowns list it under *Add from library* and picking an entry
  **copies it into the project**, so a saved project file is self-contained.
- Commands: `addMaterial`, `updateMaterial`, `removeMaterial`,
  `setCurveMaterial(store, ids, id)`, `setLoftMaterial(store, id, id)`.

## 3. UI
- **Curve** section: *material* dropdown (applies to every selected curve).
- **Loft** section: *material* dropdown.
- **Materials** section (whenever the project or the library has any, no
  selection needed): project materials — rename, use count, ⚠ if the
  conversion listed warnings (hover to read them), *Use* puts it on the
  selected curves / loft, × removes it (users go back to their default look);
  below it the **Library** rows from the importer with *＋ Add* (copies it
  into the project and, if something is selected, assigns it) and ×.
- Selected curves / lofts still glow blue: the glow is added to the
  material's emissive.

## 4. Rendering
- One host for the whole scene (`hostForObjects`): `generated` reads each
  mesh's own bounding box through per-object uniforms, so a material compiles
  once per (material, selected / normal) and is shared by all meshes.
- **uv is in mm on every mesh**: lofts (Part 5) and now round tubes (u along
  the tube, v around it); `host.uv` divides by 1000 → metres, Blender's unit,
  and is the converter's default texture coordinate (Part 9) — the physical
  size of a pattern is the same on a 1 m and a 3 m piece.
- A material whose code throws falls back to the default look (console
  warning once); editing the code in the importer and re-adding it replaces
  the library entry (same id) — re-pick it in the dropdown to update the
  project copy.

## 5. Decisions
1. Materials are copied into the project, not referenced from the library — files must open on another machine.
2. Node materials are cached per material id + code; the profile-colour and checkerboard defaults stay as before.
3. No per-face / per-instance overrides; array copies share the curve's material.

## 6. Out of scope
Per-object material slots. (Image textures and an in-designer editor: Part 13.)
