/**
 * The object archive (docs/33-object-archive.md): an item is one object with
 * everything under it, saved as a *project of its own* — `migrateProject`
 * reads it whatever version wrote it, and `deco.mjs load` opens it alone.
 * `archiveItem` cuts one out of a project (the object's subtree plus only the
 * profiles, fills, materials, textures and animations it references);
 * `insertItem` brings one in: assets merged by id (reuse an identical one,
 * rename a differing one, never touch what the project has), then the
 * subtree copied through `insertGroup`. Pure over `Project` — no store, no
 * browser — so it runs in the tests, the tab and the bridge alike.
 */
import {
  clone, emptyProject, findGroup, groupOfPlane, groupPlacement, loftsOfGroup, migrateProject, parentOfGroup, shapesOfGroup, slug, subtreeGroups, subtreePlanes, uniqueId,
  type Animation, type Fill, type Id, type Material, type Profile, type Project, type Texture,
} from '../model/types';
import { insertGroup, type InsertResult } from './insert';

/** The block an item file carries beside the project data; every other reader ignores it. */
export interface ItemMeta {
  /** the object to bring in */
  root: Id;
  /** a square PNG data URL, or null */
  thumbnail: string | null;
  tags: string[];
  /** ISO time of the save */
  created: string;
  app: 'deco-designer';
  notes: string;
}

export type ArchiveItem = Project & { item: ItemMeta };

export interface ArchiveOpts {
  /** keep the planes' reference images (docs/19) — off by default, they are tracing scaffolding and megabytes */
  images?: boolean;
  thumbnail?: string | null;
  tags?: string[];
  notes?: string;
  /** the save time (now by default) */
  now?: Date;
}

