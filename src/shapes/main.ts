/**
 * Programs page (shapes.html, docs/14-shapes.md, docs/30-outline-and-shape-layers.md §5) —
 * its own tab, opened from a curve's profile dropdown or a shape layer's fill dropdown in
 * the designer. Two kinds of program live here: a **profile** — the stock a curve's outline
 * layer is bent from, `(three, curve, params) => geometry`, with its colour and bend limits —
 * and a **fill** — what a shape layer spreads over the surface its curves enclose,
 * `(three, surface, params) => geometry`, with its colour. Left: the open project's programs
 * (mirrored over the channel, src/app/channel.ts), the presets, the browser library, the
 * preview subject (a curve, or a surface) and material. Centre: the mesh the picked program
 * makes. Bottom: name, colour, limits, parameters, actions and the code editor. Changes to
 * the project are commands run in the designer tab.
 */
import '../style.css';
import * as THREE from 'three/webgpu';
import { EditorClient } from '../app/channel';
import { btn, el, numField, selectField, textField } from '../ui/dom';
import { createPreview } from '../ui/preview';
import { defaultWorld } from '../model/world';
import { activeCameraOf } from '../model/camera';
import { dropIndex, downloadText, emptyNote, fileSlug, header, meta, plainRow, plural, row } from '../ui/lists';
import { PRESET_PROFILES, cloneProfile } from '../model/profiles';
import { CHECKER_COLOR, PRESET_FILLS, cloneFill } from '../model/fills';
import { findMaterial, vertex, type Curve, type CurveObject, type Fill, type Id, type Profile, type Project } from '../model/types';
import { attributeMaterial, buildShapeGeometry, shapeInput } from '../geometry/shape';
import { buildFillGeometry, shapeCurves, surfaceInput, type SurfaceInput } from '../geometry/surface';
import { checkerMaterial } from '../geometry/loft';
import { buildMaterial, hostFor } from '../materials/runtime';
import { TextureCache } from '../materials/textures';
import { fillLibrary, shapeLibrary } from './library';
import { isScrubbing, setScrubHooks } from '../ui/scrub';

/** The two program kinds (docs/30 §1). */
type Kind = 'profile' | 'fill';
type Pick = { what: Kind; from: 'project' | 'preset' | 'library'; id: Id } | null;
/** A program of either kind: a fill has no limits. */
type Program = Profile | Fill;
const isProfile = (x: Program): x is Profile => 'limits' in x;

const SAMPLE_CURVES: { value: string; label: string; curve: Curve }[] = [
  { value: 's-bend', label: 'S-bend (1.2 m, open)', curve: { points: [vertex(-500, -200), vertex(-170, 250), vertex(170, -250), vertex(500, 200)], closed: false } },
  { value: 'loop', label: 'Rounded loop (closed)', curve: { points: [vertex(-400, -250), vertex(400, -250), vertex(400, 250), vertex(-400, 250)], closed: true } },
  { value: 'lift', label: 'S-bend lifted (3D)', curve: { points: [vertex(-500, -200), { ...vertex(-170, 250), z: 150 }, { ...vertex(170, -250), z: -150 }, vertex(500, 200)], closed: false } },
];
const rectCurve = (id: string, w: number, h: number): CurveObject => ({ id, name: id, planeId: 'p', type: 'planar', constraints: [], outline: [], curve: { points: [vertex(-w / 2, -h / 2), vertex(w / 2, -h / 2), vertex(w / 2, h / 2), vertex(-w / 2, h / 2)], closed: true } });
const SAMPLE_SURFACES: { value: string; label: string; curves: CurveObject[] }[] = [
  { value: 'sheet', label: 'Sheet 1000 × 600', curves: [rectCurve('sheet', 1000, 600)] },
  { value: 'frame', label: 'Frame with a hole', curves: [rectCurve('outer', 1000, 600), rectCurve('hole', 500, 250)] },
];
const profileUses = (p: Project, id: Id) => p.curves.flatMap((c) => c.outline).filter((l) => l.profileId === id).length;
const fillUses = (p: Project, id: Id) => p.shapes.flatMap((sh) => sh.layers).filter((l) => l.fillId === id).length;
const uses = (p: Project, x: Program) => (isProfile(x) ? plural(profileUses(p, x.id), 'layer') : plural(fillUses(p, x.id), 'layer'));

