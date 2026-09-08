# Part 33 — The object archive

Status: **built 2026-09-05** (asked for as "I need to develop object archive,
that I can give it a folder and can bring in these items from archive, and
thinking what is the best way to save the files"; specified the same day, the
spec was accepted with "implement it"). Builds on Part 18 (nested objects),
Part 30 (outline and shape layers), Part 7 (the bridge). Decisions taken
without a round of questions are in §10 — the four open questions of the spec
were settled by defaults, listed in §11; one word and any of them changes.

## 1. What it is
An **archive** is an ordinary folder on disk holding **items**. An item is one
object — a decoration, a post, a bracket — with everything under it, saved as a
file of its own. Bringing an item in copies it into the open project, under the
selected object or at the world origin, in one undo step. Nothing links back:
an item is a copy the moment it lands, and the project never depends on the
folder still being there.

There is no database, no index file and no server. A folder is the archive; a
file is an item; deleting the file removes it; copying the folder to a stick
moves the archive.

## 2. An item file is a project
The item file is a **valid `Project`** (src/model/types.ts) whose `groups`
contain exactly one root object. Not a new schema — that is the whole point:

- `migrateProject` (src/model/types.ts:819) already carries a version-4 file to
  the current 17 and will carry a 17 to whatever comes next. A second format
  would need a second ladder, forever.
- Every item is **openable on its own**: `node scripts/deco.mjs load
  chelsy-250.deco.json` works the day the writer exists, before any importer.
- The autosave, the checks, the bridge and the tests all already speak it.

```jsonc
{
  "version": 17,
  "name": "Chelsy 250",
  "item": {                        // the only addition; every other reader ignores it
    "root": "chelsy-250",          // the object to bring in
    "thumbnail": "data:image/png;base64,…",   // 512 px, square, transparent
    "tags": ["decoration", "250"],
    "created": "2026-09-05T09:12:00Z",
    "app": "deco-designer",
    "notes": ""
  },
  "profiles": [ /* only the ones referenced */ ],
  "fills": [], "materials": [], "textures": [], "animations": [],
  "planes": [ /* the object's planes */ ],
  "curves": [], "lofts": [], "shapes": [],
  "groups": [ /* the root and its children, nothing else */ ],
  "cameras": [ /* Camera 1, the default (docs/36) */ ], "activeCamera": "camera-1",
  "post": /* default */, "playback": /* default */
}
```

**The closure.** Only what the object actually references travels: the profiles
of its outline layers, the fills of its shape layers, the materials named by
any layer or loft, the textures those materials sample, the animations its
fixtures are patched to and *their* textures. A project's other 40 profiles
stay behind. `migrateProject` refuses a file with an empty `profiles`, so an
object of nothing but construction lines still ships one profile (the first of
the source project).

**Left at defaults**: `cameras` (the one default camera carrying the default world), `activeCamera`, `post`, `playback` —
an item is geometry and its materials, not a scene. They are written as
defaults so the file opens sanely on its own, and are **ignored on insert**.

**`item.root` is the contract.** A file with no `item` block, or one naming a
missing object, still inserts: the importer takes the only root object, or the
first if there are several.

## 3. The folder
```
archive/
  chelsy-250.deco.json     the item
  chelsy-250.png           its thumbnail, same basename
  nolita-250.deco.json
  nolita-250.png
  brackets/                subfolders are groups; one level is browsed, deeper is listed
    corner-90.deco.json
```
The `.png` is a sidecar copy of `item.thumbnail` for the Finder and other
tools. The browser grid reads the JSON files (an item is tens of kB — the one
above with a 400 × 320 animation map is 145 kB) and takes the embedded
thumbnail, the sidecar when a file has none, and shows a name when there is
neither.

Reference images (docs/19) are **left out by default** — they are tracing
scaffolding, they are the only megabyte-sized thing in a project, and an item
with three of them is 4 MB instead of 40 kB. `--images` keeps them.

## 4. Saving an item
`archiveItem(project, groupId, opts): Project` in a new **src/app/archive.ts**,
pure and testable in Node:

1. `subtreeGroups` → the root and its children; `subtreePlanes` → their planes;
   the curves on those planes; `loftsOfGroup` / `shapesOfGroup` for the rest
   (the same four helpers `duplicateGroup` uses).
2. Walk them for asset ids and copy the closure of §2.
3. The root's `placement` is **zeroed** (position, rotation) so an item lands
   where it is put, not where it happened to sit; the children keep theirs.
4. `name` = the object's name; `item` is filled in; `version` stays current.

