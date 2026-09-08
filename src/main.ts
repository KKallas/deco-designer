import './style.css';
import { Store } from './app/store';
import { demoProject } from './model/defaults';
import * as types from './model/types';
import { migrateProject, type Project } from './model/types';
import { activeCameraOf } from './model/camera';
import * as cmd from './app/commands';
import * as examples from './app/examples';
import { describeCurve, overview } from './app/overview';
import { installBridge } from './app/bridge';
import { archiveItem, exportProject, itemFileName } from './app/archive';
import { downloadItem } from './app/archive-folder';
import { ArchiveBrowser } from './ui/archive';
import { loadAutosave, saveAutosave } from './app/autosave';
import { NO_SELECTION } from './app/store';
import { Viewer } from './view3d/viewer';
import { Panel } from './ui/panel';
import { setScrubHooks } from './ui/scrub';
import { Topbar } from './ui/topbar';
import { hostChannel, openMaterialsPage, openShapesPage } from './app/channel';
import { btn, el, numField, selectField } from './ui/dom';
import { PLANE_PRESETS, type PlanePreset } from './model/types';
import { ViewRail } from './ui/viewbar';
import { RailPrefs, renderRail, type RailItem } from './ui/rails';
import { deleteSelectionAsked, projectSelectionAsked } from './ui/confirm';
import { isImageMime, textureFromFile } from './materials/textures';

async function loadProject(): Promise<Project> {
  try {
    const raw = await loadAutosave();
    if (raw) {
      const p = migrateProject(raw);
      if (p) return p;
    }
  } catch { /* ignore */ }
  return demoProject();
}

const store = new Store(await loadProject());
const viewport = document.getElementById('viewport')!;

let viewer: Viewer | null = null;
try {
  viewer = await Viewer.create(viewport, store);
} catch (e) {
  console.error(e);
  viewport.append(el('div', { class: 'hint', style: 'padding:12px' }, `3D viewport unavailable: ${e instanceof Error ? e.message : String(e)}`));
}

// the two toolbar rails (docs/23-toolbar-rails.md): one width and one display mode for both,
// dragged on the grip — left = what to add, the gizmo and the tools on the selection
const railPrefs = new RailPrefs();
const rail = el('div', { class: 'rail left' });
/** the preset the rail's ▤ button uses for a new plane (its ▾ picks another) */
let planePreset: PlanePreset = 'front';
let presetOpen = false;
// right rail: framing, the selection filter (docs/08) and the render view; the selection text
// floats at the top-left — docs/20-viewport-status-bar.md, docs/23-toolbar-rails.md
const viewBar = new ViewRail(store, () => viewer, {
  enabled: () => store.project.post.enabled,
  toggle: () => cmd.setPost(store, { enabled: !store.project.post.enabled }),
  edit: () => cmd.enterPostEdit(store),
}, railPrefs);
railPrefs.onChange(() => renderViewportUi());
// view tools under the navigation cube: one ▾ button opening the camera looked through and
// perspective / orthographic — docs/15-camera.md, docs/21-navcube-drag.md, docs/36-camera-world.md
const viewTools = el('div', { class: 'view-tools' });
let viewToolsOpen = false;
/**
 * A new camera from the current view (docs/36 §1): where the view is now, a copy of the world of the camera being
 * left, the default lens — looked through and selected, so its properties are what the viewport uses from here on.
 */