// -- state ----------------------------------------------------------------------------
const client = new EditorClient('deco-shapes');
const project = (): Project | null => client.state?.project ?? null;
let pick: Pick = null;
let dirty = false;
let previewCurve = 's-bend';
let previewSurface = 'sheet';
let previewMaterial = 'checker';
/** edited params of presets / library entries before they are added (by pick key) */
const draftParams = new Map<string, Record<string, number>>();
let codeKey = '';
let codeBase = '';
let previewKey = '';

const side = document.getElementById('ed-side')!;
const view = document.getElementById('ed-view')!;
const props = document.getElementById('ed-props')!;
const codePane = document.getElementById('ed-code')!;
const code = el('textarea', { class: 'code', spellcheck: false, placeholder: 'Pick a program on the left — its code appears here.' });
const statusEl = el('div', { class: 'code-status' });
code.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applyEdited(); } });
function setStatus(text: string, error = false): void { statusEl.textContent = text; statusEl.className = `code-status ${error ? 'error' : ''}`; }

// -- preview ----------------------------------------------------------------------------
const preview = createPreview(view);
const cache = new TextureCache();
const materialCache = new Map<string, { code: string; material: THREE.Material }>();
const plainMaterials = new Map<string, THREE.Material>();

function previewMat(x: Program, geo: THREE.BufferGeometry): THREE.Material {
  const p = project();
  if (previewMaterial === 'checker') return checkerMaterial(false);
  if (previewMaterial === 'plain') {
    if (x.color === CHECKER_COLOR) return checkerMaterial(false);
    const attributed = attributeMaterial(x.color, geo, null);
    if (attributed) return attributed;
    const key = isProfile(x) ? `p|${x.color}` : `f|${x.color}|${x.metalness}|${x.roughness}`;
    let m = plainMaterials.get(key);
    if (!m) plainMaterials.set(key, m = isProfile(x) ? new THREE.MeshStandardMaterial({ color: x.color, metalness: 0.85, roughness: 0.35 }) : new THREE.MeshStandardMaterial({ color: x.color, metalness: x.metalness, roughness: x.roughness, side: THREE.DoubleSide }));
    return m;
  }
  const m = p && findMaterial(p, previewMaterial);
  if (!m) return checkerMaterial(false);
  cache.sync(p!.textures);
  const hit = materialCache.get(m.id);
  if (hit && hit.code === m.code) return hit.material;
  try {
    const built = buildMaterial(m.code, hostFor({ textures: (id) => cache.get(id) }));
    hit?.material.dispose();
    materialCache.set(m.id, { code: m.code, material: built });
    return built;
  } catch (e) { console.warn(e); return checkerMaterial(false); }
}

/** The curve a profile preview builds on. */
function previewTarget(): { curve: Curve; id: string; name: string } | null {
  const sample = SAMPLE_CURVES.find((s) => s.value === previewCurve);
  if (sample) return { curve: sample.curve, id: sample.value, name: sample.label };
  const c = project()?.curves.find((x) => x.id === previewCurve);
  return c ? { curve: c.curve, id: c.id, name: c.name } : null;
}

/** The surface a fill preview builds on: a sample, or a project shape. */
function previewSurfaceInput(): { surface: SurfaceInput; name: string } | null {
  const sample = SAMPLE_SURFACES.find((s) => s.value === previewSurface);
  if (sample) { const surface = surfaceInput({ id: sample.value, name: sample.label, expand: 0, resolution: 2 }, sample.curves); return surface ? { surface, name: sample.label } : null; }
  const p = project();
  const sh = p?.shapes.find((x) => x.id === previewSurface);
  if (!sh || !p) return null;
  const surface = surfaceInput(sh, shapeCurves(sh, p.curves));
  return surface ? { surface, name: sh.name } : null;
}

