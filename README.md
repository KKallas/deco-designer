# Deco Designer

A simple 3D designer for **Decolight** products that almost anybody can use.
You draw 2D curves, they become aluminium pipes; pipes become loft guides for
areas filled with PVC or golden garland; finally you lay LED light strings on
top of the finished structure.

Built with **Three.js on WebGPU** (`three/webgpu`, WebGL2 fallback), Vite and TypeScript.

## Design workflow

1. **Draw 2D curves** – each curve is drawn in a plane and turned into an aluminium pipe.
   - Round Ø25 mm (default) or square 15×15 mm profile.
   - A curve can be open or closed; the plane can be positioned/rotated in 3D.
2. **Loft areas** – two or more pipe curves act as guides for a lofted surface.
   The surface is *marked* with a material: **PVC** or **golden garland**.
3. **Add lights** – draw a 3D curve on top of the design. It becomes a guide for
   an LED string: three 4 mm wires twisted together with an LED every 50 mm.
   - LED: 40 mm high, Ø8 mm, bottom ⅔ opaque plastic, bright coloured top.
   - Strings come in fixed sizes: **5 m** or **10 m** cable, **80 LEDs** each.
     The designer shows when a guide curve is longer than a string can light.

Everything except lights is made from one or more 2D curves. Build the deco first, add lights on top.

All units are **millimetres**.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build in dist/
```

WebGPU needs a recent Chrome/Edge (or Safari 26+ / Firefox with WebGPU enabled).
Without it the renderer falls back to WebGL2.

## Project layout

```
index.html
src/
  main.ts               entry: WebGPU renderer, scene, demo project
  domain/
    catalog.ts          Decolight product specs (pipes, fill materials, LED strings, colours)
    types.ts            project model: Curve2D, Loft, LightString, DecoProject
  geometry/
    pipe.ts             2D curve -> aluminium pipe mesh (round tube / square extrusion)
    loft.ts             2+ curves -> lofted surface with fill material
    lights.ts           3D curve -> twisted wires + LEDs, with length/LED-count check
```

## Roadmap

- [ ] Interactive 2D curve editor (draw / drag control points, open/closed)
- [ ] Pipe profile & plane placement UI
- [ ] Loft tool: pick guide curves, choose material
- [ ] Light tool: draw 3D curve on the structure, choose string (5 m / 10 m) and colour
- [ ] Bill of materials: pipe lengths, loft area, LED strings needed
- [ ] Save / load projects (JSON), export (glTF / STL)
- [ ] Undo / redo

## Open questions

- Square pipe assumed to be 15×15 mm — confirm exact profile.
- 5 m and 10 m strings both have 80 LEDs at 50 mm pitch (= 4 m lit length);
  confirm whether the 10 m string uses a wider pitch or has a longer lead cable.
