/**
 * Materials page (materials.html, docs/13-material-editor.md) — its own tab,
 * opened from any material dropdown in the designer. Left: the open project's
 * materials and textures (mirrored from the designer tab over a
 * BroadcastChannel, src/app/channel.ts), the browser library, the materials
 * of an opened .blend. Centre: a 3D preview (1 m box / sphere / bent tube /
 * loft / your .obj). Bottom: the picked item — name, actions, warnings,
 * textures — and its TSL code. Changes to the project are commands run in
 * the designer tab (undoable there, visible in its viewport at once).
 */
import '../style.css';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WorldRig } from '../view3d/world';
import { defaultWorld, isHdrMime } from '../model/world';
import { activeCameraOf } from '../model/camera';
import { hdrThumbnailFor } from '../materials/hdr';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { BlendFile } from '../blend/parser';
import { readMaterials, type BlendMaterial } from '../blend/shaders';
import { convertMaterial, type Converted } from '../blend/tsl';
import { buildMaterial, hostFor } from '../materials/runtime';
import { IMAGE_ACCEPT, TextureCache, textureFromBytes, textureFromFile } from '../materials/textures';
import { moveInLibrary, onLibraryChange, readLibrary, removeFromLibrary, saveToLibrary, type LibraryMaterial } from '../materials/library';
import { btn, el, numField, selectField, textField } from '../ui/dom';
import { DEFAULT_PROFILES } from '../model/defaults';
import { findAnimation, findMaterial, findTexture, newCurve, newPlane, placementFor, texturesInCode, vertex, type Animation, type Curve, type Id, type Material, type Project, type Texture, fixturesOf } from '../model/types';
import { buildShapeGeometry, shapeInput } from '../geometry/shape';
import { buildLoft } from '../geometry/loft';
import { planeMatrix } from '../geometry/placement';
import { EditorClient, PREV } from '../app/channel';
import { isScrubbing, setScrubHooks } from '../ui/scrub';

type Pick = { kind: 'material'; id: Id } | { kind: 'texture'; id: Id } | { kind: 'animation'; id: Id } | { kind: 'library'; id: string } | { kind: 'blend'; name: string } | null;
type ListKind = 'material' | 'texture' | 'animation' | 'library';
type Shape = 'box' | 'sphere' | 'tube' | 'loft' | 'obj';
const SHAPES: { value: Shape; label: string }[] = [
  { value: 'box', label: '1 m box' }, { value: 'sphere', label: '1 m sphere' }, { value: 'tube', label: 'Bent tube Ø15 (curve)' }, { value: 'loft', label: 'Loft (1 m band)' }, { value: 'obj', label: 'Custom .obj …' },
];
const PLAIN = '(tsl, host) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.color.set(0x9a9aa2); m.metalness = 0.2; m.roughness = 0.6; return m; }';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const kb = (dataUrl: string) => `${Math.round(dataUrl.length * 0.75 / 1024)} kB`;
const uses = (p: Project, id: Id) => p.curves.flatMap((c) => c.outline).filter((l) => l.materialId === id).length + p.lofts.filter((l) => l.materialId === id).length + p.shapes.flatMap((sh) => sh.layers).filter((l) => l.materialId === id).length;

// -- state ----------------------------------------------------------------------------
const client = new EditorClient('deco-materials');
const project = (): Project | null => client.state?.project ?? null;
let pick: Pick = null;
let dirty = false;
let blend: { fileName: string; version: string; materials: BlendMaterial[] } | null = null;
const drafts = new Map<string, Converted>();
const draftNames = new Map<string, string>();
/** packed images of converted drafts, decoded, by texture id */
const draftTextures = new Map<string, Texture>();
let dragging: { list: ListKind; id: string } | null = null;
let shape: Shape = 'box';
let objGroup: THREE.Group | null = null;
let objName = '';
/** what the code editor shows (to keep unapplied edits across re-renders and notice external changes) */
let codeKey = '';
let codeBase = '';
/** what the preview shows */
let previewKey = '';

const side = document.getElementById('ed-side')!;
const view = document.getElementById('ed-view')!;
const props = document.getElementById('ed-props')!;
const codePane = document.getElementById('ed-code')!;
const code = el('textarea', { class: 'code', spellcheck: false, placeholder: 'Pick a material on the left — its TSL code appears here.' });
const statusEl = el('div', { class: 'code-status' });
code.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applyEdited(); } });

function setStatus(text: string, error = false): void { statusEl.textContent = text; statusEl.className = `code-status ${error ? 'error' : ''}`; }