const lineMat = () => new THREE.LineBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.6, depthTest: false });

/** Build `source` on the preview subject; false (and the error in the status line) if it fails. */
function applyCode(source: string, x: Program, label = ''): boolean {
  preview.subject.clear();
  try {
    if (isProfile(x)) {
      const target = previewTarget();
      if (!target) { setStatus('The preview curve is gone — pick another', true); return false; }
      const input = shapeInput({ id: target.id, name: target.name, curve: target.curve });
      if (!input) { setStatus('The preview curve has no length', true); return false; }
      preview.subject.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(input.samples.map((s) => new THREE.Vector3(s.x, s.y, s.z))), lineMat()));
      const { geometry, info } = buildShapeGeometry(source, input, x.params);
      preview.subject.add(new THREE.Mesh(geometry, previewMat(x, geometry)));
      preview.frame();
      setStatus(`${label || 'Preview'} · ${info.vertices} vertices · ${plural(info.triangles, 'triangle')} · ${info.hasUv ? 'uv ✓' : 'no uv — materials will look flat'} · ${info.ms.toFixed(1)} ms · on ${target.name}`, !info.hasUv);
    } else {
      const target = previewSurfaceInput();
      if (!target) { setStatus('The preview surface is gone — pick another', true); return false; }
      for (const loop of target.surface.loops) preview.subject.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(loop), lineMat()));
      const { geometry, info } = buildFillGeometry(source, target.surface, x.params);
      preview.subject.add(new THREE.Mesh(geometry, previewMat(x, geometry)));
      preview.frame();
      setStatus(`${label || 'Preview'} · ${info.vertices} vertices · ${plural(info.triangles, 'triangle')} · ${info.hasUv ? 'uv ✓' : 'no uv — materials will look flat'} · ${info.ms.toFixed(1)} ms · over ${target.name} (${(target.surface.area / 1e6).toFixed(2)} m²)`, !info.hasUv);
    }
    return true;
  } catch (e) {
    preview.frame();
    setStatus(`${isProfile(x) ? 'Profile' : 'Fill'} error: ${e instanceof Error ? e.message : String(e)}`, true);
    return false;
  }
}

// -- picking ------------------------------------------------------------------------------
function is(p: Pick): boolean { return JSON.stringify(p) === JSON.stringify(pick); }
function select(p: Pick): void { pick = p; previewKey = ''; render(); }
const keyOf = (p: Exclude<Pick, null>) => `${p.what}:${p.from}:${p.id}`;

/** The picked program (project / preset / library), or null. */
function picked(): { x: Program; inProject: boolean } | null {
  const p = project();
  if (!pick) return null;
  const list = (): Program[] => {
    if (pick!.what === 'profile') return pick!.from === 'project' ? p?.profiles ?? [] : pick!.from === 'preset' ? PRESET_PROFILES : shapeLibrary.read();
    return pick!.from === 'project' ? p?.fills ?? [] : pick!.from === 'preset' ? PRESET_FILLS : fillLibrary.read();
  };
  const x = list().find((y) => y.id === pick!.id);
  if (!x) return null;
  if (pick.from === 'project') return { x, inProject: true };
  return { x: { ...x, params: draftParams.get(keyOf(pick)) ?? x.params } as Program, inProject: false };
}

function validatePick(): void {
  const p = project();
  if (pick && picked()) return;
  pick = p?.profiles.length ? { what: 'profile', from: 'project', id: p.profiles[0].id } : { what: 'profile', from: 'preset', id: PRESET_PROFILES[0].id };
}

