/**
 * Part 1 data model (docs/01-curve-editor.md). Plain data, no three.js, no DOM.
 * All lengths in millimetres, angles in degrees.
 */
import { profileFromLegacy, upgradeLedCode } from './profiles';
import { SHEET_FILL } from './fills';
import { autoHandles } from './handles';
import { normalizeCamera } from './camera';
import { defaultPost, EEVEE_V15 } from './post-presets';
import { defaultPlayback, normalizeAnimation, normalizePixels, normalizePlayback, normalizeWorld } from './world';

export type Id = string;
export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

// -- profiles -------------------------------------------------------------

/** Limitations that apply to every curve bent from the profile. */
export interface ProfileLimits {
  /** Smallest bend radius (to the curve centre line). */
  minBendRadius: number;
  /** Longest piece available from stock. */
  maxLength: number;
}

/**
 * The stock a curve is bent from — a shape program (docs/14-shapes.md):
 * `code` is `(three, curve, params) => BufferGeometry` (uv in mm), `params`
 * its parameters with defaults (a curve may override them), `limits` what
 * the checks enforce for every curve bent from it.
 */
export interface Profile {
  id: Id;
  label: string;
  code: string;
  params: Record<string, number>;
  color: string;
  limits: ProfileLimits;
}

// -- placement -------------------------------------------------------------

export type PlanePreset = 'front' | 'top' | 'side';

export interface Placement {
  preset: PlanePreset | 'custom';
  position: Vec3;
  rotation: Vec3;
}

export const PLANE_PRESETS: Record<PlanePreset, { label: string; rotation: Vec3 }> = {
  front: { label: 'Front (XY)', rotation: { x: 0, y: 0, z: 0 } },
  top: { label: 'Top (XZ)', rotation: { x: -90, y: 0, z: 0 } },
  side: { label: 'Side (YZ)', rotation: { x: 0, y: 90, z: 0 } },
};

export function placementFor(preset: PlanePreset, position: Vec3 = { x: 0, y: 0, z: 0 }): Placement {
  return { preset, position: { ...position }, rotation: { ...PLANE_PRESETS[preset].rotation } };
}

// -- objects ---------------------------------------------------------------

export type VertexType = 'polygon' | 'equal' | 'free';

/**
 * A curve vertex with Bézier handles (relative to the vertex). `x, y` are
 * plane coordinates, `z` the offset along the plane normal (docs/12-3d-curves.md;
 * always 0 on a planar curve). Types (docs/27-vertex-types.md):
 *   polygon: handles ignored — straight segments (the default)
 *   equal:   in/out kept collinear, lengths independent
 *   free:    in/out independent
 */
export interface Vertex extends Vec3 {
  id: Id;
  type: VertexType;
  in: Vec3;
  out: Vec3;
}

export interface Curve {
  points: Vertex[];
  closed: boolean;
}

/** planar: drawn in 2D on the plane (z = 0) · spatial: vertices may leave the plane along its normal. */
export type CurveType = 'planar' | 'spatial';

export type ConstraintType = 'horizontal' | 'vertical' | 'distance' | 'pin';

/** A relation between vertices of one object that is kept true when anything moves. */
export interface VertexConstraint {
  id: Id;
  type: ConstraintType;
  a: Id;
  /** second vertex (not for pin) */
  b?: Id;
  /** distance in mm (3D on a spatial curve) */
  value?: number;
  /** pinned position (plane coordinates + normal offset) */
  at?: Vec3;
}

/**
 * Repeats everything on a plane (docs/26-array.md). Linear steps by `offset`,
 * circular turns about the **line** (`center`, `axis`) — both plane-local mm,
 * `z` along the plane normal; `axis` is a direction, its length is ignored
 * ({ 0, 0, 1 } = the plane normal, so the copies stay in the plane).
 */
export type ArrayModifier =
  | { type: 'linear'; count: number; /** plane-local offset per copy (x, y in plane, z along normal) */ offset: Vec3 }
  | { type: 'circular'; count: number; /** plane-local point the axis runs through */ center: Vec3; /** plane-local axis direction ("up") */ axis: Vec3; /** total angle covered, degrees */ angle: number };

/** Read an array modifier of any earlier part: a circular one gains the axis and a 3D centre. */
export function normalizeArray(raw: unknown): ArrayModifier | null {
  const a = raw as (ArrayModifier & { center?: Partial<Vec3>; axis?: Partial<Vec3> }) | null | undefined;
  if (!a || (a.type !== 'linear' && a.type !== 'circular')) return null;
  const count = Math.max(1, Math.round(a.count || 1));
  if (a.type === 'linear') return { type: 'linear', count, offset: v3(a.offset) };
  const axis = v3(a.axis ?? { z: 1 });
  return {
    type: 'circular', count, angle: a.angle ?? 360,
    center: v3(a.center),
    axis: axis.x || axis.y || axis.z ? axis : { x: 0, y: 0, z: 1 },
  };
}

/**
 * A reference image lying on a plane (docs/19-reference-image.md): a scan of a
 * drawing to trace shapes over. `locked` is the normal state while drawing —
 * a locked image is never picked, dragged or selected.
 */
export interface PlaneImage {
  /** a project texture (image/…) */
  texture: Id;
  /** centre in plane-local mm */
  center: Vec2;
  /** width in mm; the height follows the image's pixel aspect */
  width: number;
  /** turn in the plane, degrees */
  rotation: number;
  /** 0..1 */
  opacity: number;
  visible: boolean;
  locked: boolean;
}

/** A shared drawing surface: placement in 3D plus the array modifier that repeats everything on it. */
export interface Plane {
  id: Id;
  name: string;
  placement: Placement;
  array: ArrayModifier | null;
  /** the drawing traced on this plane (docs/19-reference-image.md), null = none */
  image: PlaneImage | null;
}