// -- preview ----------------------------------------------------------------------------
const scene = new THREE.Scene();
/** the designer's world — the active camera's (docs/16-world.md, docs/36) — lights the preview too */
let rig: WorldRig | null = null;
function applyWorld(): void { const p = project(); rig?.apply(p ? activeCameraOf(p).world : defaultWorld(), p?.textures ?? []); }
/** what a texture row shows: the image, or a tone-mapped thumbnail of an HDR */
const thumbUrl = (t: Texture): string => (isHdrMime(t.mime) ? hdrThumbnailFor(t) ?? '' : t.data);
const grid = new THREE.GridHelper(4000, 40, 0x2c2c31, 0x1f1f23);
grid.position.y = -600;
scene.add(grid);
const camera = new THREE.PerspectiveCamera(38, 1, 1, 100000);
camera.position.set(1300, 900, 1700);
const subject = new THREE.Group();
scene.add(subject);
let renderer: THREE.WebGPURenderer | null = null;
let controls: OrbitControls | null = null;
let material: THREE.Material = new THREE.MeshStandardMaterial({ color: 0x9a9aa2, roughness: 0.6 });
const cache = new TextureCache();

async function initPreview(): Promise<void> {
  try {
    renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
  } catch (e) {
    view.append(el('div', { class: 'hint', style: 'padding:12px' }, `3D preview unavailable: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  view.append(renderer.domElement);
  rig = new WorldRig(renderer, scene);
  applyWorld();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.zoomToCursor = true;
  const resize = () => { const w = view.clientWidth, h = view.clientHeight; if (w && h) { renderer!.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); } };
  new ResizeObserver(resize).observe(view);
  resize();
  renderer.setAnimationLoop(() => { controls!.update(); renderer!.render(scene, camera); });
}

/** Sample curve for the tube preview: an S bend, ~1.2 m of Ø15 tube. */
function sampleCurve(): Curve {
  return { points: [vertex(-500, -200), vertex(-170, 250), vertex(170, -250), vertex(500, 200)], closed: false };
}

/** Multiply a geometry's uv (0..1) into millimetres of surface. */
function uvToMm(geo: THREE.BufferGeometry, uMm: number, vMm: number): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uMm, uv.getY(i) * vMm);
  return geo;
}

function buildSubject(): { bounds: THREE.Box3 } {
  subject.clear();
  // every preview mesh has uv in mm, like curves and lofts in the designer
  if (shape === 'box') subject.add(new THREE.Mesh(uvToMm(new THREE.BoxGeometry(1000, 1000, 1000), 1000, 1000), material));
  else if (shape === 'sphere') subject.add(new THREE.Mesh(uvToMm(new THREE.SphereGeometry(500, 96, 64), Math.PI * 1000, Math.PI * 500), material));
  else if (shape === 'tube') {
    const round15 = DEFAULT_PROFILES.find((p) => p.id === 'round15')!;
    subject.add(new THREE.Mesh(buildShapeGeometry(round15.code, shapeInput({ id: 't', name: 't', curve: sampleCurve() })!, round15.params).geometry, material));
  }
  else if (shape === 'loft') {
    // a wavy band: two curves 1 m apart on parallel front planes, lofted (uv in mm → metres)
    const planeA = newPlane('A', placementFor('front', { x: 0, y: 0, z: 0 }), []);
    const planeB = newPlane('B', placementFor('front', { x: 0, y: 0, z: -1000 }), ['a']);
    const a = newCurve('a', planeA.id, 'round15', []); a.curve = { points: [vertex(-500, -250), vertex(-170, -80), vertex(170, -320), vertex(500, -150)], closed: false };
    const b = newCurve('b', planeB.id, 'round15', ['a']); b.curve = { points: [vertex(-500, 250), vertex(-170, 380), vertex(170, 120), vertex(500, 300)], closed: false };
    const built = buildLoft({ id: 'l', name: 'l', a: a.id, b: b.id, resolution: 8, strips: 8, flip: false, materialId: null }, a, b, planeMatrix(planeA.placement), planeMatrix(planeB.placement))!;
    built.mesh.material = material;
    subject.add(built.mesh);
  } else if (shape === 'obj' && objGroup) {
    objGroup.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material; });
    subject.add(objGroup);
  }
  const bounds = new THREE.Box3().setFromObject(subject);
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-500, -500, -500), new THREE.Vector3(500, 500, 500));
  grid.position.y = bounds.min.y - 60;
  return { bounds };
}

/** Project textures plus the decoded packed images of drafts (project ids win). */
function syncTextures(): void {
  const list = [...(project()?.textures ?? [])];
  const ids = new Set(list.map((t) => t.id));
  for (const t of draftTextures.values()) if (!ids.has(t.id)) list.push(t);
  cache.sync(list);
}

/** Compile `source` onto the preview shape; false (and a status line) if the code is broken. */
function applyCode(source: string, label = ''): boolean {
  syncTextures();
  const { bounds } = buildSubject();
  try {
    material = buildMaterial(source, hostFor({ bounds, textures: (id) => cache.get(id) }));
    subject.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = material; });
    setStatus(`${label || 'Preview'} · ${shape === 'obj' && objName ? objName : SHAPES.find((s) => s.value === shape)!.label}`);
    return true;
  } catch (e) {
    setStatus(`Code error: ${e instanceof Error ? e.message : String(e)}`, true);
    return false;
  }
}

async function openObj(file: File): Promise<void> {
  const group = new OBJLoader().parse(await file.text());
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  if (longest < 50) group.scale.setScalar(1000);   // Blender exports metres; treat small models as metres and scale to mm
  const sizeMm = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  const longestMm = Math.max(sizeMm.x, sizeMm.y, sizeMm.z) || 1000;
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
    if (mesh.geometry.getAttribute('uv')) uvToMm(mesh.geometry, longestMm, longestMm);   // 0..1 uv → roughly mm (an unwrapped model covers its longest side)
  });
  group.position.sub(new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3()));
  objGroup = group; objName = file.name; shape = 'obj';
  applyCode(code.value || PLAIN);
  renderSide();
}

// -- picking ------------------------------------------------------------------------------
function is(p: Pick): boolean { return JSON.stringify(p) === JSON.stringify(pick); }
function select(p: Pick): void { pick = p; render(); }

function validatePick(): void {
  const p = project();
  const cur = pick;
  if (!cur) { if (p?.materials.length) pick = { kind: 'material', id: p.materials[0].id }; return; }
  const ok = cur.kind === 'material' ? !!(p && findMaterial(p, cur.id)) : cur.kind === 'texture' ? !!(p && findTexture(p, cur.id)) : cur.kind === 'animation' ? !!(p && findAnimation(p, cur.id)) : cur.kind === 'library' ? readLibrary().some((m) => m.id === cur.id) : !!blend?.materials.some((m) => m.name === cur.name);
  if (!ok) pick = p?.materials.length ? { kind: 'material', id: p.materials[0].id } : null;
}

/** The code of the picked item (textures keep the previous preview). */
function pickedCode(): { key: string; code: string; editable: boolean } | null {
  const p = project(), cur = pick;
  if (!cur || cur.kind === 'texture' || cur.kind === 'animation') return null;
  if (cur.kind === 'material') { const m = p && findMaterial(p, cur.id); return m ? { key: `material:${m.id}`, code: m.code, editable: true } : null; }
  if (cur.kind === 'library') { const m = readLibrary().find((x) => x.id === cur.id); return m ? { key: `library:${m.id}`, code: m.code, editable: false } : null; }
  const m = blend?.materials.find((x) => x.name === cur.name);
  return m ? { key: `blend:${m.name}`, code: draft(m).code, editable: true } : null;
}

function draft(m: BlendMaterial): Converted {
  let d = drafts.get(m.name);
  if (!d) {
    drafts.set(m.name, d = convertMaterial(m));
    for (const im of d.images) {
      if (!im.packed || draftTextures.has(im.id)) continue;
      textureFromBytes(im.packed, im.name, blend?.fileName ?? '').then((t) => { draftTextures.set(im.id, { id: im.id, ...t }); syncTextures(); }, (e) => console.warn(e));
    }
  }
  return d;
}

// -- render ----------------------------------------------------------------------------------
function render(): void {
  if (isScrubbing()) { dirty = true; return; }   // a drag on a number field keeps its element (docs/25-number-fields.md §3)
  const active = document.activeElement;
  if (active && active !== code && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && (active as HTMLInputElement).type !== 'file') { dirty = true; return; }
  if (active === code && pick?.kind !== 'texture') { dirty = true; return; }
  dirty = false;
  validatePick();
  renderSide();
  renderDetail();
}
document.addEventListener('focusout', () => { setTimeout(() => { if (dirty && !(document.activeElement && document.activeElement.tagName === 'INPUT')) render(); }, 0); });

function header(title: string, ...actions: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'sec-title' }, el('span', { class: 'grow' }, title), ...actions.filter((a): a is HTMLElement => !!a));
}

/** A list row that can be dragged to reorder within its list (`move` receives the target index). */
function row(list: ListKind, id: string, index: number, selected: boolean, onClick: () => void, move: (index: number) => void, ...children: (HTMLElement | null)[]): HTMLElement {
  const r = el('div', { class: `me-row ${selected ? 'selected' : ''}`, draggable: true, onclick: onClick },
    el('span', { class: 'grip', title: 'Drag to reorder' }, '≡'), ...children.filter((c): c is HTMLElement => !!c));
  r.addEventListener('dragstart', (e) => { dragging = { list, id }; e.dataTransfer?.setData('text/plain', id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
  r.addEventListener('dragend', () => { dragging = null; });
  r.addEventListener('dragover', (e) => { if (dragging?.list === list && dragging.id !== id) { e.preventDefault(); r.classList.add('drag-over'); } });
  r.addEventListener('dragleave', () => r.classList.remove('drag-over'));
  r.addEventListener('drop', (e) => {
    r.classList.remove('drag-over');
    if (dragging?.list !== list || dragging.id === id) return;
    e.preventDefault(); e.stopPropagation();
    move(index + (e.offsetY > r.clientHeight / 2 ? 1 : 0));
  });
  return r;
}

function moveTo(list: ListKind, id: string, from: number, to: number): void {
  const index = to > from ? to - 1 : to;
  if (list === 'library') { moveInLibrary(id, index); return; }
  const command = list === 'material' ? 'moveMaterial' : list === 'animation' ? 'moveAnimation' : 'moveTexture';
  run([command, id, index]);
}

/** Run commands in the designer (one undo step); errors go to the status line. */
async function run(...calls: [string, ...unknown[]][]): Promise<unknown> {
  try { return await client.call(...calls); }
  catch (e) { setStatus(e instanceof Error ? e.message : String(e), true); return undefined; }
}

function renderSide(): void {
  const p = project();
  const texInput = el('input', { type: 'file', accept: IMAGE_ACCEPT, multiple: true, style: 'display:none', onchange: (e: Event) => { for (const f of (e.target as HTMLInputElement).files ?? []) void addTextureFile(f); } });
  const blendInput = el('input', { type: 'file', accept: '.blend', style: 'display:none', onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void openBlend(f); } });
  const objInput = el('input', { type: 'file', accept: '.obj', style: 'display:none', onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void openObj(f); } });
  const materials = p ? p.materials.map((m, i) => row('material', m.id, i, is({ kind: 'material', id: m.id }), () => select({ kind: 'material', id: m.id }), (to) => moveTo('material', m.id, i, to),
    el('span', { class: 'name', title: m.source }, m.name),
    el('span', { class: 'dim' }, `${plural(uses(p, m.id), 'use')}${m.warnings.length ? ' · ⚠' : ''}`),
  )) : [];
  const users = (id: Id) => p!.materials.filter((m) => texturesInCode(m.code).includes(id)).length;
  const textures = p ? p.textures.map((t, i) => row('texture', t.id, i, is({ kind: 'texture', id: t.id }), () => select({ kind: 'texture', id: t.id }), (to) => moveTo('texture', t.id, i, to),
    el('span', { class: 'thumb', style: `background-image:url(${thumbUrl(t)})` }),
    el('span', { class: 'name', title: `${t.id} · ${t.source}` }, t.name),
    el('span', { class: 'dim' }, `${t.width}×${t.height} · ${plural(users(t.id), 'use')}`),
  )) : [];
  const patched = (id: Id) => fixturesOf(p!).filter(({ layer }) => layer.pixels!.animation === id).length;
  const animations = p ? p.animations.map((a, i) => row('animation', a.id, i, is({ kind: 'animation', id: a.id }), () => select({ kind: 'animation', id: a.id }), (to) => moveTo('animation', a.id, i, to),
    el('span', { class: 'thumb', style: `background-image:url(${p.textures.find((t) => t.id === a.texture)?.data ?? ''})` }),
    el('span', { class: 'name', title: a.id }, a.name),
    el('span', { class: 'dim' }, `${a.width}×${a.frames} · ${a.fps} fps · ${plural(patched(a.id), 'fixture')}`),
  )) : [];
  const inProject = new Set(p?.materials.map((m) => m.id) ?? []);
  const library = readLibrary().map((m, i) => row('library', m.id, i, is({ kind: 'library', id: m.id }), () => select({ kind: 'library', id: m.id }), (to) => moveTo('library', m.id, i, to),
    el('span', { class: 'name', title: m.source }, m.name),
    el('span', { class: 'dim' }, `${m.source || 'library'}${m.textures?.length ? ` · ${plural(m.textures.length, 'texture')}` : ''}${inProject.has(m.id) ? ' · in project' : ''}`),
  ));
  const blendRows = (blend?.materials ?? []).map((m) => {
    const rgb = m.viewport.color.slice(0, 3).map((c) => Math.round(Math.pow(Math.max(0, c), 1 / 2.2) * 255)).join(',');
    return el('div', { class: `me-row ${is({ kind: 'blend', name: m.name }) ? 'selected' : ''}`, onclick: () => select({ kind: 'blend', name: m.name }) },
      el('span', { class: 'swatch', style: `background:rgb(${rgb})` }),
      el('span', { class: 'name' }, m.name),
      el('span', { class: 'dim' }, m.useNodes ? plural(m.tree?.nodes.length ?? 0, 'node') : 'no nodes'),
    );
  });
  side.replaceChildren(
    el('div', { class: 'brand-row' }, el('span', { class: 'brand' }, 'Materials'), el('a', { href: '/', target: 'deco-designer', class: 'hint' }, p ? `← ${p.name}` : '← designer')),
    el('section', { class: 'sec' },
      header('Project materials', p ? btn('＋ Material', () => void newMaterial(), { title: 'A plain grey material to edit' }) : null),
      ...materials,
      !p ? el('div', { class: 'me-empty' }, 'No designer tab is open — open the designer (link above) to see and change its project. The library, the preview and .blend import work without it.')
        : materials.length ? null : el('div', { class: 'me-empty' }, 'None yet — add one, take one from the library, or open a .blend below.'),
    ),
    el('section', { class: 'sec' },
      header('Textures', texInput, p ? btn('＋ Texture…', () => texInput.click(), { title: 'Add a PNG / JPEG / WebP image (or drop it on this page)' }) : null),
      ...textures,
      textures.length ? null : el('div', { class: 'me-empty' }, 'Images that materials sample with host.texture(id).'),
    ),
    el('section', { class: 'sec' },
      header('Pixel animations'),
      ...animations,
      animations.length ? null : el('div', { class: 'me-empty' }, 'Maps that drive LED fixtures (docs/17-emitters.md): a PNG where x = LED id and y = frame. Add the PNG as a texture, then "Use as animation".'),
    ),
    el('section', { class: 'sec' },
      header('Library (this browser)'),
      ...library,
      library.length ? null : el('div', { class: 'me-empty' }, 'Materials saved for other projects live here.'),
    ),
    el('section', { class: 'sec' },
      header('Blender', blendInput, btn(blend ? 'Open another…' : 'Open .blend…', () => blendInput.click(), { title: 'Read a .blend in the browser (or drop it on this page) — nothing is uploaded' })),
      el('div', { class: 'me-empty' }, blend ? `${blend.fileName} · Blender ${blend.version}` : 'Open a .blend to convert its materials (docs/09-blender-import.md).'),
      ...blendRows,
    ),
    el('section', { class: 'sec' },
      header('Preview on'),
      selectField(shape, SHAPES, (v) => { shape = v as Shape; if (shape === 'obj' && !objGroup) { objInput.click(); return; } applyCode(code.value || PLAIN); renderSide(); }, { class: 'grow' }),
      el('label', { class: 'drop small' }, objInput, el('span', {}, objName || 'Choose an .obj (metres or mm)')),
      el('div', { class: 'hint' }, 'uv is metres of surface on every shape, as on curves and lofts — patterns and images keep their physical size.'),
    ),
  );
}

function renderDetail(): void {
  const p = project();
  if (!pick) {
    props.replaceChildren(el('div', { class: 'hint' }, p ? 'Pick a material, texture or animation on the left, or add one.' : 'Pick a library material, or open a .blend.'));
    codePane.hidden = true; props.classList.add('wide');
    return;
  }
  if (pick.kind === 'texture') {
    props.replaceChildren(textureDetail(findTexture(p!, pick.id)!));
    codePane.hidden = true; props.classList.add('wide');
    return;
  }
  if (pick.kind === 'animation') {
    props.replaceChildren(animationDetail(findAnimation(p!, pick.id)!, p!));
    codePane.hidden = true; props.classList.add('wide');
    return;
  }
  codePane.hidden = false; props.classList.remove('wide');
  const c = pickedCode()!;
  let body: HTMLElement, bar: HTMLElement[];
  if (pick.kind === 'material') {
    const m = findMaterial(p!, pick.id)!;
    body = materialDetail(m, p!);
    bar = [btn('Revert', () => { loadCode(c.key, c.code, true); applyCode(c.code, 'Reverted'); }, { title: 'Back to the saved code' }), btn('Apply', applyEdited, { class: 'primary', title: 'Compile, preview and put it on the curves and lofts using it (⌘⏎)' })];
  } else if (pick.kind === 'library') {
    const id = pick.id;
    body = libraryDetail(readLibrary().find((x) => x.id === id)!, p);
    bar = [el('span', { class: 'dim' }, 'add it to the project to edit')];
  } else {
    const name = pick.name;
    const m = blend!.materials.find((x) => x.name === name)!;
    body = draftDetail(m, draft(m), p);
    bar = [btn('Reset', () => { loadCode(c.key, c.code, true); applyCode(c.code, 'Reset'); }, { title: 'Back to the converted code' }), btn('Preview', applyEdited, { class: 'primary', title: 'Compile the edited code onto the preview (⌘⏎) — "Add" uses it' })];
  }
  loadCode(c.key, c.code, false);
  code.readOnly = !c.editable;
  if (previewKey !== c.key) { previewKey = c.key; applyCode(code.value); }
  props.replaceChildren(body);
  codePane.replaceChildren(
    el('div', { class: 'code-bar' }, el('span', { class: 'sec-title', style: 'margin:0' }, 'TSL code'), el('span', { class: 'grow' }), btn('Copy', () => { void navigator.clipboard.writeText(code.value); setStatus('Copied'); }), btn('Download .js', download, { title: 'Save as an ES module: export default (tsl, host) => material' }), ...bar),
    code,
    statusEl,
  );
}

/** Put code in the editor unless it already shows this item with the same base (keeps unapplied edits across re-renders). */
function loadCode(key: string, source: string, force: boolean): void {
  if (!force && codeKey === key && codeBase === source) return;
  codeKey = key; codeBase = source; code.value = source;
}

/** ⌘⏎ / Apply: preview the edited code; for a project material also save it. */
function applyEdited(): void {
  if (!pick || code.readOnly) return;
  const src = code.value;
  if (!applyCode(src, pick.kind === 'material' ? 'Applied' : 'Previewed')) return;
  codeBase = src;
  if (pick.kind === 'material') void run(['updateMaterial', pick.id, { code: src }]);
}

function download(): void {
  if (!code.value) return;
  const name = ((pick?.kind === 'blend' ? pick.name : pick?.kind === 'material' || pick?.kind === 'library' ? pick.id : 'material')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'material';
  const blob = new Blob([`export default ${code.value}\n`], { type: 'text/javascript' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${name}.material.js` });
  a.click();
  URL.revokeObjectURL(a.href);
}

function selectionTarget(): string | null {
  const sel = client.state?.selection;
  if (!sel) return null;
  return sel.loftId ? 'the selected loft' : sel.curves.length ? `the selected ${plural(sel.curves.length, 'curve')}` : null;
}

/** The command that puts material `id` (or PREV) on the designer's selection, if any. */
function assignCall(id: unknown): [string, ...unknown[]] | null {
  const sel = client.state?.selection;
  if (!sel) return null;
  return sel.loftId ? ['setLoftMaterial', sel.loftId, id] : sel.curves.length ? ['setCurveMaterial', sel.curves, id] : null;
}

function warningsList(warnings: string[]): HTMLElement | null {
  return warnings.length ? el('div', {}, el('div', { class: 'sec-title', style: 'margin-top:6px' }, `Not 1:1 (${warnings.length})`), el('ul', { class: 'warnings' }, ...warnings.map((w) => el('li', {}, w)))) : null;
}

function textureChips(source: string, p: Project | null, onMissing: (id: Id) => void): HTMLElement | null {
  const ids = texturesInCode(source);
  if (!ids.length) return null;
  return el('div', { class: 'row wrap' },
    el('span', { class: 'lbl' }, 'textures'),
    ...ids.map((id) => {
      const t = p && findTexture(p, id);
      return t
        ? el('span', { class: 'me-tex', title: `${t.name} · ${t.width}×${t.height}`, onclick: () => select({ kind: 'texture', id }) }, el('span', { class: 'thumb small', style: `background-image:url(${thumbUrl(t)})` }), id)
        : el('span', { class: 'me-tex missing', title: p ? 'Not in the project — click to add an image for it' : 'Not in a project', onclick: () => { if (p) onMissing(id); } }, `${id} · missing`);
    }),
  );
}

function meta(...pairs: [string, string | null][]): HTMLElement {
  return el('div', { class: 'row wrap' }, ...pairs.flatMap(([k, v]) => (v === null ? [] : [el('span', { class: 'lbl' }, k), el('span', { class: 'dim' }, v)])));
}

function materialDetail(m: Material, p: Project): HTMLElement {
  const target = selectionTarget();
  const n = uses(p, m.id);
  return el('div', {},
    el('h3', {},
      textField(m.name, (v) => void run(['updateMaterial', m.id, { name: v }]), { class: 'name', placeholder: 'Name' }),
      target ? btn('Use on selection', () => void run(assignCall(m.id)!), { class: 'primary', title: `Put it on ${target}` }) : null,
      btn('Duplicate', () => void run(['duplicateMaterial', m.id]).then((id) => { if (typeof id === 'string') select({ kind: 'material', id }); })),
      btn('Save to library', () => saveMaterialToLibrary(m, p), { title: 'Keep a copy (with its textures) for other projects in this browser' }),
      btn('Remove', () => void run(['removeMaterial', m.id]), { class: 'danger', title: `Remove from the project${n ? ` — ${plural(n, 'user')} go back to the default look` : ''}` }),
    ),
    meta(['id', m.id], ['from', m.source || '—'], ['used by', plural(n, 'curve / loft')]),
    textureChips(m.code, p, (id) => pickTextureFile(id)),
    warningsList(m.warnings),
  );
}

function libraryDetail(m: LibraryMaterial, p: Project | null): HTMLElement {
  const target = selectionTarget();
  return el('div', {},
    el('h3', {},
      textField(m.name, (v) => { saveToLibrary({ ...m, name: v }); }, { class: 'name', placeholder: 'Name' }),
      p ? btn(target ? 'Add to project & use' : 'Add to project', () => {
        const assign = assignCall(PREV);
        void run(['addLibraryMaterial', m], ...(assign ? [assign] : [])).then((id) => { if (typeof id === 'string') select({ kind: 'material', id }); });
      }, { class: 'primary', title: `Copy into the project with its textures${target ? ` and put it on ${target}` : ''}` }) : null,
      btn('Remove from library', () => removeFromLibrary(m.id), { class: 'danger' }),
    ),
    meta(['id', m.id], ['from', m.source || '—'], ['', p && findMaterial(p, m.id) ? 'already in this project (adding makes a copy)' : null]),
    m.textures?.length ? el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'textures'), ...m.textures.map((t) => el('span', { class: 'me-tex', title: `${t.name} · ${t.width}×${t.height}` }, el('span', { class: 'thumb small', style: `background-image:url(${thumbUrl(t)})` }), t.id))) : null,
    warningsList(m.warnings),
  );
}