// -- render ----------------------------------------------------------------------------------
function render(): void {
  if (isScrubbing()) { dirty = true; return; }   // a drag on a number field keeps its element (docs/25-number-fields.md §3)
  { const p = project(); preview.setWorld(p ? activeCameraOf(p).world : defaultWorld(), p?.textures ?? []); }   // the active camera's world (docs/16, docs/36)
  const active = document.activeElement;
  if (active && active !== code && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && (active as HTMLInputElement).type !== 'file') { dirty = true; return; }
  if (active === code) { dirty = true; return; }
  dirty = false;
  validatePick();
  renderSide();
  renderDetail();
}
document.addEventListener('focusout', () => { setTimeout(() => { if (dirty && !(document.activeElement && document.activeElement.tagName === 'INPUT')) render(); }, 0); });

async function run(...calls: [string, ...unknown[]][]): Promise<unknown> {
  try { return await client.call(...calls); }
  catch (e) { setStatus(e instanceof Error ? e.message : String(e), true); return undefined; }
}

const swatchOf = (x: Program) => el('span', { class: 'swatch', style: x.color === CHECKER_COLOR ? 'background: repeating-conic-gradient(#bbb 0 25%, #666 0 50%) 0 0 / 8px 8px' : `background:${x.color}` });

function renderSide(): void {
  const p = project();
  const what: Kind = pick?.what ?? 'profile';
  const projectRows = (kind: Kind, list: Program[], move: string) => list.map((x, i) => row(`${kind}s`, x.id, i, is({ what: kind, from: 'project', id: x.id }), () => select({ what: kind, from: 'project', id: x.id }), (to) => void run([move, x.id, dropIndex(i, to)]),
    swatchOf(x), el('span', { class: 'name' }, x.label), el('span', { class: 'dim' }, p ? uses(p, x) : '')));
  const presetRows = (kind: Kind, list: Program[]) => list.map((x) => plainRow(is({ what: kind, from: 'preset', id: x.id }), () => select({ what: kind, from: 'preset', id: x.id }),
    swatchOf(x), el('span', { class: 'name' }, x.label), el('span', { class: 'dim' }, Object.keys(x.params).join(', '))));
  const inProject = new Set([...(p?.profiles.map((x) => `profile:${x.id}`) ?? []), ...(p?.fills.map((x) => `fill:${x.id}`) ?? [])]);
  const libraryRows = (kind: Kind, list: Program[], move: (id: string, to: number) => void) => list.map((x, i) => row(`${kind}-library`, x.id, i, is({ what: kind, from: 'library', id: x.id }), () => select({ what: kind, from: 'library', id: x.id }), (to) => move(x.id, dropIndex(i, to)),
    swatchOf(x), el('span', { class: 'name' }, x.label), el('span', { class: 'dim' }, `${Object.keys(x.params).join(', ')}${inProject.has(`${kind}:${x.id}`) ? ' · in project' : ''}`)));
  const curveOptions = [
    ...SAMPLE_CURVES.map((s) => ({ value: s.value, label: s.label, group: 'Samples' })),
    ...(p?.curves.filter((c) => c.curve.points.length >= 2).map((c) => ({ value: c.id, label: `${c.name} (${p.planes.find((pl) => pl.id === c.planeId)?.name ?? '?'})`, group: p.name })) ?? []),
  ];
  const surfaceOptions = [
    ...SAMPLE_SURFACES.map((s) => ({ value: s.value, label: s.label, group: 'Samples' })),
    ...(p?.shapes.map((sh) => ({ value: sh.id, label: sh.name, group: p.name })) ?? []),
  ];
  const materialOptions = [
    { value: 'checker', label: 'UV checker (100 mm)' }, { value: 'plain', label: what === 'profile' ? 'Profile colour' : 'Fill colour' },
    ...(p?.materials.map((m) => ({ value: m.id, label: m.name, group: 'Project materials' })) ?? []),
  ];
  const newProfile = btn('＋ New profile', () => void newProgram('profile'), { class: 'primary', title: p ? 'Add a new profile program to the project (starts as a round tube) and edit its code' : 'Open the designer tab first — programs live in its project' });
  const newFill = btn('＋ New fill', () => void newProgram('fill'), { class: 'primary', title: p ? 'Add a new fill program to the project (starts as the sheet) and edit its code' : 'Open the designer tab first — programs live in its project' });
  newProfile.disabled = newFill.disabled = !p;
  const library = shapeLibrary.read(), fills = fillLibrary.read();
  const parts: (HTMLElement | null)[] = [
    el('div', { class: 'brand-row' }, el('span', { class: 'brand' }, 'Programs'), el('a', { href: '/', target: 'deco-designer', class: 'hint' }, p ? `← ${p.name}` : '← designer')),
    el('div', { class: 'row', style: 'padding: 0 4px 6px' }, newProfile, newFill),
    el('section', { class: 'sec' },
      header('Project profiles — along a curve', p ? btn('＋', () => void newProgram('profile'), { title: 'New profile program' }) : null),
      ...(p ? projectRows('profile', p.profiles, 'moveProfile') : []),
      !p ? emptyNote('No designer tab is open — open the designer (link above) to see and change its programs. Presets, the library and the preview work without it.') : null,
    ),
    p ? el('section', { class: 'sec' },
      header('Project fills — over a shape', btn('＋', () => void newProgram('fill'), { title: 'New fill program' })),
      ...projectRows('fill', p.fills, 'moveFill'),
      p.fills.length ? null : emptyNote('No fills yet — add a preset below.'),
    ) : null,
    el('section', { class: 'sec' }, header('Presets · profiles'), ...presetRows('profile', PRESET_PROFILES)),
    el('section', { class: 'sec' }, header('Presets · fills'), ...presetRows('fill', PRESET_FILLS)),
    el('section', { class: 'sec' }, header('Library (this browser)'),
      ...libraryRows('profile', library, (id, to) => shapeLibrary.move(id, to)),
      ...libraryRows('fill', fills, (id, to) => fillLibrary.move(id, to)),
      library.length + fills.length ? null : emptyNote('Programs saved for other projects live here.')),
    el('section', { class: 'sec' },
      header('Preview on'),
      what === 'profile'
        ? selectField(previewCurve, curveOptions, (v) => { previewCurve = v; previewKey = ''; render(); }, { class: 'grow', title: 'The curve the profile runs along' })
        : selectField(previewSurface, surfaceOptions, (v) => { previewSurface = v; previewKey = ''; render(); }, { class: 'grow', title: 'The surface the fill runs over' }),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'material'), selectField(previewMaterial, materialOptions, (v) => { previewMaterial = v; previewKey = ''; render(); }, { class: 'grow', title: 'The checker shows the uv layout: one square = 100 mm' })),
      el('div', { class: 'hint' }, what === 'profile'
        ? 'Return a BufferGeometry in plane-local mm with uv in mm — the checker squares should be 100 mm on the mesh. three.sweep(curve, outline, { holes, rotate, up }) sweeps a cross-section (x sideways in the plane, y along the plane normal).'
        : 'Return a BufferGeometry in plane-local mm with uv in mm. surface gives loops, sheet (the flat fill), area, bounds, inside(x, y), heightAt(x, y), clip(a, b) and random(seed); three is the same scope as a profile’s.'),
    ),
  ];
  side.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
}