function newCameraFromView(): void {
  const v = viewer?.viewInfo();
  const leaving = activeCameraOf(store.project);
  store.batch(() => {
    const id = cmd.addCamera(store, { name: `Camera ${store.project.cameras.length + 1}`, pose: v ? { position: v.position, target: v.target } : undefined, world: leaving.world });
    cmd.setActiveCamera(store, id);
    cmd.selectCamera(store, id);
  });
}
// the object archive (docs/33-object-archive.md §8): ⤓ Archive saves the selected object as an item, ▦ Insert browses the folder
let archiveOpen = false;
const archive = new ArchiveBrowser({
  insert: (raw, name) => {
    const into = store.selection.groups.length === 1 ? store.selection.groups[0] : null;
    const id = cmd.importItem(store, raw, { into });
    if (!id) { alert(`${name} is not an archive item (a project file with an object in it)`); return; }
    topbar.setStatus(`${name} brought in${into ? ' into the selected object' : ''}`);
  },
  status: (text) => topbar.setStatus(text),
});
async function saveSelectedToArchive(): Promise<void> {
  const { groups } = store.selection;
  if (groups.length !== 1) { alert('Select one object to save it as an archive item.'); return; }
  const id = groups[0];
  const thumbnail = viewer?.renderThumbnail(id) ?? null;
  const item = archiveItem(store.project, id, { thumbnail });
  if (!item) return;
  const folder = archive.current;
  try {
    if (folder?.writable && await folder.permitted()) {
      const file = await folder.write(item);
      topbar.setStatus(`${file} saved to ${folder.name}`);
      void archive.refresh();
    } else {
      downloadItem(item);
      topbar.setStatus(`${itemFileName(item)} downloaded — pick an archive folder under ▦ Insert to save there instead`);
    }
  } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
}
// the plane tools' bar (docs/29-offset-trim-fillet.md): the tool, its number and a hint, under the label
const toolBar = el('div', { class: 'view-tool' });
toolBar.hidden = true;
viewport.append(viewBar.label, rail, viewBar.root, viewTools, toolBar);
function renderToolBar(): void {
  const tool = viewer?.planeTool ?? null;
  toolBar.hidden = !tool || !viewer;
  if (!tool || !viewer) return;
  toolBar.style.left = `${railPrefs.width + 18}px`;
  const v = viewer;
  const hint = tool === 'offset' ? 'drag from a curve to the side you want (Shift = no snap), or click it for d'
    : tool === 'trim' ? 'click the piece of a curve to remove — between its crossings with the other curves on the plane'
    : v.filletFirst ? 'now click the second open curve' : 'click a corner to round it with r, or two open curves to join them at their corner';
  toolBar.replaceChildren(
    el('b', {}, tool === 'offset' ? '⇉ Offset' : tool === 'trim' ? '✂ Trim' : '⌒ Fillet'),
    ...(tool === 'offset' ? [numField('d', v.toolValues.offset, (x) => v.setToolValue('offset', x), { step: 5, title: 'Distance in mm: + outwards on a closed curve, the left of travel on an open one; a drag writes what it used back here' }), el('span', { class: 'dim' }, 'mm')] : []),
    ...(tool === 'fillet' ? [numField('r', v.toolValues.fillet, (x) => v.setToolValue('fillet', x), { step: 5, min: 0, title: 'Radius in mm — starts at the profile\'s minimum bend radius; 0 joins two curves with a sharp corner' }), el('span', { class: 'dim' }, 'mm')] : []),
    el('span', { class: 'dim hint' }, hint),
    ...(v.toolMessage ? [el('span', { class: 'msg' }, v.toolMessage)] : []),
  );
}
function renderViewportUi(): void {
  const mode = viewer?.gizmoMode ?? 'translate';
  const editing = store.mode.kind === 'edit';
  const adding = editing && viewer?.editTool === 'add';
  const modes: { m: 'translate' | 'rotate' | 'scale'; label: string; name: string; title: string }[] = [
    { m: 'translate', label: '✥', name: 'Move', title: 'Move (W)' }, { m: 'rotate', label: '↻', name: 'Rotate', title: 'Rotate (E)' }, { m: 'scale', label: '⤢', name: 'Scale', title: 'Scale (R)' },
  ];
  // Object-mode actions on the selection, in three sections (docs/28-panel-surface.md §6.1)
  const { selection } = store.state;
  const plane = store.activePlane();
  const sel = selection.curves, primary = store.primaryCurveId, cam = selection.cameraId;
  const groups = selection.groups;
  const edit: RailItem[] = editing ? [] : [
    { icon: '✎', label: 'Edit', title: 'Edit the curve (Tab)', onclick: () => { if (primary) cmd.enterEdit(store, primary); } },
    { icon: '⧉', label: 'Duplicate', title: cam ? 'Duplicate the camera (⌘D)' : groups.length ? `Duplicate the ${groups.length > 1 ? `${groups.length} objects` : 'object'} (⌘D)` : selection.planeSelected ? 'Duplicate the plane with everything on it (⌘D)' : 'Duplicate the selected curves (⌘D)', onclick: () => { if (cam) { const id = cmd.duplicateCamera(store, cam); if (id) cmd.selectCamera(store, id); } else cmd.duplicateSelection(store); } },
    { icon: '⋈', label: 'Join', title: 'Join the nearest ends of two open curves on the same plane (⌘J)', onclick: () => { if (sel.length === 2) cmd.joinEnds(store, sel[1], sel[0]); } },
  ];
  // the plane tools (docs/29-offset-trim-fillet.md): offset, trim, fillet between curves on one plane
  const tool = viewer?.planeTool ?? null;
  const modify: RailItem[] = editing ? [] : [
    { icon: '⇉', label: 'Offset', title: 'Offset (O): a parallel copy of a curve on its plane — drag from the curve to the side you want, or click it for the distance in the tool bar', onclick: () => viewer?.setPlaneTool(tool === 'offset' ? null : 'offset'), active: tool === 'offset' },
    { icon: '✂', label: 'Trim', title: 'Trim (T): click the piece of a curve to remove, between its crossings with the other curves on the plane', onclick: () => viewer?.setPlaneTool(tool === 'trim' ? null : 'trim'), active: tool === 'trim' },
    { icon: '⌒', label: 'Fillet', title: 'Fillet (L): click a corner to round it with the radius in the tool bar, or two open curves to join them at their corner and round it', onclick: () => viewer?.setPlaneTool(tool === 'fillet' ? null : 'fillet'), active: tool === 'fillet' },
    // project onto another plane (docs/34-project.md): the selection, a popup for the plane, new curves there
    { icon: '⇩', label: 'Project', title: sel.length ? `Project (P): the selected curve${sel.length > 1 ? 's' : ''} onto another plane — a popup asks which; each lands there as a new planar curve, its shadow along the plane's normal` : 'Project (P): select a curve first, then pick the plane to project it onto', onclick: () => projectSelectionAsked(store) },
  ];
  // surfaces: between two curves, or filling one (docs/28-panel-surface.md)
  const surface: RailItem[] = editing ? [] : [
    { icon: '◫', label: 'Loft', title: 'Loft a surface between two selected curves (⌘L)', onclick: () => { if (sel.length === 2) cmd.addLoft(store, sel[0], sel[1]); } },
    { icon: '▱', label: 'Shape', title: sel.length > 1 ? `A shape over the ${sel.length} selected curves — a sheet filling their outlines (a curve inside another is a hole), fill layers added in the panel` : 'Shape from the selected curve: a sheet filling its outline (an open curve is closed by a straight chord) — add a net or bubbles as layers in the panel', onclick: () => { if (sel.length) cmd.addShape(store, sel); } },
  ];
  const object: RailItem[] = editing ? [] : [
    { icon: '▣', label: 'Group', title: 'Group: make an object from the selected objects, the selected plane, or the plane of the selected curves (⌘G)', onclick: () => cmd.groupSelection(store) },
    { icon: '⤓', label: 'Archive', title: groups.length === 1 ? 'Save the selected object to the archive folder as an item — a project file of its own, with only what it uses' : 'Select one object to save it to the archive', onclick: () => { void saveSelectedToArchive(); } },
    { icon: '▦', label: 'Insert', title: `Bring an object in from the archive folder${groups.length === 1 ? ' into the selected object' : ''}`, onclick: () => { archiveOpen = !archiveOpen; renderViewportUi(); }, active: archiveOpen, menu: { open: archiveOpen, title: 'Browse the archive', toggle: () => { archiveOpen = !archiveOpen; renderViewportUi(); }, pop: () => archive.root } },
    { icon: '✕', label: 'Delete', title: cam ? 'Delete the camera' : groups.length ? 'Delete the object with everything in it' : 'Delete the selection', class: 'danger', onclick: () => { if (cam) cmd.removeCamera(store, cam); else deleteSelectionAsked(store); } },
  ];
  // what to add: a plane (▾ picks front / top / side), a curve on the active plane, a camera from this view
  const add: RailItem[] = [
    {
      icon: '▤', label: 'Plane', title: `Add a plane · ${PLANE_PRESETS[planePreset].label} — ▾ picks another`, onclick: () => cmd.addPlane(store, planePreset),
      menu: {
        open: presetOpen, title: 'Which way a new plane faces',
        toggle: () => { presetOpen = !presetOpen; renderViewportUi(); },
        pop: () => el('div', { class: 'pop' }, ...(Object.keys(PLANE_PRESETS) as PlanePreset[]).map((x) => btn(PLANE_PRESETS[x].label, () => { planePreset = x; presetOpen = false; cmd.addPlane(store, x); }, { active: x === planePreset }))),
      },
    },
    { icon: '○', label: 'Curve', class: 'primary', title: plane ? `Add a curve on plane "${plane.name}" and edit it` : 'Add a curve (creates a plane first)', onclick: () => cmd.addCurve(store, plane?.id ?? null, planePreset) },
    { icon: '◉', label: 'Camera', title: 'A new camera from the current view (50 mm on full frame, the world of the camera you leave), looked through — its properties show in the panel', onclick: newCameraFromView },
  ];
  const gizmo: RailItem[] = [
    ...modes.map((x) => ({ icon: x.label, label: x.name, title: x.title, onclick: () => viewer?.setGizmoMode(x.m), active: !adding && mode === x.m })),
    // Edit mode only: the add-points tool — click on the plane appends a vertex, click on the curve inserts one
    ...(editing ? [{ icon: '+', label: 'Add points', title: 'Add points (A): click the plane to append, the curve to insert', onclick: () => viewer?.setEditTool('add'), active: adding }] : []),
    // Object mode only: the focus tool — a click on geometry sets the depth-of-field focus there (docs/15-camera.md)
    ...(!editing ? [{ icon: '◎', label: 'Focus', title: 'Focus point: click on any geometry to focus the depth of field there (switches DOF on; W / E / R leave the tool)', onclick: () => viewer?.setFocusTool(!viewer.focusTool), active: !!viewer?.focusTool }] : []),
  ];
  renderRail(rail, [
    { key: 'add', label: 'Add', items: add },
    { key: 'gizmo', label: 'Gizmo', items: gizmo },
    { key: 'edit', label: 'Edit', items: edit },
    { key: 'modify', label: 'Modify', items: modify },
    { key: 'surface', label: 'Surface', items: surface },
    { key: 'object', label: 'Object', items: object },
  ], railPrefs, 'left');
  viewBar.render();
  // the view always looks through a camera (docs/36): pick one, or leave the current one by making a new one from the view
  const { cameras } = store.project;
  const activeCamera = activeCameraOf(store.project).id;
  const cameraSel = selectField(activeCamera, [
    ...cameras.map((c) => ({ value: c.id, label: `${c.name} · ${c.focalLength} mm`, group: 'Cameras' })),
    { value: '+', label: '+ New camera from this view' },
  ], (v) => { if (v === '+') newCameraFromView(); else cmd.setActiveCamera(store, v); }, { title: 'Look through a camera object (its lens, frame, depth of field and world; the view moves it) — to leave one where it stands, make a new camera from this view' });
  const projSel = selectField(viewer?.projection ?? 'perspective', [{ value: 'perspective', label: 'Perspective' }, { value: 'orthographic', label: 'Orthographic' }], (v) => viewer?.setProjection(v as 'perspective' | 'orthographic'), { title: 'Projection of the view (not saved): orthographic leaves the camera\'s pose alone and switches its frame and depth of field off; perspective returns to the camera' });
  projSel.disabled = editing;
  // the navigation cube keeps clear of the right rail (docs/23 §4)
  if (viewer) viewer.navcube.rightInset = railPrefs.width + 18;
  const cube = viewer?.navcube.rect(viewport.clientWidth);
  // the ▾ sits centred under the cube; the popup hangs from the cube's right edge
  if (cube) { viewTools.style.top = `${cube.y + cube.h + 4}px`; viewTools.style.left = `${cube.x}px`; viewTools.style.width = `${cube.w}px`; }
  viewTools.replaceChildren(
    btn('▾', () => { viewToolsOpen = !viewToolsOpen; renderViewportUi(); }, { title: `View: the camera looked through and the projection (${activeCameraOf(store.project).name} · ${viewer?.projection ?? 'perspective'})`, active: viewToolsOpen }),
    ...(viewToolsOpen ? [el('div', { class: 'pop' }, cameraSel, projSel)] : []),
  );
  viewTools.hidden = editing;
  if (editing) viewToolsOpen = false;
  renderToolBar();
}
// drop an image file on the viewport: it becomes the active plane's reference image (docs/19-reference-image.md)
viewport.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
viewport.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  // a .json is an archive item (docs/33-object-archive.md §8): it comes in under the selected object
  if (/\.json$/i.test(file.name)) {
    file.text()
      .then((text) => {
        const into = store.selection.groups.length === 1 ? store.selection.groups[0] : null;
        const id = cmd.importItem(store, JSON.parse(text), { into });
        if (!id) throw new Error(`${file.name} is not an archive item (a project file with an object in it)`);
        topbar.setStatus(`${file.name} brought in`);
      })
      .catch((err) => alert(err instanceof Error ? err.message : String(err)));
    return;
  }
  const plane = store.activePlane();
  if (!plane) { alert('Select a plane first — the image goes on it.'); return; }
  textureFromFile(file)
    .then((t) => {
      if (!isImageMime(t.mime) || t.mime.includes('radiance') || t.mime.includes('exr')) throw new Error(`${file.name} is not an image the plane can show`);
      return store.transaction(() => cmd.setPlaneImage(store, plane.id, { texture: cmd.addTexture(store, t) }));
    })
    .catch((err) => alert(err instanceof Error ? err.message : String(err)));
});