/** One curve object: one profile, one vertex list, its own constraints, on one plane. */
/** How many pixels one daisy-chained LED chain carries (docs/17-emitters.md). */
export const PIXELS_PER_CHAIN = 80;

/**
 * A curve driven as an LED fixture (docs/17-emitters.md): 1–3 daisy-chained chains of
 * `PIXELS_PER_CHAIN` pixels, patched to an animation map at column `offset`. Pixel i is the
 * i-th lamp along the curve (`reverse` counts from the other end); lamps past the pixel
 * count stay dark, pixels past the lamps light nothing.
 */
export interface CurvePixels {
  chains: number;
  /** the animation map it plays; null = the lamps keep the shape's own colour */
  animation: Id | null;
  /** column of the map its first pixel reads */
  offset: number;
  reverse: boolean;
}

/**
 * One layer of a curve's outline (docs/30-outline-and-shape-layers.md §3): a profile program
 * run along the curve moved `offset` mm sideways in the plane (+ = outside on a closed curve,
 * the left-hand side of travel on an open one — the offset tool's rule, docs/29 §2) and lifted
 * `lift` mm along the plane normal, with its own params, material and fixture.
 */
export interface OutlineLayer {
  id: Id;
  profileId: Id;
  /** per-layer overrides of the profile's params (docs/14-shapes.md) */
  params: Record<string, number>;
  /** project material (null = the colour below) */
  materialId: Id | null;
  /** the layer's own colour without a material; null = the profile's */
  color: string | null;
  /** mm across the curve in its plane; 0 = on the line */
  offset: number;
  /** mm along the plane normal; 0 = on the line */
  lift: number;
  /** driven as an LED fixture (docs/17-emitters.md); null = not patched */
  pixels: CurvePixels | null;
  visible: boolean;
}

export interface CurveObject {
  id: Id;
  name: string;
  planeId: Id;
  /** planar (2D on the plane) or spatial (3D: plane + offsets along the normal) — docs/12-3d-curves.md */
  type: CurveType;
  curve: Curve;
  constraints: VertexConstraint[];
  /** the profile stack along the line, bottom first; empty = a construction line (docs/30 §1) */
  outline: OutlineLayer[];
}

/** A stored (or agent-written) outline layer made safe (`profiles` decides whether the profile exists; an unknown one takes the first). */
export function normalizeOutlineLayer(raw: Partial<OutlineLayer> & { id: Id }, profiles: { id: Id }[]): OutlineLayer {
  const profileId = profiles.some((p) => p.id === raw.profileId) ? raw.profileId! : profiles[0]?.id ?? String(raw.profileId ?? '');
  return { id: raw.id, profileId, params: numMap(raw.params), materialId: raw.materialId ?? null, color: hexOr(raw.color), offset: numOr(raw.offset), lift: numOr(raw.lift), pixels: raw.pixels ? normalizePixels(raw.pixels) : null, visible: raw.visible !== false };
}

/** A fresh outline layer on the line: no offset, no lift, no overrides. */
export function newOutlineLayer(profileId: Id, taken: Iterable<Id>, base = 'layer'): OutlineLayer {
  return { id: uniqueId(base, taken), profileId, params: {}, materialId: null, color: null, offset: 0, lift: 0, pixels: null, visible: true };
}

/** A fresh shape layer on the surface. */
export function newShapeLayer(fillId: Id, taken: Iterable<Id>, base = 'layer'): ShapeLayer {
  return { id: uniqueId(base, taken), fillId, params: {}, materialId: null, color: null, offset: 0, visible: true };
}

/**
 * A surface material: TSL source `(tsl, host) => MeshPhysicalNodeMaterial`
 * (docs/09-blender-import.md), kept in the project so a file is self-contained.
 */
export interface Material {
  id: Id;
  name: string;
  code: string;
  /** where it came from, e.g. the .blend file name */
  source: string;
  /** what was not converted 1:1 */
  warnings: string[];
}

/**
 * An image a material samples through `host.texture(id)` (docs/13-material-editor.md),
 * kept in the project (base64) so a file is self-contained.
 */
export interface Texture {
  id: Id;
  name: string;
  /** image/png, image/jpeg, image/webp — or an HDR for worlds (docs/16-world.md): image/vnd.radiance (.hdr), image/x-exr (.exr) */
  mime: string;
  /** data URL of the image */
  data: string;
  width: number;
  height: number;
  /** where it came from, e.g. the file name or the .blend */
  source: string;
}

/**
 * A pixel animation (docs/17-emitters.md): a PNG project texture read as a map where
 * **x = LED id** and **y = frame** (row 0 first), played at `fps`.
 */
export interface Animation {
  id: Id;
  name: string;
  /** the PNG texture it reads */
  texture: Id;
  fps: number;
  /** rows of the map = frames (0 until the image is measured) */
  frames: number;
  /** columns of the map = LED ids */
  width: number;
}

/** The project's one playback clock (docs/17-emitters.md, docs/22-transport-in-out.md); the current time is viewer state, not project data. */
export interface Playback {
  playing: boolean;
  /** the clock wraps in [start, end]; off, it runs to `end` and holds */
  loop: boolean;
  /** the clock's range in seconds (docs/22-transport-in-out.md) */
  start: number;
  /** null = as long as the longest map any fixture is patched to */
  end: number | null;
}

/**
 * The clock's range in seconds (docs/22-transport-in-out.md): what the transport's
 * in / out say, with `end: null` meaning the longest map any fixture is patched to.
 */