function renderDetail(): void {
  const p = project();
  const it = picked();
  if (!it) { props.replaceChildren(el('div', { class: 'hint' }, 'Pick a program on the left.')); codePane.hidden = true; props.classList.add('wide'); return; }
  codePane.hidden = false; props.classList.remove('wide');
  const { x, inProject } = it;
  const key = keyOf(pick!);
  loadCode(key, x.code, false);
  const pk = `${key}|${JSON.stringify(x.params)}|${x.color}|${previewCurve}|${previewSurface}|${previewMaterial}`;
  if (previewKey !== pk) { previewKey = pk; applyCode(code.value, x); }
  props.replaceChildren(inProject ? projectDetail(x, p!) : draftDetail(x, p));
  const kind = isProfile(x) ? 'profile' : 'fill';
  codePane.replaceChildren(
    el('div', { class: 'code-bar' }, el('span', { class: 'sec-title', style: 'margin:0' }, `${isProfile(x) ? 'Profile' : 'Fill'} code`), el('span', { class: 'grow' }),
      btn('Copy', () => { void navigator.clipboard.writeText(code.value); setStatus('Copied'); }),
      btn('Download .js', () => downloadText(`${fileSlug(x.label)}.${kind}.js`, `// params: ${JSON.stringify(x.params)}\nexport default ${code.value}\n`), { title: `Save as an ES module: export default (three, ${isProfile(x) ? 'curve' : 'surface'}, params) => geometry` }),
      btn('Revert', () => { loadCode(key, x.code, true); previewKey = ''; render(); }, { title: inProject ? 'Back to the saved code' : 'Back to the original code' }),
      btn(inProject ? 'Apply' : 'Preview', applyEdited, { class: 'primary', title: inProject ? `Build, preview and save (⌘⏎) — every layer running this ${kind} updates` : `Build the edited code on the preview ${isProfile(x) ? 'curve' : 'surface'} (⌘⏎) — "Add" uses it` }),
    ),
    code,
    statusEl,
  );
}