The thumbnail is the one part that needs the viewer:
`viewer.renderThumbnail(groupId, 512)` — the object's world bounding box (the
built meshes, or the curve vertices of a hidden object), the perspective camera
moved to look at it from front-right-above (30° lens, the box's sphere filling
the frame), every other mesh, the helpers, floor and gizmo hidden, one plain
`render` at 512 × 512 px 1:1 (no post script — a 512 px bloom pass buys
nothing), the world background kept, then everything restored and a frame
asked for. Same save / restore discipline as `renderStill` (docs/32 §2).

## 5. Bringing one in
`cmd.importItem(store, file: unknown, opts: { into?: Id })` — one command, one
undo step, over the pure `insertItem(project, file, opts)` in src/app/archive.ts:

1. `migrateProject(file)` → a project at the current version, or a clear
   refusal. An item saved by any earlier part comes in.
2. **Merge the assets** (profiles, fills, materials, textures, animations),
   each by id:
   - the id is free → add as is;
   - the id is taken and the content is **identical** (deep equal, ignoring
     `name` / `label` / `source`) → **reuse the project's**, so importing three
     decorations that all use `round15` leaves one `round15`;
   - the id is taken and the content **differs** → add under a fresh id
     (`round15-2`) and rewrite this item's references to it.

   Never edit an asset the project already has: an import must not change how
   anything already in the scene looks.
3. **Copy the subtree** exactly as `duplicateGroup` does — groups, planes,
   curves (with constraints and outline layers), lofts, shapes — remapping
   every id against the target project.
4. Parent the root to `opts.into` (else it is a root object), place it at the
   origin of its parent (the root's placement is zeroed whatever the file
   says), select it, name-clash it to `Chelsy 250 2` if needed. A file with no
   `item` block — a plain one-object project — inserts too; one with no object
   at all is refused.
5. Untouched: the project's cameras (and their worlds), post, playback, active camera.

## 6. One insert, two callers
`duplicateGroup` (src/app/commands.ts:329) is already 90 % of this: it walks a
subtree and remaps group / plane / curve / loft / shape ids. The difference is
only where the subtree is read from. So:

```ts
// src/app/insert.ts
export function insertGroup(target: Project, source: Project, groupId: Id,
                            opts: { into?: Id | null; offset?: Partial<Vec3>; name?: string }): InsertResult | null
// InsertResult = { root, groups, planes, curves }: the new ids, old → new
```

It works on a `Project`, not the store, so it runs in Node too. `duplicateGroup`
is now `insertGroup(s.project, s.project, id, { into: parent, offset: { x: 200 },
name: \`${name} copy\` })` plus the selection; `insertItem` calls it with the
item's project after the asset merge. One code path — the import route is
exercised by every ⌘D.

## 7. The bridge
Node has the filesystem, the page has the project, so each command is a file
read/write around one `exec` (docs/07). The folder is `$DECO_ARCHIVE`, else
`./archive`, else the path given last:

```
node scripts/deco.mjs archive ls [dir]                              name · tags · size · when · file
node scripts/deco.mjs archive save <groupId> [dir] [--images] [--tags a,b]   writes <slug>.deco.json + .png
node scripts/deco.mjs archive add <name|file> [dir] [--into <groupId>]       → the new object id + overview
node scripts/deco.mjs archive show <name|file> [dir]                the item's own overview()
```
`<name>` is the item's name, its file's basename or a path. In `exec`,
`archive.item(groupId, { images, tags })`, `archive.insert(json, { into })`
(→ `{ root, overview }`) and `archive.overview(json)` are in scope, so an
agent can do it in one call without the CLI.

## 8. The UI
- **Left rail, Object section** (docs/23): `⤓ Archive` saves the selected
  object; `▦ Archive…` is a rail *menu* item whose popup is the browser — a
  thumbnail grid, a filter box over names and tags, click to insert into the
  selection. The rail already supports popups (`RailSection.items[].menu`).
- **The folder** is chosen once with `showDirectoryPicker()` and the handle
  kept in IndexedDB beside the autosave (src/app/autosave.ts — the database
  went from version 1 to 2 for a `settings` store), so it survives a reload;
  after one the browser asks once more (*Allow access to …* in the popup).
  Chrome and Edge have the API; **Safari and Firefox do not** — that is
  feature-detected, not asked: there *Open…* reads a folder for the session
  (`<input webkitdirectory>`, read only) and ⤓ Archive downloads the file.
  src/app/archive-folder.ts is both behind one `ArchiveFolder` interface;
  src/ui/archive.ts is the popup.