export function playbackRange(p: Project): { start: number; end: number } {
  const { start, end } = p.playback;
  if (end != null) return { start, end: Math.max(start + 0.01, end) };
  const seconds = (a: Animation) => Math.max(1, a.frames) / Math.max(0.01, a.fps);
  let longest = 0;
  for (const { layer } of fixturesOf(p)) {
    const a = findAnimation(p, layer.pixels!.animation);
    if (a) longest = Math.max(longest, seconds(a));
  }
  // nothing patched yet: the longest map in the project, so play does something before patching
  if (!longest) for (const a of p.animations) longest = Math.max(longest, seconds(a));
  return { start, end: Math.max(start + 0.01, longest || 1) };
}

/**
 * One edge of a loft, pre-trimmed before the surface is built (docs/24-loft-trim.md).
 * All millimetres, all zero = the whole curve as drawn.
 */
export interface LoftEdge {
  /** cut off the start of the curve (the first vertex); negative = go past it, straight along the end tangent */
  start: number;
  /** cut off the end of the curve; negative = go past it */
  end: number;
  /** move the edge across the ruling, in the surface: + = outwards (away from the other curve), - = inwards */
  offset: number;
  /** move the edge along the loft's own normal, out of the surface: + = out of its front, - = behind */
  lift: number;
}

export const NO_LOFT_EDGE: LoftEdge = { start: 0, end: 0, offset: 0, lift: 0 };

const mm = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export function normalizeLoftEdge(e: Partial<LoftEdge> | null | undefined): LoftEdge {
  return { start: mm(e?.start), end: mm(e?.end), offset: mm(e?.offset), lift: mm(e?.lift) };
}

/** The trim / offset of curve `a` or `b` of a loft (older files and bare literals have none). */
export function loftEdge(l: Loft, which: 'a' | 'b'): LoftEdge {
  return normalizeLoftEdge(which === 'a' ? l.edgeA : l.edgeB);
}

/** A surface between two curves, resampled and gridded (checkerboard). */
export interface Loft {
  id: Id;
  name: string;
  a: Id;
  b: Id;
  /** project material (null = checkerboard) */
  materialId: Id | null;
  /** samples along = resolution × max(vertex count of a, b) */
  resolution: number;
  /** rows across the band */
  strips: number;
  /** reverse curve b (overrides the automatic direction choice) */
  flip: boolean;
  /** trim / offset of curve a before lofting (docs/24-loft-trim.md; absent on older files = none) */
  edgeA?: LoftEdge;
  /** trim / offset of curve b before lofting */
  edgeB?: LoftEdge;
}

/**
 * A flat sheet filling one curve (docs/28-panel-surface.md): the boundary is the curve as
 * drawn (an open one is closed by the segment back to its first vertex), moved `offset` mm
 * along the plane normal and grown `expand` mm in the plane.
 */
export interface Shape {
  id: Id;
  name: string;
  /** the curves whose loops it fills — all on one plane (the first curve's); loops nest even-odd, so a curve inside another is a hole */
  curves: Id[];
  /** mm in the plane: + every loop bigger than its curve, - smaller (0 = exactly on it) */
  expand: number;
  /** boundary samples per curve segment = 4 x resolution; every vertex is always on the boundary */
  resolution: number;
  /** the fill stack, bottom first */
  layers: ShapeLayer[];
}

/**
 * One layer of a shape (docs/30 §4): a fill program run over the surface, with its own params,
 * material and lift along the plane normal.
 */
export interface ShapeLayer {
  id: Id;
  fillId: Id;
  /** per-layer overrides of the fill's params */
  params: Record<string, number>;
  /** project material (null = the colour below) */
  materialId: Id | null;
  /** the layer's own colour without a material; null = the fill's (the colour `checker` = the 100 mm board) */
  color: string | null;
  /** mm along the plane normal: + in front of the curves, - behind them */
  offset: number;
  visible: boolean;
}

/**
 * A fill: a program over a surface (docs/30-outline-and-shape-layers.md §4) —
 * `(three, surface, params) => BufferGeometry` in plane-local mm — with its params, and the
 * colour it shows without a material (`checker` = the 100 mm checkerboard).
 */
export interface Fill {
  id: Id;
  label: string;
  code: string;
  params: Record<string, number>;
  color: string;
  /** the default look without a material: 0 = matte plastic … 1 = polished metal (a Christmas bauble) */
  metalness: number;
  roughness: number;
}

const numOr = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** a #rrggbb colour, or null */
const hexOr = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return out;
};

/** A stored (or agent-written) shape layer made safe. */
export function normalizeShapeLayer(raw: Partial<ShapeLayer> & { id: Id; fillId: Id }): ShapeLayer {
  return { id: raw.id, fillId: raw.fillId, params: numMap(raw.params), materialId: raw.materialId ?? null, color: hexOr(raw.color), offset: numOr(raw.offset), visible: raw.visible !== false };
}

/** A stored (or agent-written) shape made safe (its layers too). */
export function normalizeShape(raw: Partial<Shape> & { id: Id }): Shape {
  const layers = (raw.layers ?? []).filter((l) => l && l.id && l.fillId).map((l) => normalizeShapeLayer(l));
  return { id: raw.id, name: raw.name ?? raw.id, curves: [...new Set((raw.curves ?? []).filter((c) => typeof c === 'string'))], expand: numOr(raw.expand), resolution: Math.max(0.25, numOr(raw.resolution, 2)), layers };
}

/**
 * An object: a group of planes and of other objects (docs/18-nested-objects.md). The curves on
 * those planes and the lofts between them come along. Everything inside is placed **relative to
 * `placement`**, which is rigid (position + rotation, never a scale — see docs/18 §5.2).
 */
