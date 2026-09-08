/**
 * Compact text views of the project for agents and scripts (docs/07-agent-bridge.md).
 * Pure: reads the store, returns strings.
 */
import type { Store } from './store';
import { childGroups, findPlane, fixturesOf, loftEdge, loftsOwnedBy, shapesOwnedBy, parentOfGroup, paramsOf, pixelCount, planeOf, playbackRange, profileOf, type CurveObject, type CurvePixels, type Id, type Loft, type ObjectGroup, type OutlineLayer, type Plane, type Shape, type Vec2, type Vec3 } from '../model/types';
import { describeProfile } from '../model/profiles';
import { describeFill } from '../model/fills';
import { activeCameraOf, describeCamera } from '../model/camera';
import { describeWorld, isHdrMime } from '../model/world';
import { curveBounds, zRange } from '../geometry/curve';
import { handlesOf } from '../model/handles';

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const v2 = (p: Vec2) => `(${n(p.x)}, ${n(p.y)})`;
const v3 = (p: Vec3) => `(${n(p.x)}, ${n(p.y)}, ${n(p.z)})`;

function planeLine(pl: Plane): string {
  const { placement: pm, array } = pl;
  const rot = pm.preset === 'custom' ? ` rot ${v3(pm.rotation)}` : '';
  const arr = !array ? '' : array.type === 'linear' ? ` · linear ×${array.count} Δ${v3(array.offset)}` : ` · circular ×${array.count} ${n(array.angle)}° @ ${v3(array.center)} axis ${v3(array.axis)}`;
  return `▤ ${pl.name} [${pl.id}] · ${pm.preset} @ ${v3(pm.position)}${rot}${arr}`;
}

function curveLine(store: Store, c: CurveObject): string {
  const ev = store.evals.get(c.id);
  const pts = c.curve.points;
  const b = curveBounds(pts);
  const spatial = c.type === 'spatial';
  const z = spatial && pts.length ? zRange(pts) : null;
  const extent = pts.length ? ` · x ${n(b.min.x)}..${n(b.max.x)} y ${n(b.min.y)}..${n(b.max.y)}${z ? ` z ${n(z.min)}..${n(z.max)}` : ''}` : '';
  const len = ev ? ` · ${n(Math.round(ev.sampling.length))} mm` : '';
  const cons = c.constraints.length ? ` · ${c.constraints.length} constraints` : '';
  const viol = !ev || !ev.violations.length ? ' · ok' : ` · ✗ ${ev.violations[0].message}${ev.violations.length > 1 ? ` (+${ev.violations.length - 1})` : ''}`;
  const outline = c.outline.length ? `outline: ${c.outline.map(layerText).join(' · ')}` : 'no outline (construction line)';
  return `○ ${c.name} [${c.id}] · ${outline}${spatial ? ' · 3D' : ''} · ${pts.length} pts ${c.curve.closed ? 'closed' : 'open'}${len}${extent}${cons}${viol}`;
}

const pixelsText = (px: CurvePixels) => `✦ ${pixelCount(px)} px${px.animation ? ` ${px.animation}@${px.offset}` : ' unpatched'}${px.reverse ? ' reversed' : ''}`;

/** One outline layer in a few words: profile, side offset / lift, fixture, overrides (docs/30 §3). */
function layerText(l: OutlineLayer): string {
  const bits = [l.profileId, l.offset ? `${l.offset > 0 ? '+' : ''}${n(l.offset)}` : '', l.lift ? `lift ${n(l.lift)}` : '', l.materialId ? `material ${l.materialId}` : '', l.color ? `colour ${l.color}` : '', l.pixels ? pixelsText(l.pixels) : '', Object.keys(l.params).length ? `params ${JSON.stringify(l.params)}` : '', l.visible ? '' : 'hidden'];
  return bits.filter(Boolean).join(' ');
}

/** Trim / offset of one loft edge, printed only when it is set (docs/24-loft-trim.md). */
const edgeText = (l: Loft, which: 'a' | 'b') => {
  const e = loftEdge(l, which);
  const bits = [e.start || e.end ? `trim ${n(e.start)}/${n(e.end)}` : '', e.offset ? `offset ${n(e.offset)}` : '', e.lift ? `lift ${n(e.lift)}` : ''].filter(Boolean);
  return bits.length ? ` · ${which.toUpperCase()} ${bits.join(' ')}` : '';
};
const loftLine = (l: Loft) => `◇ ${l.name} [${l.id}] · ${l.a} ↔ ${l.b} · res ${l.resolution} · strips ${l.strips}${l.flip ? ' · flipped' : ''}${edgeText(l, 'a')}${edgeText(l, 'b')}${l.materialId ? ` · material ${l.materialId}` : ''}`;