function draftDetail(m: BlendMaterial, d: Converted, p: Project | null): HTMLElement {
  const target = selectionTarget();
  return el('div', {},
    el('h3', {},
      textField(draftNames.get(m.name) ?? m.name, (v) => { draftNames.set(m.name, v); }, { class: 'name', placeholder: 'Name' }),
      p ? btn(target ? 'Add to project & use' : 'Add to project', () => void addDraft(m, 'project'), { class: 'primary', title: `Copy the code and its packed images into the project${target ? ` and put it on ${target}` : ''}` }) : null,
      btn('Add to library', () => void addDraft(m, 'library'), { title: 'Keep it (with its packed images) for other projects in this browser' }),
    ),
    meta(['from', `${blend!.fileName} · Blender ${blend!.version}`]),
    d.images.length ? el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'images'), ...d.images.map((im) => el('span', { class: `me-tex ${im.packed ? '' : 'missing'}`, title: im.filepath || im.name }, `${im.id} ← ${im.name}${im.packed ? ` · ${Math.round(im.packed.length / 1024)} kB` : ' · not packed'}`))) : null,
    warningsList(d.warnings),
  );
}

function textureDetail(t: Texture): HTMLElement {
  const p = project()!;
  const users = p.materials.filter((m) => texturesInCode(m.code).includes(t.id));
  const input = el('input', { type: 'file', accept: IMAGE_ACCEPT, style: 'display:none', onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void replaceTexture(t.id, f); } });
  return el('div', { class: 'tex-detail' },
    el('div', {},
      el('h3', {},
        textField(t.name, (v) => void run(['updateTexture', t.id, { name: v }]), { class: 'name', placeholder: 'Name' }),
        input,
        btn('Replace image…', () => input.click(), { title: 'Swap the image; materials keep sampling this id' }),
        btn('Remove', () => void run(['removeTexture', t.id]), { class: 'danger', title: users.length ? `${plural(users.length, 'material')} will sample grey` : 'Remove from the project' }),
      ),
      meta(['id', t.id], ['size', `${t.width}×${t.height} · ${isHdrMime(t.mime) ? 'HDR ' : ''}${t.mime.replace('image/', '').replace('vnd.radiance', 'hdr').replace('x-exr', 'exr')} · ${kb(t.data)}`], ['from', t.source || '—']),
      el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'used by'), ...(users.length ? users.map((m) => el('span', { class: 'me-tex', onclick: () => select({ kind: 'material', id: m.id }) }, m.name)) : [el('span', { class: 'dim' }, 'no material yet')])),
      isHdrMime(t.mime) ? null : el('div', { class: 'row wrap' },
        btn('Use as animation', () => void useAsAnimation(t), { title: 'Read this PNG as a pixel animation (docs/17-emitters.md): x = LED id, y = frame' }),
        el('span', { class: 'dim' }, `${t.width} LED ids × ${t.height} frames`),
      ),
      isHdrMime(t.mime)
        ? el('div', { class: 'hint' }, `An HDR for worlds (docs/16-world.md): pick it as the background or environment of the project's world (outliner › World) or a camera's own. A 1k equirectangular is plenty for the viewport; materials sampling it get grey.`)
        : el('div', { class: 'hint' }, `Sample it in material code with texture(host.texture('${t.id}'), host.uv.xy) — host.uv is metres of surface, so the image repeats once per metre unless the coordinates are scaled.`),
    ),
    el('div', { class: 'me-thumb' }, el('img', { src: thumbUrl(t), alt: t.name })),
  );
}