export interface ObjectGroup {
  id: Id;
  name: string;
  planes: Id[];
  /** child objects; an object has at most one parent and can never be its own ancestor */
  groups: Id[];
  /** the object's own frame, in its parent's coordinates */
  placement: Placement;
  /** hidden objects are left out of the viewport, the emitter bake and picking (checks still run) */
  visible: boolean;
}

/** Film back (sensor) size in mm — docs/15-camera.md. */
export interface FilmBack { width: number; height: number }
export interface CameraSettings {
  filmBack: FilmBack;
  /** lens focal length, mm */
  focalLength: number;
  dof: { enabled: boolean; /** mm along the view direction */ focusDistance: number; fStop: number };
  /** the camera frame in the viewport (Blender's passepartout): the film-back aspect outlined, the outside darkened by `passepartout` (0..1) */
  frame: { show: boolean; passepartout: number };
}

export interface CameraPose { position: Vec3; target: Vec3 }
/**
 * A camera object (docs/15-camera.md): settings plus where it stands. Several per project; `activeCamera` is looked
 * through. `world` (docs/16-world.md, docs/36-camera-world.md) is the camera's background / lighting — every camera
 * carries one; the viewport shows the active camera's.
 */
export interface Camera extends CameraSettings { id: Id; name: string; pose: CameraPose; world: World }

// -- world (docs/16-world.md) -------------------------------------------------

/** What the camera sees behind the objects: a colour, or an equirectangular HDR texture (blur 0 = sharp). */
export type WorldBackground = { kind: 'color'; color: string } | { kind: 'hdr'; texture: Id; blur: number };
/** What lights the scene and shows in reflections: nothing, a uniform colour, three's studio room, or an HDR texture. */
export type WorldEnvironment = { kind: 'none' } | { kind: 'color'; color: string } | { kind: 'room' } | { kind: 'hdr'; texture: Id };
/** One directional light: where it comes from (degrees: azimuth clockwise from +Z seen from above, elevation above the horizon). */
export interface WorldSun { enabled: boolean; azimuth: number; elevation: number; color: string; strength: number; shadows: boolean }
/** Background and environment lighting (docs/16-world.md) — Blender's world. Nothing lights the scene that is not here. */
export interface World {
  background: WorldBackground;
  environment: WorldEnvironment;
  /** environment multiplier */
  strength: number;
  /** degrees about +Y; background and environment turn together */
  rotation: number;
  sun: WorldSun;
  /** the view transform is always AgX; this is its exposure */
  exposure: number;
  /** emissive geometry lighting the scene (docs/17-emitters.md) */
  emitters: WorldEmitters;
}

/**
 * Light from emissive geometry (docs/17-emitters.md): LED pixels are baked into a transfer
 * matrix to a grid of spherical-harmonic probes (`probeSpacing` mm apart, `visibility` = shadows
 * by ray marching a voxel grid), multiplied by the live pixel colours every frame. The near-field
 * bounce is the post script's `post.ssgi` (docs/17-emitters.md §3).
 */
export interface WorldEmitters {
  enabled: boolean;
  probeSpacing: number;
  visibility: boolean;
  /** how much light the lamps give (1 = as the shape's emissive colour says) */
  strength: number;
}

/** The post-processing script `(post, params) => outputNode` with its knobs — docs/15-camera.md. */
export interface PostProgram {
  enabled: boolean;
  label: string;
  code: string;
  params: Record<string, number>;
}

export interface Project {
  version: 18;
  name: string;
  profiles: Profile[];
  /** fill programs (docs/30-outline-and-shape-layers.md §4) */
  fills: Fill[];
  planes: Plane[];
  curves: CurveObject[];
  lofts: Loft[];
  /** surfaces over one or more curves of a plane, with their fill layers (docs/30 §4; was panels) */
  shapes: Shape[];
  groups: ObjectGroup[];
  materials: Material[];
  textures: Texture[];
  /** pixel animation maps (docs/17-emitters.md) */
  animations: Animation[];
  /** at least one (docs/36-camera-world.md): the viewport always looks through a camera, and the world is the camera's */
  cameras: Camera[];
  /** the camera looked through — never null */
  activeCamera: Id;
  post: PostProgram;
  /** the one playback clock of the pixel animations (docs/17-emitters.md) */
  playback: Playback;
}

// -- helpers ---------------------------------------------------------------

export function emptyProject(name = 'Untitled', profiles: Profile[] = [], fills: Fill[] = []): Project {
  return { version: 18, name, profiles, fills, planes: [], curves: [], lofts: [], shapes: [], groups: [], materials: [], textures: [], animations: [], cameras: [firstCamera()], activeCamera: FIRST_CAMERA, post: defaultPost(), playback: defaultPlayback() };
}

export const FIRST_CAMERA: Id = 'camera-1';

/** The camera every project starts with (docs/36-camera-world.md): the default lens and pose, `world` the default unless given. */
export function firstCamera(world?: World): Camera {
  return normalizeCamera({ id: FIRST_CAMERA, name: 'Camera 1', world });
}

export function newPlane(name: string, placement: Placement, taken: Iterable<Id>): Plane {
  return { id: uniqueId(slug(name), taken), name, placement, array: null, image: null };
}

/** A reference image as it comes in: 2000 mm wide, centred on the plane origin, faded and unlocked so it can be placed. */
export function defaultPlaneImage(texture: Id): PlaneImage {
  return { texture, center: { x: 0, y: 0 }, width: 2000, rotation: 0, opacity: 0.35, visible: true, locked: false };
}