function loadCode(key: string, source: string, force: boolean): void {
  if (!force && codeKey === key && codeBase === source) return;
  codeKey = key; codeBase = source; code.value = source;
}

function applyEdited(): void {
  const it = picked();
  if (!it) return;
  const src = code.value;
  if (!applyCode(src, it.x, it.inProject ? 'Applied' : 'Previewed')) return;
  codeBase = src;
  if (it.inProject) void run([isProfile(it.x) ? 'updateProfile' : 'updateFill', it.x.id, { code: src }]);
}

/** What "use on selection" would act on: the selected curves for a profile, the selected shape for a fill. */
function selectionTarget(x: Program): string | null {
  const sel = client.state?.selection;
  if (isProfile(x)) return sel?.curves.length ? `the selected ${plural(sel.curves.length, 'curve')}` : null;
  return sel?.shapeId ? `the selected shape (${sel.shapeId})` : null;
}
function useCalls(x: Program, id: unknown): [string, ...unknown[]][] {
  const sel = client.state!.selection;
  return isProfile(x) ? [['setCurveProfile', sel.curves, id]] : [['addShapeLayer', sel.shapeId, { fillId: id }]];
}

/** Editable parameter table: name, default, ×, and a ＋ row. `onChange` gets the whole new set. */
function paramsTable(params: Record<string, number>, onChange: (next: Record<string, number>) => void): HTMLElement {
  const entries = Object.entries(params);
  const rename = (from: string, to: string) => { const t = to.trim().replace(/[^\w]/g, '_'); if (!t || t === from || t in params) return; onChange(Object.fromEntries(entries.map(([k, v]) => [k === from ? t : k, v]))); };
  let newName = '';
  return el('div', {},
    el('div', { class: 'sec-title', style: 'margin-top:6px' }, 'Parameters — params.name in the code; a layer may override each'),
    el('div', { class: 'params' },
      el('span', { class: 'head' }, 'name'), el('span', { class: 'head' }, 'default'), el('span'),
      ...entries.flatMap(([k, v]) => [
        textField(k, (t) => rename(k, t), { title: 'Rename (the code must use the new name)' }),
        numField('', v, (n) => onChange({ ...params, [k]: n }), { step: 1 }),
        btn('×', () => { const next = { ...params }; delete next[k]; onChange(next); }, { title: 'Remove' }),
      ]),
      textField('', (t) => { newName = t; }, { placeholder: 'new parameter' }),
      el('span'),
      btn('＋', () => { const t = newName.trim().replace(/[^\w]/g, '_'); if (t && !(t in params)) onChange({ ...params, [t]: 0 }); }, { title: 'Add a parameter (default 0)' }),
    ),
  );
}