// the view popup closes on a click anywhere else and on Escape
window.addEventListener('pointerdown', (e) => {
  const inside = (host: HTMLElement) => e.target instanceof Node && host.contains(e.target);
  const closeTools = viewToolsOpen && !inside(viewTools);
  const closePreset = presetOpen && !inside(rail);
  const closeArchive = archiveOpen && !inside(rail);
  if (!closeTools && !closePreset && !closeArchive) return;
  if (closeTools) viewToolsOpen = false;
  if (closePreset) presetOpen = false;
  if (closeArchive) archiveOpen = false;
  renderViewportUi();
}, true);
// Escape closes the popup and stops there — it must not also deselect (the viewer listens on window too)
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || (!viewToolsOpen && !presetOpen && !archiveOpen)) return;
  e.stopPropagation();
  viewToolsOpen = presetOpen = archiveOpen = false;
  renderViewportUi();
}, true);

if (viewer) { viewer.onUiChange = renderViewportUi; viewer.onToolChange = renderToolBar; }
renderViewportUi();

// materials / shapes pages (docs/13-material-editor.md, docs/14-shapes.md): own tabs opened from the dropdowns; they mirror this store over a BroadcastChannel
hostChannel(store, viewer ? { view: () => ({ ...viewer!.viewInfo(), postError: viewer!.postError }), setView: (p, t) => viewer!.setView(p, t), fit: () => viewer!.fit(), selectionDistance: () => viewer!.selectionDistance() } : null);
const panel = new Panel(document.getElementById('panel')!, store, openMaterialsPage, openShapesPage, { preview: (draft) => viewer?.setPostPreview(draft) ?? null, view: () => viewer?.viewInfo() ?? null, selectionDistance: () => viewer?.selectionDistance() ?? null, fit: () => viewer?.fit(), lamps: (id, layer) => viewer?.lampCount(id, layer) ?? 0, calibrateImage: (planeId) => viewer?.startImageCalibration(planeId), seconds: () => viewer?.playbackSeconds ?? 0 });
// dragging a number field (docs/25-number-fields.md) is one live edit: no undo step per pixel, no rebuild under the pointer
setScrubHooks({ begin: () => store.beginLive(), end: () => { store.endLive(); panel.render(); } });
const topbar = new Topbar(document.getElementById('topbar')!, store, { seconds: () => viewer?.playbackSeconds ?? 0, set: (t) => viewer?.setPlaybackSeconds(t), fps: () => viewer?.renderFps ?? 0 }, { export: exportFile, import: importFile });
topbar.setStatus(viewer?.backendName ?? 'no 3D');