/** A shape over curves with its fill layers (docs/30-outline-and-shape-layers.md §4). */
const shapeLine = (sh: Shape) => {
  const layers = sh.layers.map((l) => [l.fillId, l.offset ? `offset ${n(l.offset)}` : '', l.materialId ? `material ${l.materialId}` : '', l.color ? `colour ${l.color}` : '', Object.keys(l.params).length ? `params ${JSON.stringify(l.params)}` : '', l.visible ? '' : 'hidden'].filter(Boolean).join(' '));
  return `▱ ${sh.name} [${sh.id}] · ${sh.curves.join(', ')}${sh.expand ? ` · expand ${n(sh.expand)}` : ''} · res ${sh.resolution} · layers: ${layers.length ? layers.join(' · ') : 'none'}`;
};

/** One-screen tree of the whole project: objects ▣, planes ▤, curves ○, lofts ◇, shapes ▱, with lengths, extents and violations. */
export function overview(store: Store): string {
  const { project: p, mode, selection } = store.state;
  const sel = selection.groups.length ? `object${selection.groups.length > 1 ? 's' : ''} ${selection.groups.join(', ')}` : selection.loftId ? `loft ${selection.loftId}` : selection.shapeId ? `shape ${selection.shapeId}` : selection.curves.length ? `curves ${selection.curves.join(', ')}` : selection.planeSelected ? `plane ${selection.planeId}` : 'nothing';
  const lines = [
    `Project "${p.name}" · ${p.planes.length} planes · ${p.curves.length} curves · ${p.lofts.length} lofts · ${p.shapes.length} shapes · ${p.groups.length} objects · ${mode.kind === 'edit' ? `EDIT ${mode.curveId}` : 'OBJECT'} mode · selected: ${sel}`,
    `Profiles: ${p.profiles.map((pr) => `${pr.id} "${pr.label}" ${describeProfile(pr)} (R ≥ ${pr.limits.minBendRadius}, ≤ ${pr.limits.maxLength} mm)`).join(' · ')}`,
    `Fills: ${p.fills.length ? p.fills.map((f) => `${f.id} "${f.label}" ${describeFill(f)}`).join(' · ') : 'none'}`,
  ];
  const plane = (pl: Plane, ind: string) => {
    lines.push(ind + planeLine(pl));
    for (const c of p.curves) if (c.planeId === pl.id) lines.push(`${ind}  ${curveLine(store, c)}`);
  };
  const grouped = new Set<Id>(), groupedLofts = new Set<Id>(), groupedShapes = new Set<Id>();
  // objects nest (docs/18-nested-objects.md): each one prints its child objects, then its planes and its own lofts
  const group = (g: ObjectGroup, ind: string) => {
    const pos = g.placement.position, rot = g.placement.rotation;
    const at = pos.x || pos.y || pos.z ? ` at ${v3(pos)}` : '';
    const turned = rot.x || rot.y || rot.z ? ` rot ${v3(rot)}°` : '';
    lines.push(`${ind}▣ ${g.name} [${g.id}]${at}${turned}${g.visible ? '' : ' · hidden'}`);
    for (const c of childGroups(p, g)) group(c, `${ind}  `);
    for (const id of g.planes) { const pl = findPlane(p, id); if (pl) { plane(pl, `${ind}  `); grouped.add(id); } }
    for (const l of loftsOwnedBy(p, g)) { lines.push(`${ind}  ${loftLine(l)}`); groupedLofts.add(l.id); }
    for (const sh of shapesOwnedBy(p, g)) { lines.push(`${ind}  ${shapeLine(sh)}`); groupedShapes.add(sh.id); }
  };
  for (const g of p.groups) if (!parentOfGroup(p, g.id)) group(g, '');
  for (const pl of p.planes) if (!grouped.has(pl.id)) plane(pl, '');
  for (const l of p.lofts) if (!groupedLofts.has(l.id)) lines.push(loftLine(l));
  for (const sh of p.shapes) if (!groupedShapes.has(sh.id)) lines.push(shapeLine(sh));
  if (p.materials.length) lines.push(`Materials: ${p.materials.map((m) => `${m.id} "${m.name}"${m.warnings.length ? ` (${m.warnings.length} ⚠)` : ''}`).join(' · ')}`);
  // the world is the camera's (docs/36-camera-world.md): every camera's on its line, the active one's spelled out
  lines.push(`Cameras: ${p.cameras.map((c) => `${c.id === p.activeCamera ? '◉ ' : ''}${c.id} "${c.name}" ${describeCamera(c)}`).join(' · ')}`);
  lines.push(`World (${p.activeCamera}): ${describeWorld(activeCameraOf(p).world, p)}`);
  lines.push(`Post: "${p.post.label}" ${p.post.enabled ? 'on' : 'off'}${Object.keys(p.post.params).length ? ` (${Object.entries(p.post.params).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`);
  if (p.animations.length) {
    const fixtures = (id: string) => fixturesOf(p).filter(({ layer }) => layer.pixels!.animation === id).length;
    lines.push(`Animations: ${p.animations.map((a) => `${a.id} "${a.name}" ${a.width}×${a.frames} @ ${a.fps} fps · ${fixtures(a.id)} patched`).join(' · ')}`);
    const { start, end } = playbackRange(p);
    lines.push(`Clock: ${p.playback.playing ? 'playing' : 'held'} · in ${start.toFixed(2)} s · out ${end.toFixed(2)} s${p.playback.end == null ? ' (auto)' : ''} · ${p.playback.loop ? 'loop' : 'hold at out'}`);
  }
  if (p.textures.length) lines.push(`Textures: ${p.textures.map((t) => `${t.id} "${t.name}" ${t.width}×${t.height}${isHdrMime(t.mime) ? ' HDR' : ''}`).join(' · ')}`);
  if (!p.planes.length) lines.push('(empty project)');
  return lines.join('\n');
}

/** Everything about one curve: vertices with ids and handles, constraints, violations. */
export function describeCurve(store: Store, id: Id): string {
  const c = store.project.curves.find((x) => x.id === id);
  if (!c) return `no curve "${id}"`;
  const pl = planeOf(store.project, c);
  const ev = store.evals.get(c.id);
  const spatial = c.type === 'spatial';
  const fmt = spatial ? v3 : v2;   // 3D curves print (x, y, z): z = offset along the plane normal
  const lines = [`${curveLine(store, c)}`, `  plane ${pl.name} [${pl.id}]${spatial ? ' · 3D: z = offset along the plane normal' : ''}`];
  // the outline layer by layer (docs/30 §3): profile, effective params, the layer's own length and violations
  c.outline.forEach((l, i) => {
    const pr = profileOf(store.project, l);
    const le = ev?.layers[i];
    const own = le && le.curve !== c.curve ? ` · ${n(Math.round(le.sampling.length))} mm on its own curve` : '';
    const viol = le?.violations.length ? ` · ✗ ${le.violations.map((v) => v.message).join(', ')}` : '';
    lines.push(`  ▤ layer ${i} [${l.id}] · ${pr.id} "${pr.label}" ${describeFill({ params: paramsOf(pr, l) } as Parameters<typeof describeFill>[0])} · offset ${n(l.offset)} · lift ${n(l.lift)}${l.materialId ? ` · material ${l.materialId}` : ''}${l.pixels ? ` · ${pixelsText(l.pixels)}` : ''}${l.visible ? '' : ' · hidden'}${own}${viol}`);
  });
  c.curve.points.forEach((v, i) => {
    const h = handlesOf(c.curve.points, c.curve.closed, i);
    const hs = v.type === 'polygon' ? '' : ` in ${fmt(h.in)} out ${fmt(h.out)}`;
    lines.push(`  #${i} [${v.id}] ${fmt(v)} ${v.type}${hs}`);
  });
  for (const k of c.constraints) {
    const ok = ev?.constraints.get(k.id);
    lines.push(`  ⊢ [${k.id}] ${k.type} ${k.a}${k.b ? ` ↔ ${k.b}` : ''}${k.value != null ? ` = ${n(k.value)}` : ''}${k.at ? ` @ ${fmt(k.at)}` : ''} ${ok === false ? '✗' : '✓'}`);
  }
  for (const v of ev?.violations ?? []) lines.push(`  ✗ ${v.check}: ${v.message}${v.span ? ` @ ${n(v.span[0])}–${n(v.span[1])} mm` : ''}${v.layer ? ` (layer ${v.layer})` : ''}`);
  return lines.join('\n');
}