/** Colour, and for a profile the bend limits (what the checks enforce for every layer bent from it). */
function stockFields(x: Program, onChange: (patch: Partial<Profile & Fill>) => void): HTMLElement {
  const checker = x.color === CHECKER_COLOR;
  return el('div', { class: 'row fields wrap' },
    el('span', { class: 'lbl' }, 'colour'),
    el('input', { type: 'color', value: checker ? '#bbbbbb' : x.color, title: isProfile(x) ? 'Default colour of layers bent from it (a material overrides it)' : 'Default colour of layers running it (a material overrides it)', onchange: (e: Event) => onChange({ color: (e.target as HTMLInputElement).value }) }),
    !isProfile(x) ? el('label', { class: 'chk', title: 'Show the 100 mm checkerboard instead of a colour (the sheet’s default)' }, el('input', { type: 'checkbox', checked: checker, onchange: (e: Event) => onChange({ color: (e.target as HTMLInputElement).checked ? CHECKER_COLOR : '#d8d8dc' }) }), 'checker') : null,
    !isProfile(x) ? numField('metalness', x.metalness, (v) => onChange({ metalness: Math.max(0, Math.min(1, v)) }), { step: 0.1, min: 0, max: 1, title: '0 = plastic, 1 = metal (a bauble)' }) : null,
    !isProfile(x) ? numField('roughness', x.roughness, (v) => onChange({ roughness: Math.max(0, Math.min(1, v)) }), { step: 0.05, min: 0, max: 1, title: '0 = mirror polish, 1 = dull' }) : null,
    isProfile(x) ? el('span', { class: 'lbl', style: 'margin-left:8px' }, 'limits') : null,
    isProfile(x) ? numField('min bend R', x.limits.minBendRadius, (v) => onChange({ limits: { ...x.limits, minBendRadius: Math.max(0, v) } }), { step: 5, min: 0, title: 'Smallest bend radius, mm (checked on every layer)' }) : null,
    isProfile(x) ? numField('max length', x.limits.maxLength, (v) => onChange({ limits: { ...x.limits, maxLength: Math.max(0, v) } }), { step: 100, min: 0, title: 'Longest piece from stock, mm' }) : null,
  );
}

function projectDetail(x: Program, p: Project): HTMLElement {
  const target = selectionTarget(x);
  const profile = isProfile(x);
  const upd = profile ? 'updateProfile' : 'updateFill';
  const n = profile ? profileUses(p, x.id) : fillUses(p, x.id);
  const last = (profile ? p.profiles : p.fills).length < 2;
  const kind = profile ? 'profile' : 'fill';
  return el('div', {},
    el('h3', {},
      textField(x.label, (v) => void run([upd, x.id, { label: v }]), { class: 'name', placeholder: 'Name' }),
      target ? btn('Use on selection', () => void run(...useCalls(x, x.id)), { class: 'primary', title: profile ? `Bend the first layer of ${target} from it` : `Add a layer running it to ${target}` }) : null,
      btn('Duplicate', () => void run([profile ? 'duplicateProfile' : 'duplicateFill', x.id]).then((id) => { if (typeof id === 'string') select({ what: kind, from: 'project', id }); })),
      btn('Save to library', () => { if (profile) shapeLibrary.save(cloneProfile(x)); else fillLibrary.save(cloneFill(x)); setStatus(`"${x.label}" saved to the library`); }, { title: 'Keep a copy for other projects in this browser' }),
      btn('Remove', () => { if (!last) void run([profile ? 'removeProfile' : 'removeFill', x.id]); }, { class: 'danger', title: last ? `A project keeps at least one ${kind}` : `Remove from the project${n ? ` — ${plural(n, 'layer')} move to the first ${kind}` : ''}` }),
    ),
    meta(['id', x.id], ['kind', profile ? 'profile — along a curve' : 'fill — over a shape'], ['used by', plural(n, 'layer')]),
    stockFields(x, (patch) => void run([upd, x.id, patch])),
    paramsTable(x.params, (next) => void run([upd, x.id, { params: next }])),
  );
}