/** A stored (or agent-written) reference image made safe; null when there is no image or its texture is gone. */
export function normalizePlaneImage(raw: unknown, textures: { id: Id }[]): PlaneImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PlaneImage>;
  if (!r.texture || !textures.some((t) => t.id === r.texture)) return null;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const d = defaultPlaneImage(r.texture);
  return {
    texture: r.texture,
    center: { x: num(r.center?.x, 0), y: num(r.center?.y, 0) },
    width: Math.max(1, num(r.width, d.width)),
    rotation: num(r.rotation, 0),
    opacity: Math.min(1, Math.max(0, num(r.opacity, d.opacity))),
    visible: r.visible !== false,
    locked: r.locked !== false,
  };
}

export function newCurve(name: string, planeId: Id, profileId: Id | null, taken: Iterable<Id>): CurveObject {
  return { id: uniqueId(slug(name), taken), name, planeId, type: 'planar', curve: { points: [], closed: false }, constraints: [], outline: profileId ? [newOutlineLayer(profileId, [], 'base')] : [] };
}

/** Put every vertex, handle and pin of the curve back onto its plane (z = 0). */
export function flattenCurve(c: CurveObject): void {
  for (const v of c.curve.points) { v.z = 0; v.in.z = 0; v.out.z = 0; }
  for (const k of c.constraints) if (k.at) k.at.z = 0;
}

export function findCurve(project: Project, id: Id | null): CurveObject | null {
  return project.curves.find((c) => c.id === id) ?? null;
}

export function findGroup(project: Project, id: Id | null): ObjectGroup | null {
  return project.groups.find((g) => g.id === id) ?? null;
}

/** The object a plane belongs to directly, if any. */
export function groupOfPlane(project: Project, planeId: Id): ObjectGroup | null {
  return project.groups.find((g) => g.planes.includes(planeId)) ?? null;
}

/** A group's frame: rigid (position + rotation), no preset. */
export function groupPlacement(position: Vec3 = { x: 0, y: 0, z: 0 }): Placement {
  return { preset: 'custom', position: { ...position }, rotation: { x: 0, y: 0, z: 0 } };
}

/** The object an object belongs to, if any (docs/18-nested-objects.md). */
export function parentOfGroup(project: Project, groupId: Id): ObjectGroup | null {
  return project.groups.find((g) => g.groups.includes(groupId)) ?? null;
}

/** The child objects of an object, in its own order. */
export function childGroups(project: Project, g: ObjectGroup): ObjectGroup[] {
  return g.groups.map((id) => findGroup(project, id)).filter((x): x is ObjectGroup => !!x);
}

/** The object and everything under it, outermost first. */
export function subtreeGroups(project: Project, g: ObjectGroup): ObjectGroup[] {
  const out: ObjectGroup[] = [], seen = new Set<Id>();
  const walk = (x: ObjectGroup) => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    out.push(x);
    for (const c of childGroups(project, x)) walk(c);
  };
  walk(g);
  return out;
}

/** The ids of every plane inside the object, at any depth. */
export function subtreePlanes(project: Project, g: ObjectGroup): Id[] {
  return subtreeGroups(project, g).flatMap((x) => x.planes.filter((id) => findPlane(project, id)));
}

/** The chain of objects from the outermost ancestor down to this one (it is always last). */
export function groupChain(project: Project, groupId: Id | null): ObjectGroup[] {
  const chain: ObjectGroup[] = [];
  const seen = new Set<Id>();
  let g = findGroup(project, groupId);
  while (g && !seen.has(g.id)) { seen.add(g.id); chain.unshift(g); g = parentOfGroup(project, g.id); }
  return chain;
}

/** The outermost object containing this one (itself when it is top level). */
export function rootGroupOf(project: Project, groupId: Id): ObjectGroup | null {
  return groupChain(project, groupId)[0] ?? null;
}

/** Would making `parentId` the parent of `groupId` make a cycle (or itself its own parent)? */
export function wouldCycle(project: Project, groupId: Id, parentId: Id | null): boolean {
  if (!parentId) return false;
  if (parentId === groupId) return true;
  return groupChain(project, parentId).some((g) => g.id === groupId);
}

/** The object a plane is inside at any depth (its direct object or one of that object's ancestors). */
export function groupsOfPlaneChain(project: Project, planeId: Id): ObjectGroup[] {
  const g = groupOfPlane(project, planeId);
  return g ? groupChain(project, g.id) : [];
}

/** Lofts whose two curves both lie on planes inside the object (its whole subtree). */
export function loftsOfGroup(project: Project, g: ObjectGroup): Loft[] {
  const planes = new Set(subtreePlanes(project, g));
  const inside = (cid: Id) => { const c = findCurve(project, cid); return !!c && planes.has(c.planeId); };
  return project.lofts.filter((l) => inside(l.a) && inside(l.b));
}

/** Lofts owned by exactly this object: inside it, but not inside any of its child objects. */
export function loftsOwnedBy(project: Project, g: ObjectGroup): Loft[] {
  const deeper = new Set(childGroups(project, g).flatMap((c) => loftsOfGroup(project, c).map((l) => l.id)));
  return loftsOfGroup(project, g).filter((l) => !deeper.has(l.id));
}

/** The plane a shape is built on: its first curve's (docs/30 §4); null while it has no curve. */
export function shapePlane(project: Project, sh: Shape): Plane | null {
  for (const id of sh.curves) { const c = findCurve(project, id); if (c) return findPlane(project, c.planeId); }
  return null;
}

/** Shapes whose plane lies inside the object (its whole subtree). */
export function shapesOfGroup(project: Project, g: ObjectGroup): Shape[] {
  const planes = new Set(subtreePlanes(project, g));
  return project.shapes.filter((sh) => { const pl = shapePlane(project, sh); return !!pl && planes.has(pl.id); });
}

