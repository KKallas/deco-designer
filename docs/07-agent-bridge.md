# Part 7 — Agent bridge: overview and direct manipulation

Status: **built 2026-08-25**. Builds on Parts 1–6.

## 1. What it is
An agent (Claude Code in the terminal, or any script) can **see** the document
that is open in the browser and **change it directly** — no GUI buttons. The
store + commands the UI uses (`src/app/store.ts`, `src/app/commands.ts`) are
the API; the bridge just runs the agent's code inside the page.

```
node scripts/deco.mjs overview        # one-screen tree of the open project
node scripts/deco.mjs curve <id>      # vertices (ids, handles), constraints, violations
node scripts/deco.mjs exec '<js>'     # run code in the page, print its value (or a file / stdin)
node scripts/deco.mjs project         # full JSON   ·   load <file.json> replaces it
node scripts/deco.mjs render out.png [width]   # a still of the camera frame through the post script (docs/32)
node scripts/deco.mjs help            # names in scope for exec
```

Overview format — objects ▣, planes ▤, curves ○, lofts ◇, ids in brackets:
```
Project "Demo" · 4 planes · 5 curves · 1 lofts · 1 objects · OBJECT mode · selected: nothing
Profiles: flat25x2 25×2 flat (R ≥ 15, ≤ 6000 mm) · round15 Ø15×1.5 (R ≥ 45, ≤ 6000 mm)
▣ Arch gate [gate]
  ▤ Front [front] · front @ (0, 0, 0)
    ○ Arch [arch] · round15 · 7 pts open · 2338 mm · x -600..600 y 0..950 · ok
    ○ Heart [heart] · flat25x2 · 16 pts closed · 1467 mm · x -224..224 y 176..574 · ✗ R 9 mm < 15 mm
  ◇ Garland [garland] · arch ↔ back-arch · res 2 · strips 4
▤ Flower [flower] · top @ (1100, 0, 0) · circular ×6 360° @ (0, 0)
```

## 2. How it works
- **`vite.config.ts` plugin** (dev server only): `GET /__deco/overview|project|help`,
  `POST /__deco/exec` (body = JavaScript). The request is forwarded over the HMR
  websocket to **one tab — the first that answers a ping** (only the designer page installs the bridge; a second page such as `materials.html` is never targeted, and a mutation never runs twice) and
  the JSON result comes back; 503 if no tab is open, 422 if the code threw.
- **`src/app/bridge.ts`** (page side): compiles the code with the API names in
  scope — as an expression, or as an async statement body (`return` / `await`)
  — and runs it in **one `store.transaction()`** → one undo step (`⌘Z` in the
  UI reverts a whole agent call).
- **`src/app/overview.ts`**: `overview(store)` and `describeCurve(store, id)`, pure text.
- Names in scope: `store`, `project`, `cmd.*`, `examples.*`, `types.*`, `viewer`,
  `overview()`, `curve(id)`, `setProject(p)`, `demo()`, `fit()`, `help()`.
- The same API works headlessly in Node (`three/webgpu` loads without a DOM):
  `npm test` runs [tests/post.test.ts](../tests/post.test.ts), which builds the
  **400 × 400 × 3000 mm post** example (`examples.buildPost`: four planes, twelve
  straight Ø15 tube edges, four lofted side walls, one object) and checks model,
  world-space box, limitation checks, tube / loft geometry, save-load and undo.

## 3. Out of scope
Auth / remote access (localhost dev server only) · production build (the bridge
is stripped) · a stable versioned API · watching the document for changes.