// -- actions ------------------------------------------------------------------------------
async function newMaterial(): Promise<void> {
  const id = await run(['addMaterial', { name: 'Material', code: PLAIN, source: '', warnings: [] }]);
  if (typeof id === 'string') select({ kind: 'material', id });
}

/** Read a PNG texture as a pixel animation map (docs/17-emitters.md). */
async function useAsAnimation(t: Texture): Promise<void> {
  const id = await run(['addAnimation', { name: t.name, texture: t.id, fps: 30, frames: t.height, width: t.width }]);
  if (typeof id === 'string') { select({ kind: 'animation', id }); setStatus(`Animation "${t.name}" added as ${id} — patch fixtures to it in the designer's curve panel`); }
}

/** One animation: its map, how fast it plays and which fixtures read it. */
function animationDetail(a: Animation, p: Project): HTMLElement {
  const t = findTexture(p, a.texture);
  const users = fixturesOf(p).filter(({ layer }) => layer.pixels!.animation === a.id);
  return el('div', { class: 'tex-detail' },
    el('div', {},
      el('h3', {},
        textField(a.name, (v) => void run(['updateAnimation', a.id, { name: v }]), { class: 'name', placeholder: 'Name' }),
        btn('Remove', () => void run(['removeAnimation', a.id]), { class: 'danger', title: users.length ? `${plural(users.length, 'fixture')} will go back to their own colour` : 'Remove from the project' }),
      ),
      meta(['id', a.id], ['map', t ? `${t.name} · ${a.width} LED ids × ${a.frames} frames` : `${a.texture} (missing)`], ['plays', `${(a.frames / Math.max(0.01, a.fps)).toFixed(1)} s`]),
      el('div', { class: 'row fields' }, el('span', { class: 'lbl' }, 'fps'), numField('', a.fps, (v) => void run(['updateAnimation', a.id, { fps: v }]), { step: 1, min: 0.1 })),
      el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'fixtures'), ...(users.length ? users.map(({ curve, layer }) => el('span', { class: 'me-tex' }, `${curve.name}${curve.outline.length > 1 ? ` / ${layer.id}` : ''} @ ${layer.pixels!.offset}`)) : [el('span', { class: 'dim' }, 'none yet — patch curves in the designer')])),
      el('div', { class: 'hint' }, 'x is the LED id, y is the frame (row 0 first). A fixture reads 80 columns per chain from its own offset, so daisy-chained strings follow one another across the map.'),
    ),
    el('div', { class: 'me-thumb' }, t ? el('img', { src: t.data, alt: a.name }) : el('span', { class: 'me-empty' }, 'the PNG is gone')),
  );
}

