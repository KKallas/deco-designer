import { FIRST_CAMERA, firstCamera, groupPlacement, placementFor, vertex, type Curve, type Fill, type OutlineLayer, type Profile, type Project, type Vertex } from './types';
import { fillHandles } from './handles';
import { PRESET_PROFILES } from './profiles';
import { PRESET_FILLS, cloneFill } from './fills';
import { defaultPost } from './post-presets';
import { defaultPlayback } from './world';

/** A curve of rounded (Equal) vertices: the demo shapes are drawn smooth, while a new vertex is Polygon (docs/27-vertex-types.md). */
function rounded(points: Vertex[], closed: boolean): Curve {
  const curve: Curve = { points: points.map((v) => ({ ...v, type: 'equal' })), closed };
  points.forEach((_, i) => fillHandles(curve, i));
  return curve;
}

const preset = (id: string): Profile => PRESET_PROFILES.find((p) => p.id === id)!;

/** The two stock shapes every new project starts with (code presets, docs/14-shapes.md). */
export const DEFAULT_PROFILES: Profile[] = [
  { ...preset('flat-bar'), id: 'flat25x2', label: 'Flat bar 25×2 mm', params: { width: 25, thickness: 2, rotate: 0 }, limits: { minBendRadius: 15, maxLength: 6000 } },
  { ...preset('round-tube'), id: 'round15', label: 'Round tube Ø15 mm', params: { diameter: 15, wall: 1.5 }, limits: { minBendRadius: 45, maxLength: 6000 } },
];

export const DEFAULT_PROFILE_ID = 'flat25x2';

/** The fills every new project starts with: all three presets (docs/30-outline-and-shape-layers.md §4). */
export const DEFAULT_FILLS: Fill[] = PRESET_FILLS.map(cloneFill);

/** One outline layer on the line, bent from `profileId` (the demo's curves have one each). */
const base = (profileId: string): OutlineLayer[] => [{ id: 'base', profileId, params: {}, materialId: null, color: null, offset: 0, lift: 0, pixels: null, visible: true }];

/** Demo: a front plane with an arch and a heart, a flower (circular array on a top plane), a fence (linear array). */
export function demoProject(): Project {
  const heart: Vertex[] = [];
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    heart.push(vertex(Math.round(x * 14), Math.round(400 + y * 14)));
  }
  return {
    version: 18,
    materials: [],
    textures: [],
    animations: [],
    playback: defaultPlayback(),
    cameras: [firstCamera()],
    activeCamera: FIRST_CAMERA,
    post: defaultPost(),
    name: 'Demo',
    profiles: DEFAULT_PROFILES.map((p) => ({ ...p, params: { ...p.params }, limits: { ...p.limits } })),
    fills: DEFAULT_FILLS.map(cloneFill),
    planes: [
      { id: 'front', name: 'Front', placement: placementFor('front'), array: null, image: null },
      { id: 'back', name: 'Back', placement: placementFor('front', { x: 0, y: 0, z: -300 }), array: null, image: null },
      { id: 'flower', name: 'Flower', placement: placementFor('top', { x: 1100, y: 0, z: 0 }), array: { type: 'circular', count: 6, center: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 }, angle: 360 }, image: null },
      { id: 'fence', name: 'Fence', placement: placementFor('front', { x: -1500, y: 0, z: 0 }), array: { type: 'linear', count: 3, offset: { x: 260, y: 0, z: 0 } }, image: null },
    ],
    lofts: [{ id: 'garland', name: 'Garland', a: 'arch', b: 'back-arch', resolution: 2, strips: 4, flip: false, materialId: null }],
    shapes: [],
    groups: [{ id: 'gate', name: 'Arch gate', planes: ['front', 'back'], groups: [], placement: groupPlacement(), visible: true }],
    curves: [
      {
        id: 'back-arch', name: 'Back arch', planeId: 'back', type: 'planar', constraints: [], outline: base('round15'),
        curve: rounded([vertex(-500, 0), vertex(-480, 450), vertex(-300, 760), vertex(0, 850), vertex(300, 760), vertex(480, 450), vertex(500, 0)], false),
      },
      {
        id: 'arch', name: 'Arch', planeId: 'front', type: 'planar', constraints: [], outline: base('round15'),
        curve: rounded([vertex(-600, 0), vertex(-580, 500), vertex(-350, 850), vertex(0, 950), vertex(350, 850), vertex(580, 500), vertex(600, 0)], false),
      },
      { id: 'heart', name: 'Heart', planeId: 'front', type: 'planar', constraints: [], outline: base('flat25x2'), curve: rounded(heart, true) },
      {
        id: 'petal', name: 'Petal', planeId: 'flower', type: 'planar', constraints: [], outline: base('flat25x2'),
        curve: rounded([vertex(0, 70), vertex(80, 190), vertex(0, 330), vertex(-80, 190)], true),
      },
      {
        id: 'picket', name: 'Picket', planeId: 'fence', type: 'planar', constraints: [], outline: base('round15'),
        curve: rounded([vertex(0, 0), vertex(0, 320), vertex(100, 420), vertex(200, 320), vertex(200, 0)], false),
      },
    ],
  };
}