function draftDetail(x: Program, p: Project | null): HTMLElement {
  const target = selectionTarget(x);
  const key = keyOf(pick!);
  const profile = isProfile(x);
  const kind: Kind = profile ? 'profile' : 'fill';
  const add = async () => {
    const entry = { ...(profile ? cloneProfile(x) : cloneFill(x)), code: codeKey === key ? code.value : x.code };
    const calls: [string, ...unknown[]][] = [[profile ? 'addProfile' : 'addFill', entry]];
    if (target) calls.push(...useCalls(x, '$prev'));
    const id = await run(...calls);
    if (typeof id === 'string') select({ what: kind, from: 'project', id });
    else if (calls.length > 1) render();
  };
  const already = p && (profile ? p.profiles : p.fills).some((y) => y.id === x.id);
  return el('div', {},
    el('h3', {},
      swatchOf(x),
      el('span', { class: 'grow', style: 'font-size:13px' }, x.label),
      p ? btn(target ? 'Add to project & use' : 'Add to project', () => void add(), { class: 'primary', title: `Copy into the project${target ? ` and use it on ${target}` : ''}` }) : null,
      pick!.from === 'library' ? btn('Remove from library', () => (profile ? shapeLibrary : fillLibrary).remove(x.id), { class: 'danger' }) : null,
    ),
    meta(['id', x.id], ['kind', profile ? 'profile — along a curve' : 'fill — over a shape'], ['from', pick!.from === 'preset' ? 'built-in preset' : 'library'], ['limits', profile ? `R ≥ ${x.limits.minBendRadius} mm · ≤ ${x.limits.maxLength} mm` : null], ['', already ? 'already in this project (adding makes a copy)' : null]),
    paramsTable(x.params, (next) => { draftParams.set(key, next); render(); }),
  );
}

/** A new program in the project: the round tube / the sheet preset under a fresh name, opened in the editor. */
async function newProgram(kind: Kind): Promise<void> {
  const p = project();
  if (!p) { setStatus('Open the designer tab first — programs live in its project', true); return; }
  if (kind === 'profile') {
    const { id: _preset, ...rest } = cloneProfile(PRESET_PROFILES.find((e) => e.id === 'round-tube')!);
    const n = p.profiles.length + 1;
    const id = await run(['addProfile', { ...rest, label: `Profile ${n}` }]);
    if (typeof id === 'string') { select({ what: 'profile', from: 'project', id }); setStatus(`"Profile ${n}" added — edit the code below, ⌘⏎ applies it to every layer bent from it`); }
  } else {
    const { id: _preset, ...rest } = cloneFill(PRESET_FILLS.find((e) => e.id === 'sheet')!);
    const n = p.fills.length + 1;
    const id = await run(['addFill', { ...rest, label: `Fill ${n}`, color: '#d8d8dc' }]);
    if (typeof id === 'string') { select({ what: 'fill', from: 'project', id }); setStatus(`"Fill ${n}" added — edit the code below, ⌘⏎ applies it to every layer running it`); }
  }
}

/** A program id from the designer: `fill:<id>` for a fill, a bare id for a profile. */
function pickFromId(id: string): Pick {
  return id.startsWith('fill:') ? { what: 'fill', from: 'project', id: id.slice(5) } : { what: 'profile', from: 'project', id };
}

// -- wiring ------------------------------------------------------------------------------
const wanted = new URLSearchParams(location.search).get('id');
let first = true;
client.onState = () => {
  if (first) { first = false; if (wanted) pick = pickFromId(wanted); }
  render();
};
client.onShow = (id) => { if (id) pick = pickFromId(id); previewKey = ''; render(); window.focus(); };
shapeLibrary.onChange(render);
fillLibrary.onChange(render);
render();
setStatus('Waiting for the designer tab …');
setTimeout(() => { if (!client.connected) setStatus('No designer tab answered — the project section stays empty; presets, library and preview still work'); }, 1500);
await preview.ready;
previewKey = '';
render();

// a number field dragged here is one undo step in the designer (docs/25-number-fields.md §3)
setScrubHooks({
  begin: () => { if (client.connected) void run(['live.begin']); },
  end: () => { if (client.connected) void run(['live.end']); render(); },
});
