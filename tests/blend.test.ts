/**
 * .blend import (docs/09-blender-import.md): the parser is checked against
 * Blender's own view of the same file (tests/fixtures/golden-net.json, written
 * by scripts/blend-fixture.py while saving the .blend).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlendFile } from '../src/blend/parser';
import { readMaterials, type BlendMaterial, type ShaderTree } from '../src/blend/shaders';

interface TruthSocket { identifier: string; name: string; type: string; enabled: boolean; value?: number | number[] | boolean }
interface TruthNode { name: string; idname: string; label: string; mute: boolean; inputs: TruthSocket[]; outputs: TruthSocket[]; [k: string]: unknown }
interface TruthTree { nodes: TruthNode[]; links: { from: [string, string]; to: [string, string]; mute: boolean }[] }
interface Truth { blender: string; materials: { name: string; tree: TruthTree | null; viewport: { color: number[]; metallic: number; roughness: number } }[]; groups: Record<string, TruthTree> }

const truth = JSON.parse(readFileSync(new URL('./fixtures/golden-net.json', import.meta.url), 'utf8')) as Truth;
let mats: BlendMaterial[];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;

beforeAll(async () => {
  const file = await BlendFile.parse(readFileSync(new URL('./fixtures/golden-net.blend', import.meta.url)));
  expect(file.version).toBe('0501');
  mats = readMaterials(file);
});

function expectTree(tree: ShaderTree, t: TruthTree): void {
  expect(tree.nodes.map((n) => n.name).sort()).toEqual(t.nodes.map((n) => n.name).sort());
  for (const tn of t.nodes) {
    const n = tree.nodes.find((x) => x.name === tn.name)!;
    expect(n.idname, tn.name).toBe(tn.idname);
    expect(n.mute, tn.name).toBe(tn.mute);
    for (const [dir, list] of [['inputs', tn.inputs], ['outputs', tn.outputs]] as const) {
      const socks = n[dir];
      expect(socks.map((s) => s.id), `${tn.name} ${dir}`).toEqual(list.map((s) => s.identifier));
      list.forEach((ts, i) => {
        const s = socks[i];
        expect(s.enabled, `${tn.name}.${ts.identifier} enabled`).toBe(ts.enabled);
        if (ts.value === undefined) return;
        if (typeof ts.value === 'number') expect(near(s.value as number, ts.value), `${tn.name}.${ts.identifier} = ${s.value} vs ${ts.value}`).toBe(true);
        else if (typeof ts.value === 'boolean') expect(s.value).toBe(ts.value);
        else (s.value as number[]).slice(0, ts.value.length).forEach((v, k) => expect(near(v, (ts.value as number[])[k]), `${tn.name}.${ts.identifier}[${k}]`).toBe(true));
      });
    }
  }
  const key = (l: TruthTree['links'][0]) => `${l.from.join('.')}→${l.to.join('.')}${l.mute ? '!' : ''}`;
  expect(tree.links.map(key).sort()).toEqual(t.links.map(key).sort());
}

describe('.blend parser', () => {
  it('lists every material (Blender writes them sorted by name)', () => {
    expect(mats.map((m) => m.name)).toEqual([...truth.materials.map((m) => m.name)].sort());
  });

  it('reads viewport colour / metallic / roughness', () => {
    for (const tm of truth.materials) {
      const m = mats.find((x) => x.name === tm.name)!;
      tm.viewport.color.forEach((c, i) => expect(near(m.viewport.color[i], c)).toBe(true));
      expect(near(m.viewport.metallic, tm.viewport.metallic)).toBe(true);
      expect(near(m.viewport.roughness, tm.viewport.roughness)).toBe(true);
    }
  });

  it('reads every node, socket value, flag and link like Blender does', () => {
    for (const tm of truth.materials) {
      if (!tm.tree) continue;
      expectTree(mats.find((x) => x.name === tm.name)!.tree!, tm.tree);
    }
  });

  it('inlines node groups by reference and reads their tree', () => {
    const g = mats.find((m) => m.name === 'grouped')!.tree!.nodes.find((n) => n.idname === 'ShaderNodeGroup')!;
    expect(g.group?.name).toBe('Stripes');
    expectTree(g.group!, truth.groups.Stripes);
  });

  it('reads the image of an Image Texture node with its packed bytes', () => {
    const n = mats.find((m) => m.name === 'textured')!.tree!.nodes.find((x) => x.idname === 'ShaderNodeTexImage')!;
    const t = truth.materials.find((m) => m.name === 'textured')!.tree!.nodes.find((x) => x.idname === 'ShaderNodeTexImage')!.image as { name: string; packed: boolean; size: number };
    expect(n.image?.name).toBe(t.name);
    expect(t.packed).toBe(true);
    expect(n.image?.packed?.length).toBe(t.size);
    expect([...n.image!.packed!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);   // PNG
  });

  it('reads colour ramps', () => {
    const ramp = mats.find((m) => m.name === 'golden net')!.tree!.nodes.find((n) => n.idname === 'ShaderNodeValToRGB')!.ramp!;
    const t = truth.materials.find((m) => m.name === 'golden net')!.tree!.nodes.find((n) => n.idname === 'ShaderNodeValToRGB')!.ramp as { interpolation: string; elements: [number, number[]][] };
    expect(ramp.interpolation).toBe(t.interpolation.toLowerCase().replace('b_spline', 'bspline'));
    expect(ramp.elements.length).toBe(t.elements.length);
    t.elements.forEach(([pos, color], i) => { expect(near(ramp.elements[i].pos, pos)).toBe(true); color.forEach((c, k) => expect(near(ramp.elements[i].color[k], c)).toBe(true)); });
  });
});

// -- conversion -----------------------------------------------------------------------
import { convertMaterial, MATH_OPS, VECTOR_MATH_OPS, BLEND_TYPES, MAP_RANGE_INTERP, VORONOI_FEATURES, VORONOI_DISTANCES, NOISE_TYPES, GRADIENT_TYPES, MAPPING_TYPES, ROTATE_TYPES, COLOR_MODES } from '../src/blend/tsl';
import { buildMaterial, hostFor } from '../src/materials/runtime';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';

describe('Blender enum tables', () => {
  it('match every value Blender 5.1 writes (material "enums": one node per enum item)', () => {
    const m = mats.find((x) => x.name === 'enums')!;
    const t = truth.materials.find((x) => x.name === 'enums')!.tree!;
    const checks: Record<string, (n: typeof m.tree extends null ? never : NonNullable<typeof m.tree>['nodes'][0]) => number | undefined> = {
      'ShaderNodeMath.operation': (n) => n.custom1, 'ShaderNodeVectorMath.operation': (n) => n.custom1,
      'ShaderNodeMix.blend_type': (n) => n.storage?.blend_type as number, 'ShaderNodeMapRange.interpolation_type': (n) => n.storage?.interpolation_type as number,
      'ShaderNodeTexVoronoi.feature': (n) => n.storage?.feature as number, 'ShaderNodeTexVoronoi.distance': (n) => n.storage?.distance as number,
      'ShaderNodeTexNoise.noise_type': (n) => n.storage?.type as number, 'ShaderNodeTexGradient.gradient_type': (n) => n.storage?.gradient_type as number,
      'ShaderNodeMapping.vector_type': (n) => n.custom1, 'ShaderNodeVectorRotate.rotation_type': (n) => n.custom1, 'ShaderNodeSeparateColor.mode': (n) => n.storage?.mode as number,
    };
    const tables: Record<string, Record<number, string>> = {
      'ShaderNodeMath.operation': MATH_OPS, 'ShaderNodeVectorMath.operation': VECTOR_MATH_OPS, 'ShaderNodeMix.blend_type': BLEND_TYPES, 'ShaderNodeMapRange.interpolation_type': MAP_RANGE_INTERP,
      'ShaderNodeTexVoronoi.feature': VORONOI_FEATURES, 'ShaderNodeTexVoronoi.distance': VORONOI_DISTANCES, 'ShaderNodeTexNoise.noise_type': NOISE_TYPES, 'ShaderNodeTexGradient.gradient_type': GRADIENT_TYPES,
      'ShaderNodeMapping.vector_type': MAPPING_TYPES, 'ShaderNodeVectorRotate.rotation_type': ROTATE_TYPES, 'ShaderNodeSeparateColor.mode': COLOR_MODES,
    };
    let checked = 0;
    for (const tn of t.nodes) {
      if (!tn.label) continue;
      const [prop, val] = tn.label.split('=');
      const key = `${tn.idname}.${prop}`;
      if (!checks[key]) continue;
      const n = m.tree!.nodes.find((x) => x.name === tn.name)!;
      const num = checks[key](n)!;
      expect(tables[key][num], `${key} ${val} = ${num}`).toBe(val);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('Blender → TSL conversion', () => {
  it('samples image textures through host.texture(id) and reports the images (docs/13-material-editor.md)', () => {
    const r = convertMaterial(mats.find((x) => x.name === 'textured')!);
    expect(r.images.map((i) => [i.id, i.name, !!i.packed])).toEqual([['net', 'net.png', true]]);
    expect(r.code).toContain("texture(host.texture('net'), ");
    expect(r.code).toContain('.rgb');
    expect(r.code).toContain('.a');   // Alpha → Roughness
    expect(r.code).toContain('// Textures (host.texture): net = net.png');
    expect(r.warnings).toEqual([]);
    const seen: string[] = [];
    const mat = buildMaterial(r.code, hostFor({ textures: (id) => { seen.push(id); return null; } }));
    expect(mat).toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect(seen).toEqual(['net']);
  });


  it('converts the golden net to readable TSL that builds a MeshPhysicalNodeMaterial', () => {
    const m = mats.find((x) => x.name === 'golden net')!;
    const r = convertMaterial(m);
    expect(r.code).toContain('pingpong(');
    expect(r.code).toContain('voronoiF1(');
    expect(r.code).toContain('remapClamp(');
    expect(r.code).toContain("blend('MULTIPLY'");
    expect(r.code).toContain('ramp(');
    expect(r.code).toContain('metalness: float(0.6)');
    expect(r.code).toContain('roughness: float(0.314)');
    expect(r.code.match(/mx_worley_noise_float/g)).toBeTruthy();
    expect(r.warnings.filter((w) => !w.includes('4D noise'))).toEqual([]);   // only the W approximation is flagged
    const mat = buildMaterial(r.code, hostFor());
    expect(mat).toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect(mat.colorNode).toBeTruthy();
    expect(mat.metalnessNode).toBeTruthy();
  });

  it('inlines node groups, mixes shaders, honours muted nodes and default coordinates', () => {
    const m = mats.find((x) => x.name === 'grouped')!;
    const r = convertMaterial(m);
    expect(r.code).toContain('mixShader(');
    expect(r.code).toContain('eulerXYZ(');           // Mapping
    expect(r.code).toContain('host.object');         // Texture Coordinate › Object
    expect(r.code).toContain('host.uv');             // Texture Coordinate › UV → Noise (and the default for unlinked texture vectors)
    expect(r.code).toContain('.mul(float(6))');      // group input Scale = 6 flows into the group's multiply
    expect(r.code).toContain('fract(');              // node inside the group
    expect(r.code).toContain('emissive: color(0.1, 0.4, 1).mul(float(2))');
    expect(r.code).not.toContain('.sub(');           // the muted Subtract passes its first input through
    const mat = buildMaterial(r.code, hostFor());
    expect(mat.emissiveNode).toBeTruthy();
  });

  it('falls back to a default Principled for a material with the stock tree', () => {
    const r = convertMaterial(mats.find((x) => x.name === 'plain')!);
    expect(r.warnings).toEqual([]);
    const mat = buildMaterial(r.code, hostFor());
    expect(mat.colorNode).toBeTruthy();
  });

  it('builds every enum-probe node without throwing (they are unlinked, so only the output matters)', () => {
    const r = convertMaterial(mats.find((x) => x.name === 'enums')!);
    expect(() => buildMaterial(r.code, hostFor())).not.toThrow();
  });
});

// -- DNA padding regression ------------------------------------------------------------
/** A minimal classic-format .blend whose DNA1 data starts at an odd file offset (Blender pads DNA relative to the block, not the file). */
function tinyBlend(): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const push = (...b: number[]) => parts.push(...b);
  const str = (s: string) => push(...enc.encode(s));
  const i32 = (v: number) => push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const i16 = (v: number) => push(v & 255, (v >> 8) & 255);
  const i64 = (v: number) => { i32(v); i32(0); };
  const block = (code: string, sdna: number, old: number, count: number, body: () => void) => {
    const start = parts.length; str(code); i32(0); i64(old); i32(sdna); i32(count);
    const dataStart = parts.length; body();
    const len = parts.length - dataStart; parts[start + 4] = len & 255; parts[start + 5] = (len >> 8) & 255; parts[start + 6] = (len >> 16) & 255; parts[start + 7] = (len >>> 24) & 255;
  };
  str('BLENDER-v405');
  block('DATA', 0, 0x100, 1, () => push(7));                     // one odd byte → DNA1 data lands on offset ≡ 1 (mod 4)
  block('DNA1', 0, 0x200, 1, () => {
    const dnaStart = parts.length;
    const align = () => { while ((parts.length - dnaStart) % 4) push(0); };
    str('SDNA'); str('NAME'); i32(2); str('*next\0'); str('value\0'); align();
    str('TYPE'); i32(3); str('void\0'); str('float\0'); str('Thing\0'); align();
    str('TLEN'); i16(0); i16(4); i16(12); align();
    str('STRC'); i32(1); i16(2); i16(2); i16(0); i16(0); i16(1); i16(1);   // struct Thing { void *next; float value; }
  });
  block('DATA', 0, 0x300, 1, () => { i64(0); push(0, 0, 0x80, 0x3f); });  // a Thing with value = 1.0
  str('ENDB');
  const out = new Uint8Array(parts);
  return out;
}

describe('DNA padding', () => {
  it('is relative to the DNA block, not the file offset', async () => {
    const f = await BlendFile.parse(tinyBlend());
    const dna = f.blocks.find((b) => b.code === 'DNA1')!;
    expect(dna.offset % 4).toBe(1);
    expect(f.structByName.get('Thing')?.fields.map((x) => `${x.type} ${x.raw}@${x.offset}`)).toEqual(['void *next@0', 'float value@8']);
    expect(f.obj(f.blocks[2], 0, f.structByName.get('Thing')).num('value')).toBe(1);
  });
});