/** Shapes owned by exactly this object: inside it, but not inside any of its child objects. */
export function shapesOwnedBy(project: Project, g: ObjectGroup): Shape[] {
  const deeper = new Set(childGroups(project, g).flatMap((c) => shapesOfGroup(project, c).map((p) => p.id)));
  return shapesOfGroup(project, g).filter((p) => !deeper.has(p.id));
}

/** An object is shown when it and every ancestor are visible (docs/18-nested-objects.md §4). */
export function groupVisible(project: Project, groupId: Id | null): boolean {
  return groupChain(project, groupId).every((g) => g.visible !== false);
}

/** Is anything on this plane drawn? (false when it sits inside a hidden object) */
export function planeVisible(project: Project, planeId: Id): boolean {
  const g = groupOfPlane(project, planeId);
  return !g || groupVisible(project, g.id);
}

export function findMaterial(project: Project, id: Id | null): Material | null {
  return project.materials.find((m) => m.id === id) ?? null;
}

export function findTexture(project: Project, id: Id | null): Texture | null {
  return project.textures.find((t) => t.id === id) ?? null;
}

export function findAnimation(project: Project, id: Id | null): Animation | null {
  return project.animations.find((a) => a.id === id) ?? null;
}

/** How many pixels a fixture carries (docs/17-emitters.md). */
export function pixelCount(px: CurvePixels | null): number {
  return px ? Math.max(1, Math.min(3, Math.round(px.chains))) * PIXELS_PER_CHAIN : 0;
}

/** A layer's parameters: the program's defaults under the layer's overrides. */
export function paramsOf(program: { params: Record<string, number> }, layer: { params: Record<string, number> }): Record<string, number> {
  return { ...program.params, ...layer.params };
}

/** The fixtures of the project: every outline layer patched as one (docs/17-emitters.md), with its curve. */
export function fixturesOf(project: Project): { curve: CurveObject; layer: OutlineLayer }[] {
  const out: { curve: CurveObject; layer: OutlineLayer }[] = [];
  for (const curve of project.curves) for (const layer of curve.outline) if (layer.pixels) out.push({ curve, layer });
  return out;
}

/** The outline as a comparable string (profiles, offsets, lifts in order) — what the array commit welds by. */
export function outlineKey(c: CurveObject): string {
  return JSON.stringify(c.outline.map((l) => [l.profileId, l.offset, l.lift]));
}