function saveMaterialToLibrary(m: Material, p: Project): void {
  const textures = texturesInCode(m.code).map((id) => findTexture(p, id)).filter((t): t is Texture => !!t);
  saveToLibrary({ id: m.id, name: m.name, code: m.code, source: m.source, warnings: m.warnings, textures });
  setStatus(`"${m.name}" saved to the library${textures.length ? ` with ${plural(textures.length, 'texture')}` : ''}`);
}

function pickTextureFile(forcedId: Id): void {
  const input = el('input', { type: 'file', accept: IMAGE_ACCEPT, onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void addTextureFile(f, forcedId); } });
  input.click();
}

async function addTextureFile(file: File, forcedId?: Id): Promise<void> {
  if (!project()) { setStatus('Open the designer to add textures to its project', true); return; }
  try {
    const t = await textureFromFile(file);
    const id = await run(['addTexture', { ...t, id: forcedId }]);
    if (typeof id === 'string') { select({ kind: 'texture', id }); setStatus(`Texture "${t.name}" added as ${id}`); }
  } catch (e) { setStatus(e instanceof Error ? e.message : String(e), true); }
}

async function replaceTexture(id: Id, file: File): Promise<void> {
  try {
    const t = await textureFromFile(file);
    await run(['updateTexture', id, { data: t.data, mime: t.mime, width: t.width, height: t.height, source: t.source }]);
    setStatus(`Texture ${id} replaced with ${file.name}`);
  } catch (e) { setStatus(e instanceof Error ? e.message : String(e), true); }
}