/** Topbar ⤓ Export (docs/33 §13): the whole file as one archive item, downloaded as `<project>.deco.json`. */
function exportFile(): void {
  const item = exportProject(store.project, { thumbnail: viewer?.renderThumbnail(null) ?? null });
  if (!item) { alert('Nothing to export — the project has no planes or objects.'); return; }
  const name = downloadItem(item);
  topbar.setStatus(`${name} exported — one object "${item.groups[0]?.name ?? item.name}" for Import / ▦ Insert`);
}

/** Topbar ⤒ Import: an exported file (or any archive item) into this work, under the selected object or at the origin. */
function importFile(): void {
  const input = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    file.text()
      .then((text) => {
        const into = store.selection.groups.length === 1 ? store.selection.groups[0] : null;
        const id = cmd.importItem(store, JSON.parse(text), { into });
        if (!id) throw new Error(`${file.name} is not an archive item (a project file with an object in it)`);
        topbar.setStatus(`${file.name} imported${into ? ' into the selected object' : ''}`);
      })
      .catch((err) => alert(err instanceof Error ? err.message : String(err)));
  };
  input.click();
}

store.subscribe(() => {
  saveAutosave(store.project);
  viewer?.sync();
  renderViewportUi();
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
  if (e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); }
});

// agent bridge (dev server): `node scripts/deco.mjs overview | exec '<js>'` — see docs/07-agent-bridge.md
function setProject(raw: unknown): string {
  const p = migrateProject(raw);
  if (!p) throw new Error('not a project (need version 4 or 5 with profiles / planes / curves)');
  store.update((s) => { s.project = p; s.mode = { kind: 'object' }; s.selection = { ...NO_SELECTION }; });
  viewer?.fit();
  return overview(store);
}
const HELP = `Names in scope for exec:
  store            the Store (state, evals, undo/redo, transaction)
  project          store.project (live)
  cmd.*            every mutation — src/app/commands.ts (addPlane, addCurve, addVertex, addLoft, addGroup, setPlanePlacement, …)
  examples.*       builders — src/app/examples.ts (buildPost)
  types.*          model helpers — src/model/types.ts (vertex, emptyProject, placementFor, findCurve, …)
  overview()       one-screen tree of the project · curve(id) vertices/constraints/violations of one curve
  setProject(p)    replace the project (JSON) · demo() load the demo · fit() fit the view · help()
  archive.item(groupId, { images, tags })   the object as an archive item (a one-object project + thumbnail) — docs/33
  archive.insert(item, { into })            bring an item in → { root, overview } · archive.overview(item) its own tree
  archive.export()                          the whole file as one item (topbar Export: loose planes / objects wrapped in one object) — docs/33 §13
An expression returns its value; a statement body may use return / await. One exec = one undo step.`;
const api = {
  store, cmd, examples, types, viewer, panel,
  get project() { return store.project; },
  overview: () => overview(store),
  curve: (id: string) => describeCurve(store, id),
  setProject, demo: () => setProject(demoProject()), fit: () => viewer?.fit(), help: () => HELP,
  archive: {
    item: (groupId: string, opts: { images?: boolean; tags?: string[]; notes?: string } = {}) => archiveItem(store.project, groupId, { ...opts, thumbnail: viewer?.renderThumbnail(groupId) ?? null }),
    insert: (raw: unknown, opts: { into?: string | null } = {}) => { const root = cmd.importItem(store, raw, opts); return root ? { root, overview: overview(store) } : null; },
    overview: (raw: unknown) => { const p = migrateProject(raw); return p ? overview(new Store(p)) : null; },
    export: (opts: { images?: boolean; tags?: string[]; notes?: string } = {}) => exportProject(store.project, { thumbnail: viewer?.renderThumbnail(null) ?? null, ...opts }),
  },
};
installBridge(api);
(window as unknown as { deco: typeof api }).deco = api;
viewer?.fit();