/** Texture ids a material's code references through `host.texture('id')`. */
export function texturesInCode(code: string): Id[] {
  const out = new Set<Id>();
  for (const m of code.matchAll(/host\.texture\(\s*(['"`])([^'"`]+)\1\s*\)/g)) out.add(m[2]);
  return [...out];
}

export function findLoft(project: Project, id: Id | null): Loft | null {
  return project.lofts.find((l) => l.id === id) ?? null;
}

export function findShape(project: Project, id: Id | null): Shape | null {
  return project.shapes.find((p) => p.id === id) ?? null;
}

export function findFill(project: Project, id: Id | null): Fill | null {
  return project.fills.find((f) => f.id === id) ?? null;
}

/** The fill a shape layer runs (the first one when its own is gone). */
export function fillOf(project: Project, layer: ShapeLayer): Fill | null {
  return findFill(project, layer.fillId) ?? project.fills[0] ?? null;
}

export function findPlane(project: Project, id: Id | null): Plane | null {
  return project.planes.find((p) => p.id === id) ?? null;
}

export function planeOf(project: Project, c: CurveObject): Plane {
  return findPlane(project, c.planeId) ?? project.planes[0];
}

/** The profile an outline layer is bent from (the first one when its own is gone). */
export function profileOf(project: Project, layer: OutlineLayer): Profile {
  return project.profiles.find((p) => p.id === layer.profileId) ?? project.profiles[0];
}

/** A curve's first outline layer — what the one-profile commands of earlier parts act on; null on a construction line. */
export function baseLayer(c: CurveObject): OutlineLayer | null {
  return c.outline[0] ?? null;
}

/** `base`, or `base-2`, `base-3`, … until it is not in `taken`. */
export function uniqueId(base: string, taken: Iterable<Id>): Id {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || 'object';
}

export function uid(): Id {
  return Math.random().toString(36).slice(2, 9);
}

export function vertex(x: number, y: number, type: VertexType = 'polygon', z = 0): Vertex {
  return { id: uid(), x, y, z, type, in: { x: 0, y: 0, z: 0 }, out: { x: 0, y: 0, z: 0 } };
}

const v3 = (p: Partial<Vec3> | undefined): Vec3 => ({ x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0 });

/** A stored vertex type of any part → the current set (docs/27-vertex-types.md); 'auto' is baked below. */
function vertexType(t: unknown, hin: Vec3, hout: Vec3): VertexType {
  if (t === 'polygon' || t === 'equal' || t === 'free') return t;
  if (t === 'corner') return hin.x || hin.y || hin.z || hout.x || hout.y || hout.z ? 'free' : 'polygon';
  return 'equal';                            // 'smooth', and 'auto' / missing (its handles are baked in below)
}

function fixVertices(curve: Curve): void {
  const auto: boolean[] = [];
  curve.points = (curve.points ?? []).map((v) => {
    const q = v as Omit<Partial<Vertex>, 'type'> & { type?: string };
    auto.push(q.type === 'auto' || q.type === undefined);
    const hin = v3(q.in), hout = v3(q.out);
    return { id: q.id ?? uid(), x: q.x ?? 0, y: q.y ?? 0, z: q.z ?? 0, type: vertexType(q.type, hin, hout), in: hin, out: hout };
  });
  curve.closed = !!curve.closed;
  // 13 → 14: an Auto vertex becomes an Equal one carrying the handles the auto maths gave it, so the shape is unchanged
  auto.forEach((was, i) => {
    if (!was) return;
    const h = autoHandles(curve.points, curve.closed, i);
    curve.points[i].in = h.in;
    curve.points[i].out = h.out;
  });
}

/** A stored profile of any part: code + params as is, or the pre-Part-14 shape / a / b / t / rotate turned into code. */
function migrateProfile(raw: Profile): Profile {
  const r = raw as unknown as Record<string, unknown>;
  // 8 → 9 (docs/17-emitters.md): a stored LED string gains the `pixel` attribute its fixtures need
  if (typeof r.code === 'string') return { id: raw.id, label: raw.label ?? raw.id, code: upgradeLedCode(r.code) ?? r.code, params: raw.params ?? {}, color: raw.color ?? '#c9c9cf', limits: { minBendRadius: raw.limits?.minBendRadius ?? 0, maxLength: raw.limits?.maxLength ?? 6000 } };
  return profileFromLegacy(r);
}

/** Accept a stored project of any earlier part and bring it to the current shape. */
export function migrateProject(raw: unknown): Project | null {
  const p = raw as { version?: number; profiles?: Profile[] };
  if (!p || !Array.isArray(p.profiles) || !p.profiles.length) return null;
  if (p.version !== undefined && p.version >= 4 && p.version <= 18) {
    // 4 → 5 (docs/12-3d-curves.md): vertices, handles and pins gain z = 0, curves the type 'planar'
    // 5 → 6 (docs/14-shapes.md): profiles become code + params, curves get params
    // 6 → 7 (docs/15-camera.md): the single camera becomes camera objects + activeCamera
    // 7 → 8 (docs/16-world.md): the world (the default reproduces the old fixed rig), cameras get world: null
    // 8 → 9 (docs/17-emitters.md): pixel animations, curves get pixels: null, the world gains emitters
    // 9 → 10 (docs/18-nested-objects.md): objects gain child objects, their own placement and a visibility flag
    // 10 → 11 (docs/19-reference-image.md): planes gain a reference image (null on an older file)
    // 11 → 12 (docs/22-transport-in-out.md): the transport is a clock — `playback.animation` goes, in / out arrive
    // 12 → 13 (docs/26-array.md): a circular array turns about a line — the centre gains z, the axis arrives (the normal)
    // 14 → 15 (docs/28-panel-surface.md): panels — a flat sheet filling one curve (an older file has none)
    // 13 → 14 (docs/27-vertex-types.md): handle types become polygon / equal / free — Auto bakes into Equal (see fixVertices)
    // 15 → 16 (docs/30-outline-and-shape-layers.md): a curve's profile / params / material / fixture become its first
    //          outline layer; panels become shapes with one Sheet layer; fill programs arrive
    // 16 → 17 (docs/31-ssr.md): the untouched Part 15 Eevee script is refreshed — `post.ssr` and the `reflections` knob
    // 17 → 18 (docs/36-camera-world.md): the world is the camera's — every camera gets one (the project's when it had
    //          none), a project without cameras gets Camera 1, the free view (activeCamera null) becomes the first camera
    const q = raw as Project & { panels?: Partial<Shape & { curve: Id; materialId: Id | null; offset: number }>[]; world?: unknown };
    if (!Array.isArray(q.planes) || !Array.isArray(q.curves)) return null;
    q.version = 18;
    q.profiles = q.profiles.map((pr) => migrateProfile(pr));
    q.fills = (q.fills ?? []).filter((f) => f && f.id && typeof f.code === 'string').map((f) => ({ id: f.id, label: f.label ?? f.id, code: f.code, params: numMap(f.params), color: f.color ?? '#d8d8dc', metalness: numOr(f.metalness), roughness: numOr(f.roughness, 0.5) }));
    for (const pl of q.planes) pl.array = normalizeArray(pl.array);
    q.materials = (q.materials ?? []).filter((m) => m && typeof m.code === 'string').map((m) => ({ ...m, source: m.source ?? '', warnings: m.warnings ?? [] }));
    q.textures = (q.textures ?? []).filter((t) => t && t.id && typeof t.data === 'string').map((t) => ({ ...t, mime: t.mime ?? 'image/png', width: t.width ?? 0, height: t.height ?? 0, source: t.source ?? '' }));
    for (const pl of q.planes) pl.image = normalizePlaneImage(pl.image, q.textures);
    if ((p.version ?? 0) < 16) delete (q as { shapes?: unknown }).shapes;   // a Part 14 draft's render-only shapes; from 16 on `shapes` are the surfaces (docs/30)
    const legacy = (q as { camera?: Partial<CameraSettings> }).camera;
    delete (q as { camera?: unknown }).camera;
    // 17 → 18: the project's world (the default when an older file had none) goes to every camera without its own
    const projectWorld = normalizeWorld(q.world);
    delete q.world;
    q.cameras = (q.cameras ?? []).filter((c) => c && c.id).map((c) => normalizeCamera({ ...c, world: c.world ?? projectWorld }));
    if (legacy && !q.cameras.length) {
      // a Part 15 project with a single camera keeps it as "Camera 1", looked through (an untouched one is the default anyway)
      q.cameras.push(normalizeCamera({ ...legacy, id: FIRST_CAMERA, name: 'Camera 1', world: projectWorld } as Camera));
    }
    if (!q.cameras.length) q.cameras.push(firstCamera(projectWorld));
    if (!q.activeCamera || !q.cameras.some((c) => c.id === q.activeCamera)) q.activeCamera = q.cameras[0].id;
    const dp = defaultPost(), qp = (q.post ?? {}) as Partial<PostProgram>;
    q.post = { enabled: qp.enabled ?? dp.enabled, label: qp.label ?? dp.label, code: typeof qp.code === 'string' ? qp.code : dp.code, params: qp.params ?? { ...dp.params } };
    if (q.post.code === EEVEE_V15) q.post = { ...q.post, code: dp.code, params: { ...dp.params, ...q.post.params } };   // 16 → 17: the preset's own code, the new knob
    q.animations =(q.animations ?? []).filter((a) => a && a.id && a.texture).map((a) => normalizeAnimation(a));
    const pb = (q.playback ?? {}) as Partial<Playback> & { animation?: unknown };
    delete pb.animation;                       // 11 → 12: every fixture carries its own map
    q.playback = normalizePlayback(pb);
    for (const c of q.curves) {
      const legacy = c as CurveObject & { shapeId?: unknown; shapeParams?: Record<string, number>; profileId?: Id; params?: Record<string, number>; materialId?: Id | null; pixels?: CurvePixels | null };
      c.constraints ??= [];
      // 15 → 16: the one profile becomes the first outline layer
      if (!Array.isArray(c.outline)) c.outline = legacy.profileId ? [{ id: 'base', profileId: legacy.profileId, params: legacy.params ?? legacy.shapeParams ?? {}, materialId: legacy.materialId ?? null, color: null, offset: 0, lift: 0, pixels: legacy.pixels ?? null, visible: true }] : [];
      c.outline = c.outline.filter((l) => l && l.id).map((l) => normalizeOutlineLayer(l, q.profiles));
      for (const l of c.outline) if (l.pixels && l.pixels.animation && !q.animations.some((a) => a.id === l.pixels!.animation)) l.pixels.animation = null;
      delete legacy.shapeId; delete legacy.shapeParams; delete legacy.profileId; delete legacy.params; delete legacy.materialId; delete legacy.pixels;
      c.type = c.type === 'spatial' ? 'spatial' : 'planar';
      fixVertices(c.curve);
      for (const k of c.constraints) if (k.at) k.at = v3(k.at);
      if (c.type === 'planar') flattenCurve(c);
    }
    q.curves = q.curves.filter((c) => q.planes.some((pl) => pl.id === c.planeId));
    // lofts gain the two edge trims (docs/24-loft-trim.md); an older file reads back as untrimmed
    q.lofts = (q.lofts ?? []).map((l) => ({ ...l, resolution: l.resolution || 2, strips: l.strips || 4, flip: !!l.flip, materialId: l.materialId ?? null, edgeA: normalizeLoftEdge(l.edgeA), edgeB: normalizeLoftEdge(l.edgeB) }));
    // 15 → 16: a panel is a shape over its one curve with a Sheet layer carrying its material and offset
    const panels = (q.panels ?? []).filter((x) => x && x.id && x.curve && q.curves.some((c) => c.id === x.curve));
    if (panels.length && !q.fills.some((f) => f.id === 'sheet')) q.fills.unshift(SHEET_FILL());
    q.shapes = [
      ...(q.shapes ?? []).filter((x) => x && x.id).map((x) => normalizeShape(x)),
      ...panels.map((x) => normalizeShape({ id: x.id!, name: x.name, curves: [x.curve!], expand: x.expand, resolution: x.resolution, layers: [{ id: 'sheet', fillId: 'sheet', params: {}, materialId: x.materialId ?? null, color: null, offset: x.offset ?? 0, visible: true }] })),
    ];
    delete q.panels;
    for (const sh of q.shapes) sh.curves = sh.curves.filter((id) => q.curves.some((c) => c.id === id));
    q.shapes = q.shapes.filter((sh) => sh.curves.length);
    q.groups = (q.groups ?? []).map((g) => ({
      ...g,
      planes: (g.planes ?? []).filter((id) => q.planes.some((pl) => pl.id === id)),
      groups: (g.groups ?? []).filter((id) => (q.groups ?? []).some((x) => x.id === id)),
      placement: g.placement ? { preset: 'custom' as const, position: v3(g.placement.position), rotation: v3(g.placement.rotation) } : groupPlacement(),
      visible: g.visible !== false,
    }));
    return q;
  }
  if (p.version === 3) {
    // Part 1/2: objects with their own placement + modifier → planes (shared when identical) + curves
    interface V3 { name: string; objects: { id: Id; name: string; profileId: Id; plane: Placement; curve: Curve; array: ArrayModifier | null; constraints?: VertexConstraint[] }[] }
    const q = raw as V3;
    if (!Array.isArray(q.objects)) return null;
    const out = emptyProject(q.name, p.profiles.map((pr) => migrateProfile(pr)));
    const byKey = new Map<string, Plane>();
    for (const o of q.objects) {
      const key = JSON.stringify([o.plane, o.array]);
      let plane = byKey.get(key);
      if (!plane) {
        const base = o.plane.preset === 'custom' ? 'plane' : o.plane.preset;
        plane = newPlane(base, { preset: o.plane.preset, position: { ...o.plane.position }, rotation: { ...o.plane.rotation } }, out.planes.map((x) => x.id));
        plane.name = plane.id.charAt(0).toUpperCase() + plane.id.slice(1);
        plane.array = o.array ?? null;
        out.planes.push(plane);
        byKey.set(key, plane);
      }
      const c: CurveObject = { id: o.id, name: o.name, planeId: plane.id, type: 'planar', curve: o.curve, constraints: o.constraints ?? [], outline: [normalizeOutlineLayer({ id: 'base', profileId: o.profileId }, out.profiles)] };
      fixVertices(c.curve);
      for (const k of c.constraints) if (k.at) k.at = v3(k.at);
      out.curves.push(c);
    }
    return out;
  }
  return null;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Key of ProfileLimits – the id of a limitation check. */
export type CheckIdLike = keyof ProfileLimits;
