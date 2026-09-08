/**
 * Materials and shader node trees out of a parsed .blend (docs/09-blender-import.md).
 * Produces plain data: nodes with typed sockets and default values, links,
 * node storage as a flat object, node groups inlined by reference.
 */
import type { BlendFile, BlendObject } from './parser';

export type SocketType = 'float' | 'vector' | 'color' | 'shader' | 'bool' | 'int' | 'other';

export interface ShaderSocket {
  /** unique within the node, stable across Blender versions (e.g. `A_Color`) */
  id: string;
  name: string;
  type: SocketType;
  idname: string;
  value?: number | number[] | boolean;
  /** false for the type variants a node hides (Mix node's unused float / vector sockets) */
  enabled: boolean;
}

export interface ColorRamp { interpolation: 'linear' | 'ease' | 'bspline' | 'cardinal' | 'constant'; colorMode: 'rgb' | 'hsv' | 'hsl'; elements: { pos: number; color: [number, number, number, number] }[] }

/** An image datablock behind an Image Texture node (docs/13-material-editor.md). */
export interface BlendImage {
  /** datablock name, e.g. `net.png` */
  name: string;
  filepath: string;
  /** the file's bytes when the image is packed in the .blend */
  packed: Uint8Array | null;
}

export interface ShaderNode {
  name: string;
  idname: string;
  label: string;
  mute: boolean;
  /** the active Material Output */
  activeOutput: boolean;
  custom1: number;
  custom2: number;
  custom3: number;
  custom4: number;
  storage: Record<string, number | number[] | string> | null;
  storageType: string | null;
  ramp: ColorRamp | null;
  /** node group tree (ShaderNodeGroup) */
  group: ShaderTree | null;
  /** the image of an Image / Environment Texture node */
  image: BlendImage | null;
  inputs: ShaderSocket[];
  outputs: ShaderSocket[];
}

export interface ShaderLink { from: [node: string, socket: string]; to: [node: string, socket: string]; mute: boolean }
export interface ShaderTree { name: string; nodes: ShaderNode[]; links: ShaderLink[] }

export interface BlendMaterial {
  name: string;
  useNodes: boolean;
  tree: ShaderTree | null;
  /** viewport display settings (the whole material when use_nodes is off) */
  viewport: { color: [number, number, number, number]; metallic: number; roughness: number };
}

// bNode.flag / bNodeSocket.flag / bNodeLink.flag bits (DNA_node_types.h)
const NODE_DO_OUTPUT = 1 << 6;
const NODE_MUTED = 1 << 9;
const SOCK_UNAVAIL = 1 << 3;
const NODE_LINK_MUTED = 1 << 4;

function socketType(idname: string, type: number): SocketType {
  if (idname.startsWith('NodeSocketFloat')) return 'float';
  if (idname.startsWith('NodeSocketVector')) return 'vector';
  if (idname.startsWith('NodeSocketColor')) return 'color';
  if (idname.startsWith('NodeSocketShader')) return 'shader';
  if (idname.startsWith('NodeSocketBool')) return 'bool';
  if (idname.startsWith('NodeSocketInt')) return 'int';
  return ([ 'float', 'vector', 'color', 'shader', 'bool' ] as const)[type] ?? 'other';
}

function readSocket(s: BlendObject): ShaderSocket {
  const idname = s.str('idname');
  const type = socketType(idname, s.num('type'));
  const out: ShaderSocket = { id: s.str('identifier'), name: s.str('name'), type, idname, enabled: (s.num('flag') & SOCK_UNAVAIL) === 0 };
  const dv = s.ptr('default_value');
  if (dv) {
    switch (dv.typeName) {
      case 'bNodeSocketValueFloat': out.value = dv.num('value'); break;
      case 'bNodeSocketValueInt': out.value = dv.num('value'); break;
      case 'bNodeSocketValueBoolean': out.value = dv.num('value') !== 0; break;
      case 'bNodeSocketValueVector': out.value = dv.nums('value', 3); break;
      case 'bNodeSocketValueRGBA': out.value = dv.nums('value', 4); break;
      default: break;
    }
  }
  return out;
}

function readRamp(cb: BlendObject): ColorRamp {
  const tot = cb.num('tot');
  const data = cb.sub('data');
  const elements: ColorRamp['elements'] = [];
  const cbData = cb.file.structByName.get('CBData')!;
  for (let i = 0; i < tot; i++) {
    const e = new (Object.getPrototypeOf(cb).constructor)(cb.file, cbData, data.offset + i * cbData.size, cb.block) as BlendObject;
    elements.push({ pos: e.num('pos'), color: [e.num('r'), e.num('g'), e.num('b'), e.num('a')] });
  }
  elements.sort((a, b) => a.pos - b.pos);
  const interp = (['linear', 'ease', 'bspline', 'cardinal', 'constant'] as const)[cb.num('ipotype')] ?? 'linear';
  const colorMode = (['rgb', 'hsv', 'hsl'] as const)[cb.num('color_mode')] ?? 'rgb';
  return { interpolation: interp, colorMode, elements };
}