/** `host.texture('id')` in a material program — the textures it samples (docs/13-material-editor.md). */
const TEXTURE_REF = /(\bhost\s*\.\s*texture\s*\(\s*)(['"])([^'"]+)\2(\s*\))/g;

export function texturesOfMaterial(m: Pick<Material, 'code'>): Id[] {
  const out: Id[] = [];
  for (const hit of m.code.matchAll(TEXTURE_REF)) out.push(hit[3]);
  return out;
}

function retargetMaterial(m: Material, map: Map<Id, Id>): void {
  m.code = m.code.replace(TEXTURE_REF, (all, pre: string, q: string, id: string, post: string) => (map.has(id) && map.get(id) !== id ? `${pre}${q}${map.get(id)}${q}${post}` : all));
}

/** The item's file name in an archive folder: `<slug>.deco.json` (the thumbnail sidecar is `<slug>.png`). */
export const ITEM_EXT = '.deco.json';
export function itemFileName(item: Pick<Project, 'name'>): string { return `${slug(item.name)}${ITEM_EXT}`; }
export function isItemFile(name: string): boolean { return name.toLowerCase().endsWith(ITEM_EXT) || name.toLowerCase().endsWith('.json'); }

/**
 * Cut the object `groupId` out of `project` as an item: its subtree with the
 * assets it references, the root's placement zeroed, the scene left at
 * defaults. Null if there is no such object.
 */
export function archiveItem(project: Project, groupId: Id, opts: ArchiveOpts = {}): ArchiveItem | null {
  const root = findGroup(project, groupId);
  if (!root) return null;
  const groups = subtreeGroups(project, root);
  const planeIds = new Set(subtreePlanes(project, root));
  const planes = project.planes.filter((p) => planeIds.has(p.id)).map((p) => clone(p));
  const curves = project.curves.filter((c) => planeIds.has(c.planeId)).map((c) => clone(c));
  const lofts = loftsOfGroup(project, root).map((l) => clone(l));
  const shapes = shapesOfGroup(project, root).map((sh) => clone(sh));
  if (!opts.images) for (const p of planes) p.image = null;

  // the closure: only what the subtree names (docs/33 §2)
  const profileIds = new Set<Id>(), fillIds = new Set<Id>(), materialIds = new Set<Id>(), animationIds = new Set<Id>(), textureIds = new Set<Id>();
  for (const c of curves) for (const l of c.outline) { profileIds.add(l.profileId); if (l.materialId) materialIds.add(l.materialId); if (l.pixels?.animation) animationIds.add(l.pixels.animation); }
  for (const sh of shapes) for (const l of sh.layers) { fillIds.add(l.fillId); if (l.materialId) materialIds.add(l.materialId); }
  for (const l of lofts) if (l.materialId) materialIds.add(l.materialId);
  for (const p of planes) if (p.image) textureIds.add(p.image.texture);
  const materials = project.materials.filter((m) => materialIds.has(m.id)).map((m) => clone(m));
  const animations = project.animations.filter((a) => animationIds.has(a.id)).map((a) => clone(a));
  for (const m of materials) for (const t of texturesOfMaterial(m)) textureIds.add(t);
  for (const a of animations) textureIds.add(a.texture);
  let profiles = project.profiles.filter((p) => profileIds.has(p.id)).map((p) => clone(p));
  if (!profiles.length && project.profiles[0]) profiles = [clone(project.profiles[0])];   // `migrateProject` wants one
  const fills = project.fills.filter((f) => fillIds.has(f.id)).map((f) => clone(f));
  const textures = project.textures.filter((t) => textureIds.has(t.id)).map((t) => clone(t));

  const out = emptyProject(root.name, profiles, fills) as ArchiveItem;
  out.planes = planes; out.curves = curves; out.lofts = lofts; out.shapes = shapes;
  out.groups = groups.map((g) => clone(g));
  out.groups[0].placement = groupPlacement();   // an item lands where it is put (§4.3)
  out.materials = materials; out.textures = textures; out.animations = animations;
  out.item = { root: root.id, thumbnail: opts.thumbnail ?? null, tags: opts.tags ?? [], created: (opts.now ?? new Date()).toISOString(), app: 'deco-designer', notes: opts.notes ?? '' };
  return out;
}

/**
 * The whole working file as one item (docs/33 §13, topbar *Export*): everything in the project under one root
 * object, so *Insert* / *Import* brings the work in as a single object. A project with exactly one root object and
 * no loose planes exports that object; otherwise a new object named after the project is added on top, enclosing
 * every root object and every plane outside any object (their world positions unchanged — the wrapper sits at the
 * origin). Reference images stay in (it is the working file), and the cameras, post script and clock ride along so
 * the file also opens on its own as the work it was. Null when there is nothing to export. `project` is not touched.
 */
export function exportProject(project: Project, opts: ArchiveOpts = {}): ArchiveItem | null {
  const p = clone(project);
  const roots = p.groups.filter((g) => !parentOfGroup(p, g.id));
  const loose = p.planes.filter((pl) => !groupOfPlane(p, pl.id)).map((pl) => pl.id);
  if (!roots.length && !loose.length) return null;
  let rootId: Id;
  if (roots.length === 1 && !loose.length) rootId = roots[0].id;
  else {
    const name = p.name.trim() || 'Project';
    rootId = uniqueId(slug(name) || 'project', p.groups.map((g) => g.id));
    p.groups.push({ id: rootId, name, planes: loose, groups: roots.map((g) => g.id), placement: groupPlacement(), visible: true });
  }
  const item = archiveItem(p, rootId, { images: true, ...opts });
  if (!item) return null;
  item.name = p.name;
  item.cameras = clone(p.cameras); item.activeCamera = p.activeCamera; item.post = clone(p.post); item.playback = clone(p.playback);
  return item;
}

/** Read a file's contents as an item at the current version — any earlier part's file comes through — or null. */
export function readItem(raw: unknown): ArchiveItem | null {
  const p = migrateProject(clone(raw));
  if (!p) return null;
  const meta = (p as Partial<ArchiveItem>).item;
  const roots = p.groups.filter((g) => !parentOfGroup(p, g.id));
  const root = (meta && findGroup(p, meta.root)) ? meta.root : roots[0]?.id;
  if (!root) return null;
  const item = p as ArchiveItem;
  item.item = { root, thumbnail: typeof meta?.thumbnail === 'string' ? meta.thumbnail : null, tags: Array.isArray(meta?.tags) ? meta!.tags.filter((t): t is string => typeof t === 'string') : [], created: typeof meta?.created === 'string' ? meta.created : '', app: 'deco-designer', notes: typeof meta?.notes === 'string' ? meta.notes : '' };
  return item;
}

// -- merging assets ------------------------------------------------------------

/** JSON with sorted keys and the bookkeeping fields out, so two assets compare by what they do. */
const IGNORED = new Set(['name', 'label', 'source', 'warnings']);
function fingerprint(v: unknown): string {
  const walk = (x: unknown, top: boolean): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, false));
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).filter((k) => !(top && IGNORED.has(k))).sort().map((k) => [k, walk((x as Record<string, unknown>)[k], false)]));
    return x;
  };
  return JSON.stringify(walk(v, true));
}