- **Drop** a `.json` on the viewport → insert it under the selected object
  (the same drop that puts an image on a plane branches on the extension).

## 9. Checking it
tests/archive.test.ts (Node, no browser — `archiveItem` and `insertItem` are
pure over a `Project`):
- round trip: `insertItem(empty, archiveItem(p, 'chelsy-250'))` gives an object
  whose curves, layers, profile ids and world positions match the source's.
- closure: an item of an object using one of five profiles carries one.
- dedupe: inserting the same item twice adds no second `round15`; inserting an
  item whose `round15` differs adds `round15-2` and leaves the first alone.
- collision: an item whose ids all clash with the target's still inserts, and
  nothing in the target moves or changes look.
- migration: a version-16 file with no `item` block inserts (it goes through
  `migrateProject`); a file with no object, or no project, is refused.
- ⌘D still duplicates: name `… copy`, +200 mm, lofts and shapes along.

Live, through the bridge on the open Demo (2026-09-05): a plane with an LED
string patched to the `grad` map grouped, `archive save` → a 145 kB item + a
15 kB thumbnail of the string alone; `archive add` → `object-2-2` with the
fixture still on `grad`, and the project's 3 animations / 4 textures / 6
profiles unchanged (the closure was reused, not duplicated).

## 10. Decisions (taken autonomously — say if you want them otherwise)
1. **An item is a project**, not a bespoke schema, for the migration ladder.
2. **One file per item, flat folder**, textures embedded as the data URLs they
   already are — no zip, no folder-per-item. Revisit if HDRs land in items.
3. **Reference images are dropped** on save unless asked for.
4. **Copies, never links**: an item never references another item.
5. **The root's placement is zeroed** on save; children keep theirs.
6. **Identical assets are reused, differing ones are renamed** — an import
   never changes an object already in the scene.
7. `.deco.json`, thumbnail 512 px square PNG beside it.
8. Insert lands at the parent's origin, not at the cursor or the view centre.
9. **The thumbnail keeps the world background and skips the post script** —
   the object alone, lit as in the viewport, no bloom.
10. **The grid parses the item files**; the `.png` sidecar is for the Finder
    and a fallback, not the grid's source.
11. **Feature detection, not a browser question**: the persistent folder where
    `showDirectoryPicker` exists, a per-session read-only folder elsewhere.
12. **The bridge's default folder is `./archive`** (`$DECO_ARCHIVE` overrides,
    an argument wins); the GUI has none until one is picked.
13. **A listed file must end in `.deco.json`**; a drop accepts any `.json` and
    tries it as an item.

## 11. The spec's open questions, as settled
1. **Default folder**: none in the GUI until picked; `./archive` for the bridge
   (decision 12). A fixed `~/Decolight/archive` is a one-line change.
2. **Which browser**: not asked — feature-detected (decision 11).
3. **Versions**: saving an item with the same name **overwrites** its file.
4. **A `.glb` / `.py` sidecar**: its own part (out of scope below).

## 12. Out of scope
Editing an item in place (open it, change it, save it back is enough) · nested
archives / a library server · syncing two archives · searching inside geometry ·
the material and shape libraries, which stay in localStorage (src/app/library.ts) ·
export to `.glb` / `.py`, which is its own part.

## 13. Export / Import of the working file (added 2026-09-08)
Asked for as "on top of the page where there is the working file name add
export and import buttons; the exported file can be used in insert object; if
any curves or planes are not in a group there is one more object group added
on top to enclose all the objects inserted to the next work".

- **⤓ Export** (topbar, beside the project name) saves the **whole file as one
  item**: `exportProject(project)` (src/app/archive.ts). A project with exactly
  one root object and no loose planes exports that object; otherwise a new
  object **named after the project** is added on top — in the file only, the
  open project is untouched — enclosing every root object and every plane
  outside any object, at the origin, so world positions hold. Reference
  images stay in (it is the working file), and the cameras, post script and
  clock ride along, so the file also opens on its own (`deco.mjs load`). The
  download is `<project-slug>.deco.json` with the thumbnail of everything
  inside (`viewer.renderThumbnail(null)`).
- **⤒ Import** (topbar) picks a `.json` and brings it in through the same
  `importItem` as ▦ Insert and the drop: under the selected object or at the
  origin, one undo step, cameras / post / clock of the file ignored.
- Bridge: `archive.export({ images, tags, notes })` in `exec`.
- Calls made without asking: the wrapper is added only when needed (a single
  object exports as itself, so re-exporting an imported work does not nest
  another wrapper); images and the scene are kept in an export, unlike ⤓
  Archive of one object; an empty project refuses to export.