function readTree(nt: BlendObject, seen: Map<bigint, ShaderTree>): ShaderTree {
  const key = nt.block.old;
  const hit = seen.get(key);
  if (hit) return hit;
  const tree: ShaderTree = { name: nt.sub('id').str('name').slice(2), nodes: [], links: [] };
  seen.set(key, tree);
  const nodeByPtr = new Map<bigint, string>();
  const sockByPtr = new Map<bigint, string>();
  for (const n of nt.list('nodes', 'bNode')) {
    const idname = n.str('idname');
    const flag = n.num('flag');
    const storageObj = n.ptr('storage');
    const node: ShaderNode = {
      name: n.str('name'), idname, label: n.str('label'), mute: (flag & NODE_MUTED) !== 0, activeOutput: (flag & NODE_DO_OUTPUT) !== 0,
      custom1: n.num('custom1'), custom2: n.num('custom2'), custom3: n.num('custom3'), custom4: n.num('custom4'),
      storage: storageObj ? storageObj.plain() : null, storageType: storageObj?.typeName ?? null,
      ramp: storageObj?.typeName === 'ColorBand' ? readRamp(storageObj) : null,
      group: null, image: null, inputs: [], outputs: [],
    };
    if (idname === 'ShaderNodeGroup') {
      const g = n.ptr('id', 'bNodeTree');
      if (g) node.group = readTree(g, seen);
    }
    if (idname === 'ShaderNodeTexImage' || idname === 'ShaderNodeTexEnvironment') {
      const im = n.ptr('id', 'Image');
      if (im) node.image = readImage(im);
    }
    nodeByPtr.set(n.block.old + BigInt(n.offset - n.block.offset), node.name);
    for (const s of n.list('inputs', 'bNodeSocket')) { const so = readSocket(s); node.inputs.push(so); sockByPtr.set(s.block.old, so.id); }
    for (const s of n.list('outputs', 'bNodeSocket')) { const so = readSocket(s); node.outputs.push(so); sockByPtr.set(s.block.old, so.id); }
    tree.nodes.push(node);
  }
  for (const l of nt.list('links', 'bNodeLink')) {
    const from = nodeByPtr.get(l.ptrValue('fromnode')), to = nodeByPtr.get(l.ptrValue('tonode'));
    const fs = sockByPtr.get(l.ptrValue('fromsock')), ts = sockByPtr.get(l.ptrValue('tosock'));
    if (from && to && fs && ts) tree.links.push({ from: [from, fs], to: [to, ts], mute: (l.num('flag') & NODE_LINK_MUTED) !== 0 });
  }
  return tree;
}

/** Image name, path and packed bytes (`Image.packedfiles` list, or the legacy `packedfile` pointer). */
function readImage(im: BlendObject): BlendImage {
  const name = im.sub('id').str('name').slice(2);
  const filepath = im.has('filepath') ? im.str('filepath') : '';
  let pf: BlendObject | null = null;
  if (im.has('packedfiles')) pf = im.list('packedfiles', 'ImagePackedFile')[0]?.ptr('packedfile', 'PackedFile') ?? null;
  if (!pf && im.has('packedfile')) pf = im.ptr('packedfile', 'PackedFile');
  let packed: Uint8Array | null = null;
  if (pf) {
    const size = pf.num('size');
    const data = pf.ptr('data');
    if (data && size > 0 && data.offset + size <= im.file.bytes.length) packed = im.file.bytes.slice(data.offset, data.offset + size);
  }
  return { name, filepath, packed };
}

/** Every material in the file, in file order. */
export function readMaterials(file: BlendFile): BlendMaterial[] {
  const seen = new Map<bigint, ShaderTree>();
  const out: BlendMaterial[] = [];
  for (const b of file.blocksByCode('MA')) {
    const m = file.obj(b);
    const useNodes = m.num('use_nodes') !== 0;
    const nt = useNodes ? m.ptr('nodetree', 'bNodeTree') : null;
    out.push({
      name: m.sub('id').str('name').slice(2),
      useNodes,
      tree: nt ? readTree(nt, seen) : null,
      viewport: { color: [m.num('r'), m.num('g'), m.num('b'), m.num('a')], metallic: m.num('metallic'), roughness: m.num('roughness') },
    });
  }
  return out;
}