async function openBlend(file: File): Promise<void> {
  setStatus(`Reading ${file.name} …`);
  try {
    const f = await BlendFile.parse(await file.arrayBuffer());
    const materials = readMaterials(f);
    const version = f.version.replace(/^0?(\d)(\d\d)$/, '$1.$2').replace(/^(\d)\.0(\d)$/, '$1.$2');
    blend = { fileName: file.name, version, materials };
    drafts.clear(); draftNames.clear(); draftTextures.clear();
    setStatus(`${plural(materials.length, 'material')} in ${file.name} (Blender ${version})`);
    if (materials.length) pick = { kind: 'blend', name: materials[0].name };
  } catch (e) { setStatus(`Cannot read ${file.name}: ${e instanceof Error ? e.message : String(e)}`, true); }
  render();
}

/** Add a converted Blender material — with its packed images as textures — to the project or the library. */
async function addDraft(m: BlendMaterial, where: 'project' | 'library'): Promise<void> {
  const d = draft(m);
  const source = codeKey === `blend:${m.name}` ? code.value : d.code;
  const name = (draftNames.get(m.name) ?? m.name).trim() || m.name;
  const textures: Texture[] = [];
  for (const im of d.images) {
    if (!im.packed) continue;
    try { textures.push({ id: im.id, ...(await textureFromBytes(im.packed, im.name, blend!.fileName)) }); }
    catch (e) { setStatus(`Image ${im.name}: ${e instanceof Error ? e.message : String(e)}`, true); }
  }
  const entry = { name, code: source, source: blend!.fileName, warnings: d.warnings, textures };
  if (where === 'library') {
    saveToLibrary(entry);
    setStatus(`"${name}" saved to the library${textures.length ? ` with ${plural(textures.length, 'texture')}` : ''}`);
    return;
  }
  const assign = assignCall(PREV);
  const id = await run(['addLibraryMaterial', entry], ...(assign ? [assign] : []));
  if (typeof id !== 'string') return;
  setStatus(`"${name}" added to the project${textures.length ? ` with ${plural(textures.length, 'texture')}` : ''}`);
  select({ kind: 'material', id });
}

// -- wiring ------------------------------------------------------------------------------
// files dropped anywhere: .blend opens, .obj is the preview shape, images become textures
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  for (const f of e.dataTransfer?.files ?? []) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.blend')) void openBlend(f); else if (n.endsWith('.obj')) void openObj(f); else void addTextureFile(f);
  }
});

const wanted = new URLSearchParams(location.search).get('id');
let first = true;
client.onState = () => {
  if (first) { first = false; if (wanted) pick = { kind: 'material', id: wanted }; }
  applyWorld();
  render();
};
client.onShow = (id) => { if (id) pick = { kind: 'material', id }; render(); window.focus(); };
onLibraryChange(render);
render();
setStatus('Waiting for the designer tab …');
setTimeout(() => { if (!client.connected) setStatus('No designer tab answered — the project section stays empty; library, preview and .blend import still work'); }, 1500);
await initPreview();
applyCode(PLAIN, 'Preview');

// a number field dragged here is one undo step in the designer (docs/25-number-fields.md §3)
setScrubHooks({
  begin: () => { if (client.connected) void run(['live.begin']); },
  end: () => { if (client.connected) void run(['live.end']); render(); },
});