/**
 * Merge `incoming` into `have` by id: a free id is added, an identical one is
 * reused, a differing one is added under a fresh id. Returns old id → id in
 * `have`. Nothing already in `have` changes.
 */
export function mergeAssets<T extends { id: Id }>(have: T[], incoming: T[]): Map<Id, Id> {
  const map = new Map<Id, Id>();
  for (const e of incoming) {
    const t = have.find((x) => x.id === e.id);
    if (!t) { have.push(clone(e)); map.set(e.id, e.id); continue; }
    if (fingerprint(t) === fingerprint(e)) { map.set(e.id, t.id); continue; }
    const nid = uniqueId(e.id, have.map((x) => x.id));
    have.push({ ...clone(e), id: nid });
    map.set(e.id, nid);
  }
  return map;
}

const at = (map: Map<Id, Id>, id: Id): Id => map.get(id) ?? id;

/**
 * Bring the item's assets into `target` and point the item's own references
 * at them — textures first, since materials and animations name them.
 */
export function mergeItemAssets(target: Project, item: Project): { profiles: Map<Id, Id>; fills: Map<Id, Id>; materials: Map<Id, Id>; textures: Map<Id, Id>; animations: Map<Id, Id> } {
  const textures = mergeAssets<Texture>(target.textures, item.textures);
  for (const m of item.materials) retargetMaterial(m, textures);
  for (const a of item.animations) a.texture = at(textures, a.texture);
  for (const p of item.planes) if (p.image) p.image.texture = at(textures, p.image.texture);
  const materials = mergeAssets<Material>(target.materials, item.materials);
  const animations = mergeAssets<Animation>(target.animations, item.animations);
  const profiles = mergeAssets<Profile>(target.profiles, item.profiles);
  const fills = mergeAssets<Fill>(target.fills, item.fills);
  for (const c of item.curves) for (const l of c.outline) {
    l.profileId = at(profiles, l.profileId);
    if (l.materialId) l.materialId = at(materials, l.materialId);
    if (l.pixels?.animation) l.pixels.animation = at(animations, l.pixels.animation);
  }
  for (const sh of item.shapes) for (const l of sh.layers) { l.fillId = at(fills, l.fillId); if (l.materialId) l.materialId = at(materials, l.materialId); }
  for (const l of item.lofts) if (l.materialId) l.materialId = at(materials, l.materialId);
  return { profiles, fills, materials, textures, animations };
}

/** A name no object in the project has yet: `Chelsy 250`, `Chelsy 250 2`, … */
function freeName(project: Project, name: string): string {
  const taken = new Set(project.groups.map((g) => g.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

/**
 * Insert an item (raw file contents) into `target`, which is mutated: assets
 * merged, the subtree copied with fresh ids, the root parented to `into` (or
 * a root object). The target's cameras, world, post and playback are left
 * alone. Null if the file is not an item.
 */
export function insertItem(target: Project, raw: unknown, opts: { into?: Id | null } = {}): InsertResult | null {
  const item = readItem(raw);
  if (!item) return null;
  mergeItemAssets(target, item);
  const root = findGroup(item, item.item.root)!;
  root.placement = groupPlacement();   // it lands at its parent's origin (§5.4)
  return insertGroup(target, item, root.id, { into: opts.into ?? null, name: freeName(target, root.name) });
}
