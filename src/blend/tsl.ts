/**
 * Blender shader node tree → TSL (three.js node material) JavaScript source.
 * docs/09-blender-import.md. The output is a readable arrow function
 * `(tsl, host) => material` — see src/materials/runtime.ts for how it is run.
 * Every unsupported or approximated node adds a warning; the graph still builds.
 */
import type { BlendImage, BlendMaterial, ColorRamp, ShaderLink, ShaderNode, ShaderSocket, ShaderTree, SocketType } from './shaders';
import { slug } from '../model/types';

/** An image the converted code samples through `host.texture(id)` (docs/13-material-editor.md). */
export interface ConvertedImage { id: string; name: string; filepath: string; packed: Uint8Array | null }
export interface Converted { name: string; code: string; warnings: string[]; images: ConvertedImage[] }

/** Texture id for a Blender image datablock: the name without its extension, slugged (`net.png` → `net`). */
export function imageId(name: string): string {
  return slug(name.replace(/\.[a-z0-9]{2,5}$/i, '')) || slug(name) || 'image';
}

interface Expr { code: string; type: SocketType }

interface Scope {
  id: string;
  tree: ShaderTree;
  nodes: Map<string, ShaderNode>;
  /** `node/socket` → link into it */
  into: Map<string, ShaderLink>;
  /** node group: outer values for the group's input sockets */
  groupInput?: (socketId: string) => Expr;
}

// -- Blender enums (verified against tests/fixtures/golden-net.json) ---------------
export const MATH_OPS: Record<number, string> = { 0: 'ADD', 1: 'SUBTRACT', 2: 'MULTIPLY', 3: 'DIVIDE', 4: 'SINE', 5: 'COSINE', 6: 'TANGENT', 7: 'ARCSINE', 8: 'ARCCOSINE', 9: 'ARCTANGENT', 10: 'POWER', 11: 'LOGARITHM', 12: 'MINIMUM', 13: 'MAXIMUM', 14: 'ROUND', 15: 'LESS_THAN', 16: 'GREATER_THAN', 17: 'MODULO', 18: 'ABSOLUTE', 19: 'ARCTAN2', 20: 'FLOOR', 21: 'CEIL', 22: 'FRACT', 23: 'SQRT', 24: 'INVERSE_SQRT', 25: 'SIGN', 26: 'EXPONENT', 27: 'RADIANS', 28: 'DEGREES', 29: 'SINH', 30: 'COSH', 31: 'TANH', 32: 'TRUNC', 33: 'SNAP', 34: 'WRAP', 35: 'COMPARE', 36: 'MULTIPLY_ADD', 37: 'PINGPONG', 38: 'SMOOTH_MIN', 39: 'SMOOTH_MAX', 40: 'FLOORED_MODULO' };
export const VECTOR_MATH_OPS: Record<number, string> = { 0: 'ADD', 1: 'SUBTRACT', 2: 'MULTIPLY', 3: 'DIVIDE', 4: 'CROSS_PRODUCT', 5: 'PROJECT', 6: 'REFLECT', 7: 'DOT_PRODUCT', 8: 'DISTANCE', 9: 'LENGTH', 10: 'SCALE', 11: 'NORMALIZE', 12: 'SNAP', 13: 'FLOOR', 14: 'CEIL', 15: 'MODULO', 16: 'FRACTION', 17: 'ABSOLUTE', 18: 'MINIMUM', 19: 'MAXIMUM', 20: 'WRAP', 21: 'SINE', 22: 'COSINE', 23: 'TANGENT', 24: 'REFRACT', 25: 'FACEFORWARD', 26: 'MULTIPLY_ADD', 27: 'POWER', 28: 'SIGN', 29: 'ROUND' };
export const BLEND_TYPES: Record<number, string> = { 0: 'MIX', 1: 'ADD', 2: 'MULTIPLY', 3: 'SUBTRACT', 4: 'SCREEN', 5: 'DIVIDE', 6: 'DIFFERENCE', 7: 'DARKEN', 8: 'LIGHTEN', 9: 'OVERLAY', 10: 'DODGE', 11: 'BURN', 12: 'HUE', 13: 'SATURATION', 14: 'VALUE', 15: 'COLOR', 16: 'SOFT_LIGHT', 17: 'LINEAR_LIGHT', 18: 'EXCLUSION' };
export const MAP_RANGE_INTERP: Record<number, string> = { 0: 'LINEAR', 1: 'STEPPED', 2: 'SMOOTHSTEP', 3: 'SMOOTHERSTEP' };
export const VORONOI_FEATURES: Record<number, string> = { 0: 'F1', 1: 'F2', 2: 'SMOOTH_F1', 3: 'DISTANCE_TO_EDGE', 4: 'N_SPHERE_RADIUS' };
export const VORONOI_DISTANCES: Record<number, string> = { 0: 'EUCLIDEAN', 1: 'MANHATTAN', 2: 'CHEBYCHEV', 3: 'MINKOWSKI' };
export const NOISE_TYPES: Record<number, string> = { 0: 'MULTIFRACTAL', 1: 'FBM', 2: 'HYBRID_MULTIFRACTAL', 3: 'RIDGED_MULTIFRACTAL', 4: 'HETERO_TERRAIN' };
export const GRADIENT_TYPES: Record<number, string> = { 0: 'LINEAR', 1: 'QUADRATIC', 2: 'EASING', 3: 'DIAGONAL', 4: 'RADIAL', 5: 'QUADRATIC_SPHERE', 6: 'SPHERICAL' };
export const MAPPING_TYPES: Record<number, string> = { 0: 'POINT', 1: 'TEXTURE', 2: 'VECTOR', 3: 'NORMAL' };
/** NodeTexImage.extension / .projection (DNA_node_types.h) */
export const IMAGE_EXTENSIONS: Record<number, string> = { 0: 'REPEAT', 1: 'EXTEND', 2: 'CLIP', 3: 'MIRROR' };
export const IMAGE_PROJECTIONS: Record<number, string> = { 0: 'FLAT', 1: 'BOX', 2: 'SPHERE', 3: 'TUBE' };
export const ROTATE_TYPES: Record<number, string> = { 0: 'AXIS_ANGLE', 1: 'X_AXIS', 2: 'Y_AXIS', 3: 'Z_AXIS', 4: 'EULER_XYZ' };
export const COLOR_MODES: Record<number, string> = { 0: 'RGB', 1: 'HSV', 2: 'HSL' };

// helpers emitted into the generated code when used
const HELPERS: Record<string, string> = {
  avg: 'const avg = (v) => v.x.add(v.y).add(v.z).div(3);',
  pingpong: 'const pingpong = (a, b) => abs(fract(a.sub(b).div(b.mul(2))).mul(b.mul(2)).sub(b)); // Blender Math › Ping-Pong',
  smoothmin: 'const smoothmin = (a, b, k) => { const h = max(k.sub(abs(a.sub(b))), 0).div(k); return min(a, b).sub(h.mul(h).mul(h).mul(k).mul(1 / 6)); };',
  wrap: 'const wrap = (a, hi, lo) => { const r = hi.sub(lo); return a.sub(r.mul(floor(a.sub(lo).div(r)))); };',
  eulerXYZ: 'const eulerXYZ = (v, r) => rotate(rotate(rotate(v, vec3(r.x, 0, 0)), vec3(0, r.y, 0)), vec3(0, 0, r.z)); // Blender Euler order X, then Y, then Z',
  axisAngle: 'const axisAngle = (v, axis, a) => { const k = normalize(axis); return v.mul(cos(a)).add(cross(k, v).mul(sin(a))).add(k.mul(dot(k, v)).mul(cos(a).oneMinus())); };',
  ramp: 'const ramp = (t, stops) => stops.slice(1).reduce((c, [pos, val], i) => mix(c, val, remapClamp(t, stops[i][0], pos, 0, 1)), stops[0][1]); // piecewise-linear colour ramp',
  rampStep: 'const rampStep = (t, stops) => stops.slice(1).reduce((c, [pos, val]) => select(t.greaterThanEqual(pos), val, c), stops[0][1]); // constant colour ramp',
  voronoiF1: 'const voronoiF1 = (p, jitter) => sqrt(mx_worley_noise_float(p, jitter)); // Blender Voronoi F1 / Euclidean',
  voronoiF2: 'const voronoiF2 = (p, jitter) => sqrt(mx_worley_noise_vec2(p, jitter).y);',
  cellColor: 'const cellColor = (p) => vec3(mx_cell_noise_float(p), mx_cell_noise_float(p.add(vec3(17.3, 5.1, 9.7))), mx_cell_noise_float(p.add(vec3(3.7, 11.9, 23.1)))); // random colour per grid cell (approximates Voronoi › Color)',
  noise: 'const noise = (p, detail, roughness, lacunarity) => mx_fractal_noise_float(p, Math.min(15, Math.floor(detail) + 1), lacunarity, roughness).mul(0.5).add(0.5); // Blender Noise › Fac (fBM)',
  noise3: 'const noise3 = (p, detail, roughness, lacunarity) => mx_fractal_noise_vec3(p, Math.min(15, Math.floor(detail) + 1), lacunarity, roughness).mul(0.5).add(0.5);',
  blend: `const blend = (mode, a, b, f) => { // Blender Mix › Color blend modes
    const r = { MIX: b, ADD: a.add(b), MULTIPLY: a.mul(b), SUBTRACT: a.sub(b), SCREEN: blendScreen(a, b), DIVIDE: a.div(max(b, 1e-6)), DIFFERENCE: abs(a.sub(b)),
      EXCLUSION: a.add(b).sub(a.mul(b).mul(2)), DARKEN: min(a, b), LIGHTEN: max(a, b), OVERLAY: blendOverlay(a, b), DODGE: blendDodge(a, b), BURN: blendBurn(a, b),
      SOFT_LIGHT: a.oneMinus().mul(b).mul(a).add(a.mul(b.oneMinus().mul(a.oneMinus()).oneMinus())), LINEAR_LIGHT: a.add(b.mul(2).sub(1)) }[mode] ?? b;
    return mix(a, r, f);
  };`,
  fresnel: 'const fresnel = () => pow(dot(normalView, positionViewDirection).clamp().oneMinus(), 5); // approximates Blender Fresnel / Layer Weight',
  SHADER: 'const SHADER = { color: color(0.8, 0.8, 0.8), roughness: float(0.5), metalness: float(0), emissive: color(0, 0, 0), opacity: float(1), ior: float(1.5), transmission: float(0), clearcoat: float(0), clearcoatRoughness: float(0), sheen: float(0), sheenRoughness: float(0.5), iridescence: float(0) };',
  mixShader: `const mixShader = (a, b, t) => { // lerp every property the two closures define
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = mix(a[k] ?? SHADER[k], b[k] ?? SHADER[k], t);
    return out;
  };`,
  apply: `const apply = (m, s) => { // shader closure → MeshPhysicalNodeMaterial
    m.colorNode = s.color ?? SHADER.color; m.roughnessNode = s.roughness ?? SHADER.roughness; m.metalnessNode = s.metalness ?? SHADER.metalness;
    if (s.emissive) m.emissiveNode = s.emissive;
    if (s.opacity) { m.opacityNode = s.opacity; m.transparent = true; }
    if (s.ior) m.iorNode = s.ior;
    if (s.transmission) m.transmissionNode = s.transmission;
    if (s.clearcoat) { m.clearcoatNode = s.clearcoat; m.clearcoatRoughnessNode = s.clearcoatRoughness ?? SHADER.clearcoatRoughness; }
    if (s.sheen) { m.sheenNode = s.sheen; m.sheenRoughnessNode = s.sheenRoughness ?? SHADER.sheenRoughness; }
    if (s.iridescence) m.iridescenceNode = s.iridescence;
    return m;
  };`,
};
const HELPER_DEPS: Record<string, string[]> = { mixShader: ['SHADER'], apply: ['SHADER'] };

const fmt = (v: number): string => { const s = Number(v.toPrecision(6)).toString(); return s.includes('e') ? Number(v).toFixed(8).replace(/0+$/, '0') : s; };

class Emitter {
  lines: string[] = [];
  used = new Set<string>();
  helpers = new Set<string>();
  warnings = new Set<string>();
  images = new Map<string, ConvertedImage>();
  private memo = new Map<string, Expr>();
  private counter = 0;

  constructor(private material: BlendMaterial) {}

  /** Register an image the code needs; returns its texture id. Unpacked images are flagged (a browser cannot read them from disk). */
  private image(im: BlendImage): string {
    const hit = [...this.images.values()].find((x) => x.name === im.name);
    if (hit) return hit.id;
    let id = imageId(im.name);
    while (this.images.has(id)) id = `${id}-2`;
    this.images.set(id, { id, name: im.name, filepath: im.filepath, packed: im.packed });
    if (!im.packed) this.warn(`Image "${im.name}" is not packed in the .blend — add the file (${im.filepath || 'unknown path'}) as texture "${id}" in the material editor`);
    return id;
  }

  warn(msg: string): void { this.warnings.add(msg); }
  use(name: string): string { this.used.add(name); return name; }
  helper(name: string): string { this.helpers.add(name); for (const d of HELPER_DEPS[name] ?? []) this.helpers.add(d); return name; }

  bind(code: string, type: SocketType, comment?: string): Expr {
    const name = `${type === 'shader' ? 's' : 'v'}${++this.counter}`;
    this.lines.push(`  const ${name} = ${code};${comment ? ` // ${comment}` : ''}`);
    return { code: name, type };
  }

  lit(value: ShaderSocket['value'], type: SocketType): Expr {
    if (type === 'color') { const c = Array.isArray(value) ? value : [0.8, 0.8, 0.8]; return { code: `${this.use('color')}(${c.slice(0, 3).map(fmt).join(', ')})`, type }; }
    if (type === 'vector') { const c = Array.isArray(value) ? value : [0, 0, 0]; return { code: `${this.use('vec3')}(${c.slice(0, 3).map(fmt).join(', ')})`, type }; }
    const n = typeof value === 'number' ? value : typeof value === 'boolean' ? (value ? 1 : 0) : Array.isArray(value) ? value[0] : 0;
    return { code: `${this.use('float')}(${fmt(n)})`, type: 'float' };
  }

  /** Blender's implicit socket conversions. */
  cast(e: Expr, to: SocketType): Expr {
    if (e.type === to || to === 'other') return e;
    const scalar = e.type === 'float' || e.type === 'int' || e.type === 'bool';
    if (scalar && (to === 'color' || to === 'vector')) return { code: `${this.use('vec3')}(${e.code})`, type: to };
    if (e.type === 'color' && to === 'vector') return { ...e, type: 'vector' };
    if (e.type === 'vector' && to === 'color') return { ...e, type: 'color' };
    if (e.type === 'color' && (to === 'float' || to === 'int' || to === 'bool')) return { code: `${this.use('luminance')}(${e.code})`, type: 'float' };
    if (e.type === 'vector' && (to === 'float' || to === 'int' || to === 'bool')) return { code: `${this.helper('avg')}(${e.code})`, type: 'float' };
    if (scalar && (to === 'float' || to === 'int' || to === 'bool')) return { ...e, type: to };
    return e;
  }

  // -- graph walking ---------------------------------------------------------------

  scope(id: string, tree: ShaderTree, groupInput?: Scope['groupInput']): Scope {
    const into = new Map<string, ShaderLink>();
    for (const l of tree.links) if (!l.mute) into.set(`${l.to[0]}/${l.to[1]}`, l);
    return { id, tree, nodes: new Map(tree.nodes.map((n) => [n.name, n])), into, groupInput };
  }

  /** Value flowing into an input socket: the link, or the socket's default. */
  input(sc: Scope, node: ShaderNode, socketId: string, as?: SocketType): Expr {
    const sock = node.inputs.find((s) => s.id === socketId);
    const want = as ?? sock?.type ?? 'float';
    const link = sc.into.get(`${node.name}/${socketId}`);
    if (link) {
      const from = sc.nodes.get(link.from[0]);
      if (from) return this.cast(this.output(sc, from, link.from[1]), want);
    }
    if (!sock) return this.lit(0, want);
    if (want === 'shader') return { code: '{}', type: 'shader' };
    // unlinked texture coordinates: metres of surface (uv), so a pattern keeps its physical size on any length of curve or loft
    if (sock.type === 'vector' && socketId === 'Vector' && node.idname.startsWith('ShaderNodeTex')) return { code: 'host.uv', type: 'vector' };
    return this.cast(this.lit(sock.value, sock.type), want);
  }

  output(sc: Scope, node: ShaderNode, socketId: string): Expr {
    const key = `${sc.id}/${node.name}/${socketId}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const out = node.outputs.find((s) => s.id === socketId);
    let e: Expr;
    if (node.mute) {
      // muted: the first enabled input of the output's type passes through
      const pass = node.inputs.find((s) => s.enabled && s.type === out?.type) ?? node.inputs[0];
      e = pass ? this.input(sc, node, pass.id, out?.type) : this.lit(0, out?.type ?? 'float');
    } else {
      e = this.node(sc, node, socketId, out);
    }
    this.memo.set(key, e);
    return e;
  }

  private node(sc: Scope, n: ShaderNode, socketId: string, out: ShaderSocket | undefined): Expr {
    const type = out?.type ?? 'float';
    const inp = (id: string, as?: SocketType) => this.input(sc, n, id, as);
    const f = (id: string) => inp(id, 'float').code;
    const v = (id: string) => inp(id, 'vector').code;
    const c = (id: string) => inp(id, 'color').code;
    const num = (id: string, fallback = 0): number => { const s = n.inputs.find((x) => x.id === id); return typeof s?.value === 'number' ? s.value : fallback; };
    const linked = (id: string) => sc.into.has(`${n.name}/${id}`);
    const bind = (code: string, t: SocketType = type, note?: string) => this.bind(code, t, note ?? n.name);
    const U = (name: string) => this.use(name);
    const H = (name: string) => this.helper(name);
    const st = n.storage ?? {};
    const sn = (k: string, fallback = 0): number => (typeof st[k] === 'number' ? (st[k] as number) : fallback);

    switch (n.idname) {
      // -- inputs / constants ---------------------------------------------------------
      case 'ShaderNodeValue': return this.lit(n.outputs[0]?.value, 'float');
      case 'ShaderNodeRGB': return this.lit(n.outputs[0]?.value, 'color');
      case 'ShaderNodeTexCoord': {
        const map: Record<string, string> = { Generated: 'host.generated', Object: 'host.object', UV: 'host.uv', Normal: 'host.normal', Camera: `${U('positionView')}.div(1000)`, Window: `${U('vec3')}(${U('screenUV')}, 0)`, Reflection: `${U('reflectVector')}` };
        if (socketId === 'Camera' || socketId === 'Window' || socketId === 'Reflection') this.warn(`Texture Coordinate › ${socketId} is approximated`);
        return { code: map[socketId] ?? 'host.generated', type: 'vector' };
      }
      case 'ShaderNodeUVMap': return { code: 'host.uv', type: 'vector' };
      case 'ShaderNodeNewGeometry': {
        const map: Record<string, string> = { Position: 'host.position', Normal: U('normalWorld'), 'True Normal': U('normalWorld'), Incoming: U('positionViewDirection'), Parametric: 'host.uv', Backfacing: `${U('float')}(0)`, Pointiness: `${U('float')}(0.5)`, 'Random Per Island': `${U('float')}(0.5)` };
        if (!['Position', 'Normal', 'True Normal'].includes(socketId)) this.warn(`Geometry › ${socketId} is approximated`);
        return { code: map[socketId] ?? 'host.position', type: socketId === 'Backfacing' || socketId === 'Pointiness' || socketId === 'Random Per Island' ? 'float' : 'vector' };
      }
      case 'ShaderNodeObjectInfo': this.warn('Object Info has no equivalent (Random = 0.5, Location = 0)'); return socketId === 'Location' ? { code: `${U('vec3')}(0, 0, 0)`, type: 'vector' } : socketId === 'Color' ? this.lit([1, 1, 1], 'color') : this.lit(socketId === 'Random' ? 0.5 : 0, 'float');
      case 'ShaderNodeFresnel': this.helper('fresnel'); U('normalView'); U('positionViewDirection'); U('pow'); U('dot'); return bind('fresnel()', 'float');
      case 'ShaderNodeLayerWeight': this.helper('fresnel'); U('normalView'); U('positionViewDirection'); U('pow'); U('dot');
        return bind(socketId === 'Facing' ? `${U('dot')}(${U('normalView')}, ${U('positionViewDirection')}).clamp().oneMinus()` : 'fresnel()', 'float');
      case 'NodeReroute': return inp(n.inputs[0]?.id ?? 'Input', type);

      // -- math ------------------------------------------------------------------------
      case 'ShaderNodeMath': {
        const op = MATH_OPS[n.custom1] ?? 'ADD';
        const a = f('Value'), b = f('Value_001'), cc = f('Value_002');
        const code: Record<string, () => string> = {
          ADD: () => `${a}.add(${b})`, SUBTRACT: () => `${a}.sub(${b})`, MULTIPLY: () => `${a}.mul(${b})`, DIVIDE: () => `${a}.div(${b})`, MULTIPLY_ADD: () => `${a}.mul(${b}).add(${cc})`,
          POWER: () => `${U('pow')}(${a}, ${b})`, LOGARITHM: () => `${U('log')}(${a}).div(${U('log')}(${b}))`, SQRT: () => `${U('sqrt')}(${a})`, INVERSE_SQRT: () => `${U('inverseSqrt')}(${a})`,
          ABSOLUTE: () => `${U('abs')}(${a})`, EXPONENT: () => `${U('exp')}(${a})`, MINIMUM: () => `${U('min')}(${a}, ${b})`, MAXIMUM: () => `${U('max')}(${a}, ${b})`,
          LESS_THAN: () => `${U('select')}(${a}.lessThan(${b}), ${U('float')}(1), ${U('float')}(0))`, GREATER_THAN: () => `${U('select')}(${a}.greaterThan(${b}), ${U('float')}(1), ${U('float')}(0))`,
          SIGN: () => `${U('sign')}(${a})`, COMPARE: () => `${U('select')}(${U('abs')}(${a}.sub(${b})).lessThanEqual(${cc}), ${U('float')}(1), ${U('float')}(0))`,
          SMOOTH_MIN: () => { U('max'); U('min'); U('abs'); return `${H('smoothmin')}(${a}, ${b}, ${cc})`; }, SMOOTH_MAX: () => { U('max'); U('min'); U('abs'); return `${H('smoothmin')}(${a}.negate(), ${b}.negate(), ${cc}).negate()`; },
          ROUND: () => `${U('round')}(${a})`, FLOOR: () => `${U('floor')}(${a})`, CEIL: () => `${U('ceil')}(${a})`, TRUNC: () => `${U('trunc')}(${a})`, FRACT: () => `${U('fract')}(${a})`,
          MODULO: () => `${a}.sub(${b}.mul(${U('trunc')}(${a}.div(${b}))))`, FLOORED_MODULO: () => `${a}.sub(${b}.mul(${U('floor')}(${a}.div(${b}))))`,
          WRAP: () => { U('floor'); return `${H('wrap')}(${a}, ${b}, ${cc})`; }, SNAP: () => `${U('floor')}(${a}.div(${b})).mul(${b})`,
          PINGPONG: () => { U('abs'); U('fract'); return `${H('pingpong')}(${a}, ${b})`; },
          SINE: () => `${U('sin')}(${a})`, COSINE: () => `${U('cos')}(${a})`, TANGENT: () => `${U('tan')}(${a})`, ARCSINE: () => `${U('asin')}(${a})`, ARCCOSINE: () => `${U('acos')}(${a})`,
          ARCTANGENT: () => `${U('atan')}(${a})`, ARCTAN2: () => `${U('atan')}(${a}, ${b})`,
          SINH: () => `${U('exp')}(${a}).sub(${U('exp')}(${a}.negate())).div(2)`, COSH: () => `${U('exp')}(${a}).add(${U('exp')}(${a}.negate())).div(2)`, TANH: () => `${U('exp')}(${a}.mul(2)).sub(1).div(${U('exp')}(${a}.mul(2)).add(1))`,
          RADIANS: () => `${U('radians')}(${a})`, DEGREES: () => `${U('degrees')}(${a})`,
        };
        const body = (code[op] ?? code.ADD)();
        return bind(n.custom2 & 1 ? `${body}.clamp()` : body, 'float', `${n.name} · ${op.toLowerCase()}`);
      }
      case 'ShaderNodeVectorMath': {
        const op = VECTOR_MATH_OPS[n.custom1] ?? 'ADD';
        const a = v('Vector'), b = v('Vector_001'), cc = v('Vector_002'), s = f('Scale');
        const floatOps = new Set(['DOT_PRODUCT', 'DISTANCE', 'LENGTH']);
        const code: Record<string, () => string> = {
          ADD: () => `${a}.add(${b})`, SUBTRACT: () => `${a}.sub(${b})`, MULTIPLY: () => `${a}.mul(${b})`, DIVIDE: () => `${a}.div(${b})`, MULTIPLY_ADD: () => `${a}.mul(${b}).add(${cc})`,
          CROSS_PRODUCT: () => `${U('cross')}(${a}, ${b})`, PROJECT: () => `${b}.mul(${U('dot')}(${a}, ${b}).div(${U('dot')}(${b}, ${b})))`, REFLECT: () => `${U('reflect')}(${a}, ${U('normalize')}(${b}))`,
          REFRACT: () => `${U('refract')}(${a}, ${U('normalize')}(${b}), ${s})`, FACEFORWARD: () => `${U('faceForward')}(${a}, ${b}, ${cc})`,
          DOT_PRODUCT: () => `${U('dot')}(${a}, ${b})`, DISTANCE: () => `${U('distance')}(${a}, ${b})`, LENGTH: () => `${U('length')}(${a})`, SCALE: () => `${a}.mul(${s})`, NORMALIZE: () => `${U('normalize')}(${a})`,
          ABSOLUTE: () => `${U('abs')}(${a})`, POWER: () => `${U('pow')}(${a}, ${b})`, SIGN: () => `${U('sign')}(${a})`, MINIMUM: () => `${U('min')}(${a}, ${b})`, MAXIMUM: () => `${U('max')}(${a}, ${b})`,
          ROUND: () => `${U('round')}(${a})`, FLOOR: () => `${U('floor')}(${a})`, CEIL: () => `${U('ceil')}(${a})`, FRACTION: () => `${U('fract')}(${a})`,
          MODULO: () => `${a}.sub(${b}.mul(${U('trunc')}(${a}.div(${b}))))`, WRAP: () => { U('floor'); return `${H('wrap')}(${a}, ${b}, ${cc})`; }, SNAP: () => `${U('floor')}(${a}.div(${b})).mul(${b})`,
          SINE: () => `${U('sin')}(${a})`, COSINE: () => `${U('cos')}(${a})`, TANGENT: () => `${U('tan')}(${a})`,
        };
        return bind((code[op] ?? code.ADD)(), floatOps.has(op) ? 'float' : 'vector', `${n.name} · ${op.toLowerCase()}`);
      }
      case 'ShaderNodeClamp': {
        const a = f('Value'), lo = f('Min'), hi = f('Max');
        return bind(n.custom1 === 1 ? `${U('clamp')}(${a}, ${U('min')}(${lo}, ${hi}), ${U('max')}(${lo}, ${hi}))` : `${U('clamp')}(${a}, ${lo}, ${hi})`, 'float');
      }
      case 'ShaderNodeMapRange': {
        const vec = sn('data_type', 10) === 48;
        const interp = MAP_RANGE_INTERP[sn('interpolation_type')] ?? 'LINEAR';
        const clamp = sn('clamp', 1) !== 0;
        const x = vec ? v('Vector') : f('Value');
        const [a, b, cc, d, steps] = vec ? [v('From_Min_FLOAT3'), v('From_Max_FLOAT3'), v('To_Min_FLOAT3'), v('To_Max_FLOAT3'), v('Steps_FLOAT3')] : [f('From Min'), f('From Max'), f('To Min'), f('To Max'), f('Steps')];
        let body: string;
        if (interp === 'LINEAR') body = `${U(clamp ? 'remapClamp' : 'remap')}(${x}, ${a}, ${b}, ${cc}, ${d})`;
        else {
          const t = `${x}.sub(${a}).div(${b}.sub(${a}))`;
          const tt = interp === 'STEPPED' ? `${U('floor')}(${t}.mul(${steps}.add(1))).div(${steps})` : interp === 'SMOOTHSTEP' ? `${U('smoothstep')}(0, 1, ${t})` : `${U('smoothstep')}(0, 1, ${t}).toVar()`;
          const tv = this.bind(tt, vec ? 'vector' : 'float', `${n.name} · ${interp.toLowerCase()} factor`).code;
          const shaped = interp === 'SMOOTHERSTEP' ? `${tv}.mul(${tv}).mul(${tv}).mul(${tv}.mul(${tv}.mul(6).sub(15)).add(10))` : tv;
          body = `${U('mix')}(${cc}, ${d}, ${shaped})`;
          if (clamp) body = `${U('clamp')}(${body}, ${U('min')}(${cc}, ${d}), ${U('max')}(${cc}, ${d}))`;
        }
        return bind(body, vec ? 'vector' : 'float', `${n.name} · ${interp.toLowerCase()}`);
      }
      case 'ShaderNodeMix': {
        const dt = sn('data_type');
        const mode = BLEND_TYPES[sn('blend_type')] ?? 'MIX';
        const fac = sn('factor_mode') === 1 && dt === 1 ? v('Factor_Vector') : f('Factor_Float');
        const facC = sn('clamp_factor', 1) ? `${fac}.clamp()` : fac;
        if (dt === 0) return bind(`${U('mix')}(${f('A_Float')}, ${f('B_Float')}, ${facC})`, 'float');
        if (dt === 1) return bind(`${U('mix')}(${v('A_Vector')}, ${v('B_Vector')}, ${facC})`, 'vector');
        return bind(this.blendCode(mode, c('A_Color'), c('B_Color'), facC, sn('clamp_result') !== 0), 'color', `${n.name} · ${mode.toLowerCase()}`);
      }
      case 'ShaderNodeMixRGB': {
        const mode = BLEND_TYPES[n.custom1] ?? 'MIX';
        return bind(this.blendCode(mode, c('Color1'), c('Color2'), `${f('Fac')}.clamp()`, (n.custom2 & 2) !== 0), 'color', `${n.name} · ${mode.toLowerCase()}`);
      }
      case 'ShaderNodeValToRGB': {
        const ramp = n.ramp ?? { interpolation: 'linear', colorMode: 'rgb', elements: [{ pos: 0, color: [0, 0, 0, 1] }, { pos: 1, color: [1, 1, 1, 1] }] } as ColorRamp;
        if (ramp.interpolation !== 'linear' && ramp.interpolation !== 'constant') this.warn(`Color Ramp "${n.name}": ${ramp.interpolation} interpolation rendered as linear`);
        if (ramp.colorMode !== 'rgb') this.warn(`Color Ramp "${n.name}": ${ramp.colorMode.toUpperCase()} blending rendered as RGB`);
        const alpha = socketId === 'Alpha';
        const stops = ramp.elements.map((e) => `[${fmt(e.pos)}, ${alpha ? `${U('float')}(${fmt(e.color[3])})` : `${U('color')}(${e.color.slice(0, 3).map(fmt).join(', ')})`}]`).join(', ');
        const fn = ramp.interpolation === 'constant' ? (U('select'), H('rampStep')) : (U('mix'), U('remapClamp'), H('ramp'));
        return bind(`${fn}(${f('Fac')}, [${stops}])`, alpha ? 'float' : 'color');
      }
      case 'ShaderNodeInvert': return bind(`${U('mix')}(${c('Color')}, ${c('Color')}.oneMinus(), ${f('Fac')})`, 'color');
      case 'ShaderNodeGamma': return bind(`${U('pow')}(${U('max')}(${c('Color')}, 0), ${f('Gamma')})`, 'color');
      case 'ShaderNodeBrightContrast': return bind(`${U('max')}(${c('Color')}.mul(${f('Contrast')}.add(1)).add(${f('Bright')}.sub(${f('Contrast')}.div(2))), 0)`, 'color');
      case 'ShaderNodeHueSaturation': {
        const col = c('Color');
        const adj = `${U('hue')}(${U('saturation')}(${col}, ${f('Saturation')}), ${f('Hue')}.sub(0.5).mul(${fmt(Math.PI * 2)})).mul(${f('Value')})`;
        return bind(`${U('mix')}(${col}, ${adj}, ${f('Fac')})`, 'color');
      }
      case 'ShaderNodeRGBToBW': return bind(`${U('luminance')}(${c('Color')})`, 'float');
      case 'ShaderNodeSeparateXYZ': { const x = v('Vector'); return { code: `${x}.${socketId.toLowerCase()}`, type: 'float' }; }
      case 'ShaderNodeCombineXYZ': return bind(`${U('vec3')}(${f('X')}, ${f('Y')}, ${f('Z')})`, 'vector');
      case 'ShaderNodeSeparateColor': case 'ShaderNodeSeparateRGB': {
        const mode = COLOR_MODES[sn('mode')] ?? 'RGB';
        if (mode !== 'RGB') this.warn(`Separate Color "${n.name}": ${mode} mode rendered as RGB`);
        const x = c(n.idname === 'ShaderNodeSeparateRGB' ? 'Image' : 'Color');
        return { code: `${x}.${({ Red: 'r', Green: 'g', Blue: 'b', R: 'r', G: 'g', B: 'b' } as Record<string, string>)[socketId] ?? 'r'}`, type: 'float' };
      }
      case 'ShaderNodeCombineColor': case 'ShaderNodeCombineRGB': {
        if ((COLOR_MODES[sn('mode')] ?? 'RGB') !== 'RGB') this.warn(`Combine Color "${n.name}": non-RGB mode rendered as RGB`);
        const ids = n.idname === 'ShaderNodeCombineRGB' ? ['R', 'G', 'B'] : ['Red', 'Green', 'Blue'];
        return bind(`${U('vec3')}(${ids.map(f).join(', ')})`, 'color');
      }
      case 'ShaderNodeMapping': {
        const mode = MAPPING_TYPES[n.custom1] ?? 'POINT';
        const x = v('Vector'), loc = v('Location'), rot = v('Rotation'), scl = v('Scale');
        U('rotate'); U('vec3');
        const body = mode === 'POINT' ? `${H('eulerXYZ')}(${x}.mul(${scl}), ${rot}).add(${loc})`
          : mode === 'TEXTURE' ? `${H('eulerXYZ')}(${x}.sub(${loc}), ${rot}.negate()).div(${scl})`
          : mode === 'VECTOR' ? `${H('eulerXYZ')}(${x}.mul(${scl}), ${rot})`
          : `${U('normalize')}(${H('eulerXYZ')}(${x}.div(${scl}), ${rot}))`;
        if (mode === 'TEXTURE') this.warn(`Mapping "${n.name}": Texture mode inverse rotation is approximate`);
        return bind(body, 'vector', `${n.name} · ${mode.toLowerCase()}`);
      }
      case 'ShaderNodeVectorRotate': {
        const mode = ROTATE_TYPES[n.custom1] ?? 'AXIS_ANGLE';
        const x = v('Vector'), center = v('Center'), ang = n.custom2 & 1 ? `${f('Angle')}.negate()` : f('Angle');
        U('vec3');
        let body: string;
        if (mode === 'EULER_XYZ') { U('rotate'); body = `${H('eulerXYZ')}(${x}.sub(${center}), ${n.custom2 & 1 ? `${v('Rotation')}.negate()` : v('Rotation')}).add(${center})`; }
        else {
          const axis = mode === 'X_AXIS' ? `${U('vec3')}(1, 0, 0)` : mode === 'Y_AXIS' ? `${U('vec3')}(0, 1, 0)` : mode === 'Z_AXIS' ? `${U('vec3')}(0, 0, 1)` : v('Axis');
          U('normalize'); U('cos'); U('sin'); U('cross'); U('dot');
          body = `${H('axisAngle')}(${x}.sub(${center}), ${axis}, ${ang}).add(${center})`;
        }
        return bind(body, 'vector', `${n.name} · ${mode.toLowerCase()}`);
      }

      // -- textures --------------------------------------------------------------------
      case 'ShaderNodeTexVoronoi': {
        const dims = sn('dimensions', 3), feature = VORONOI_FEATURES[sn('feature')] ?? 'F1', dist = VORONOI_DISTANCES[sn('distance')] ?? 'EUCLIDEAN';
        const p = this.texCoords(sc, n, dims, `${n.name} · coordinates`);
        if (dist !== 'EUCLIDEAN') this.warn(`Voronoi "${n.name}": ${dist.toLowerCase()} distance rendered as euclidean`);
        if (num('Detail') > 0) this.warn(`Voronoi "${n.name}": fractal detail (${fmt(num('Detail'))}) is ignored`);
        if (sn('normalize')) this.warn(`Voronoi "${n.name}": Normalize is ignored`);
        const jitter = f('Randomness');
        if (socketId === 'Color') { U('vec3'); U('mx_cell_noise_float'); this.warn(`Voronoi "${n.name}": Color output approximated by a per-grid-cell random colour`); return bind(`${H('cellColor')}(${p})`, 'color'); }
        if (socketId === 'Position') { this.warn(`Voronoi "${n.name}": Position output is the input coordinates`); return { code: p, type: 'vector' }; }
        if (socketId === 'W') return inp('W', 'float');
        if (socketId === 'Radius') { this.warn(`Voronoi "${n.name}": Radius output is 0`); return this.lit(0, 'float'); }
        if (feature === 'F2') { U('sqrt'); U('mx_worley_noise_vec2'); return bind(`${H('voronoiF2')}(${p}, ${jitter})`, 'float', `${n.name} · F2`); }
        if (feature !== 'F1') this.warn(`Voronoi "${n.name}": ${feature.toLowerCase().replace(/_/g, ' ')} rendered as F1`);
        U('sqrt'); U('mx_worley_noise_float');
        return bind(`${H('voronoiF1')}(${p}, ${jitter})`, 'float', `${n.name} · F1 distance`);
      }
      case 'ShaderNodeTexNoise': {
        const dims = sn('dimensions', 3), kind = NOISE_TYPES[sn('type', 1)] ?? 'FBM';
        const p = this.texCoords(sc, n, dims, `${n.name} · coordinates`);
        if (kind !== 'FBM') this.warn(`Noise "${n.name}": ${kind.toLowerCase().replace(/_/g, ' ')} rendered as fBM`);
        if (num('Distortion') !== 0 || linked('Distortion')) this.warn(`Noise "${n.name}": Distortion is ignored`);
        const args = `${p}, ${fmt(num('Detail', 2))}, ${f('Roughness')}, ${f('Lacunarity')}`;
        if (socketId === 'Color') { U('mx_fractal_noise_vec3'); return bind(`${H('noise3')}(${args})`, 'color'); }
        U('mx_fractal_noise_float');
        return bind(`${H('noise')}(${args})`, 'float');
      }
      case 'ShaderNodeTexChecker': {
        const p = this.bind(`${v('Vector')}.mul(${f('Scale')})`, 'vector', `${n.name} · coordinates`).code;
        const parity = `${U('floor')}(${p}.x).add(${U('floor')}(${p}.y)).add(${U('floor')}(${p}.z)).mod(2)`;
        if (socketId === 'Fac') return bind(`${parity}.lessThan(1).select(${U('float')}(1), ${U('float')}(0))`, 'float');
        return bind(`${U('mix')}(${c('Color2')}, ${c('Color1')}, ${parity}.lessThan(1).select(${U('float')}(1), ${U('float')}(0)))`, 'color');
      }
      case 'ShaderNodeTexGradient': {
        const g = GRADIENT_TYPES[sn('gradient_type')] ?? 'LINEAR';
        const p = v('Vector');
        const code: Record<string, string> = {
          LINEAR: `${p}.x`, QUADRATIC: `${U('max')}(${p}.x, 0).mul(${U('max')}(${p}.x, 0))`, EASING: `${U('smoothstep')}(0, 1, ${p}.x)`, DIAGONAL: `${p}.x.add(${p}.y).div(2)`,
          RADIAL: `${U('atan')}(${p}.y, ${p}.x).div(${fmt(Math.PI * 2)}).add(0.5)`, QUADRATIC_SPHERE: `${U('max')}(${U('length')}(${p}).oneMinus(), 0).pow(2)`, SPHERICAL: `${U('max')}(${U('length')}(${p}).oneMinus(), 0)`,
        };
        const e = bind(code[g] ?? code.LINEAR, 'float', `${n.name} · ${g.toLowerCase()}`);
        return socketId === 'Color' ? this.cast(e, 'color') : e;
      }
      case 'ShaderNodeTexImage': case 'ShaderNodeTexEnvironment': {
        // sampled from a project texture through host.texture(id) — docs/13-material-editor.md
        if (!n.image) { this.warn(`Image texture "${n.name}" has no image — a mid grey is used`); return socketId === 'Alpha' ? this.lit(1, 'float') : this.lit([0.5, 0.5, 0.5], 'color'); }
        const id = this.image(n.image);
        if (n.idname === 'ShaderNodeTexEnvironment') this.warn(`Environment texture "${n.name}" is sampled like an image texture`);
        else {
          const ext = IMAGE_EXTENSIONS[sn('extension')] ?? 'REPEAT', proj = IMAGE_PROJECTIONS[sn('projection')] ?? 'FLAT';
          if (ext !== 'REPEAT') this.warn(`Image texture "${n.name}": extension ${ext.toLowerCase()} rendered as repeat`);
          if (proj !== 'FLAT') this.warn(`Image texture "${n.name}": ${proj.toLowerCase()} projection rendered as flat`);
        }
        // one sample per node, shared by the Color and Alpha outputs
        const sampleKey = `${sc.id}/${n.name}/@sample`;
        let sample = this.memo.get(sampleKey)?.code;
        if (!sample) {
          const p = this.bind(`${v('Vector')}.xy`, 'vector', `${n.name} · coordinates`).code;
          sample = bind(`${U('texture')}(host.texture('${id}'), ${p})`, 'color', `${n.name} · ${n.image.name}`).code;
          this.memo.set(sampleKey, { code: sample, type: 'color' });
        }
        return socketId === 'Alpha' ? { code: `${sample}.a`, type: 'float' } : { code: `${sample}.rgb`, type: 'color' };
      }
      case 'ShaderNodeTexWave': case 'ShaderNodeTexMagic': case 'ShaderNodeTexBrick': case 'ShaderNodeTexMusgrave': case 'ShaderNodeTexSky': case 'ShaderNodeTexWhiteNoise': case 'ShaderNodeTexPointDensity': case 'ShaderNodeTexIES':
        this.warn(`${n.name} (${n.idname.replace('ShaderNodeTex', '')} texture) is not supported — a mid grey is used`); return this.lit(type === 'float' ? 0.5 : [0.5, 0.5, 0.5], type === 'float' ? 'float' : 'color');

      // -- node groups -----------------------------------------------------------------
      case 'ShaderNodeGroup': {
        if (!n.group) { this.warn(`Node group "${n.name}" is missing`); return this.lit(0, type); }
        const inner = this.scope(`${sc.id}/${n.name}`, n.group, (id) => this.input(sc, n, id));
        const go = n.group.nodes.find((x) => x.idname === 'NodeGroupOutput' && x.activeOutput) ?? n.group.nodes.find((x) => x.idname === 'NodeGroupOutput');
        if (!go) return this.lit(0, type);
        return this.cast(this.input(inner, go, socketId, type), type);
      }
      case 'NodeGroupInput': return sc.groupInput ? this.cast(sc.groupInput(socketId), type) : this.lit(0, type);

      // -- shaders ---------------------------------------------------------------------
      case 'ShaderNodeBsdfPrincipled': {
        const props: string[] = [`color: ${c('Base Color')}`, `roughness: ${f('Roughness')}`, `metalness: ${f('Metallic')}`];
        const opt = (id: string, key: string, nonDefault: (x: number) => boolean, code = () => f(id)) => { if (linked(id) || nonDefault(num(id))) props.push(`${key}: ${code()}`); };
        opt('IOR', 'ior', (x) => Math.abs(x - 1.5) > 1e-6);
        opt('Alpha', 'opacity', (x) => x < 1);
        opt('Transmission Weight', 'transmission', (x) => x > 0);
        opt('Coat Weight', 'clearcoat', (x) => x > 0);
        if (linked('Coat Weight') || num('Coat Weight') > 0) props.push(`clearcoatRoughness: ${f('Coat Roughness')}`);
        if (linked('Sheen Weight') || num('Sheen Weight') > 0) { props.push(`sheen: ${c('Sheen Tint')}.mul(${f('Sheen Weight')})`, `sheenRoughness: ${f('Sheen Roughness')}`); }
        opt('Thin Film Thickness', 'iridescence', (x) => x > 0, () => `${f('Thin Film Thickness')}.div(1000).clamp()`);
        if (linked('Emission Strength') || linked('Emission Color') || num('Emission Strength') > 0) props.push(`emissive: ${c('Emission Color')}.mul(${f('Emission Strength')})`);
        if (linked('Normal')) this.warn(`Principled BSDF "${n.name}": Normal input (bump / normal map) is ignored`);
        for (const id of ['Subsurface Weight', 'Anisotropic', 'Specular IOR Level']) if (linked(id)) this.warn(`Principled BSDF "${n.name}": ${id} has no equivalent`);
        return bind(`{ ${props.join(', ')} }`, 'shader');
      }
      case 'ShaderNodeEmission': return bind(`{ color: ${U('color')}(0, 0, 0), emissive: ${c('Color')}.mul(${f('Strength')}) }`, 'shader');
      case 'ShaderNodeBsdfDiffuse': return bind(`{ color: ${c('Color')}, roughness: ${U('float')}(1), metalness: ${U('float')}(0) }`, 'shader');
      case 'ShaderNodeBsdfGlossy': case 'ShaderNodeBsdfMetallic': case 'ShaderNodeBsdfAnisotropic': return bind(`{ color: ${c('Color')}, roughness: ${f('Roughness')}, metalness: ${U('float')}(1) }`, 'shader');
      case 'ShaderNodeBsdfGlass': case 'ShaderNodeBsdfRefraction': return bind(`{ color: ${c('Color')}, roughness: ${f('Roughness')}, metalness: ${U('float')}(0), ior: ${f('IOR')}, transmission: ${U('float')}(1) }`, 'shader');
      case 'ShaderNodeBsdfTransparent': return bind(`{ color: ${c('Color')}, opacity: ${U('float')}(0) }`, 'shader');
      case 'ShaderNodeBsdfTranslucent': case 'ShaderNodeBsdfSheen': case 'ShaderNodeBsdfVelvet': case 'ShaderNodeBsdfToon': case 'ShaderNodeSubsurfaceScattering':
        this.warn(`${n.name} (${n.idname.replace('ShaderNodeBsdf', '')}) rendered as a diffuse surface`); return bind(`{ color: ${c('Color')}, roughness: ${U('float')}(1) }`, 'shader');
      case 'ShaderNodeMixShader': { U('mix'); return bind(`${H('mixShader')}(${inp('Shader', 'shader').code}, ${inp('Shader_001', 'shader').code}, ${f('Fac')}.clamp())`, 'shader'); }
      case 'ShaderNodeAddShader': { U('mix'); this.warn(`Add Shader "${n.name}" rendered as a 50 / 50 mix`); return bind(`${H('mixShader')}(${inp('Shader', 'shader').code}, ${inp('Shader_001', 'shader').code}, ${U('float')}(0.5))`, 'shader'); }
      case 'ShaderNodeHoldout': case 'ShaderNodeVolumeAbsorption': case 'ShaderNodeVolumeScatter': case 'ShaderNodeVolumePrincipled': case 'ShaderNodeBsdfHair': case 'ShaderNodeBsdfHairPrincipled': case 'ShaderNodeBackground':
        this.warn(`${n.name} (${n.idname.replace('ShaderNode', '')}) has no surface equivalent`); return { code: '{}', type: 'shader' };

      // -- pass-through with a warning ------------------------------------------------
      case 'ShaderNodeRGBCurve': this.warn(`RGB Curves "${n.name}" are ignored (colour passes through)`); return inp('Color', 'color');
      case 'ShaderNodeFloatCurve': this.warn(`Float Curve "${n.name}" is ignored (value passes through)`); return inp('Value', 'float');
      case 'ShaderNodeVectorCurve': this.warn(`Vector Curves "${n.name}" are ignored`); return inp('Vector', 'vector');
      case 'ShaderNodeBump': case 'ShaderNodeNormalMap': case 'ShaderNodeDisplacement': case 'ShaderNodeVectorDisplacement': case 'ShaderNodeNormal':
        this.warn(`${n.name} (${n.idname.replace('ShaderNode', '')}) is ignored — surface normals stay flat`); return { code: 'host.normal', type: 'vector' };
      case 'ShaderNodeAttribute': case 'ShaderNodeVertexColor': this.warn(`${n.name} (${n.idname.replace('ShaderNode', '')}) is not available — white is used`); return type === 'float' ? this.lit(1, 'float') : this.lit([1, 1, 1], 'color');
      case 'ShaderNodeBlackbody': this.warn(`Blackbody "${n.name}" rendered as warm white`); return this.lit([1, 0.8, 0.6], 'color');
      case 'ShaderNodeWavelength': this.warn(`Wavelength "${n.name}" rendered as white`); return this.lit([1, 1, 1], 'color');
      case 'ShaderNodeLightPath': this.warn(`Light Path "${n.name}": camera ray = 1, everything else 0`); return this.lit(socketId === 'Is Camera Ray' ? 1 : 0, 'float');
      case 'ShaderNodeAmbientOcclusion': this.warn(`Ambient Occlusion "${n.name}" rendered as its colour input`); return socketId === 'AO' ? this.lit(1, 'float') : inp('Color', 'color');
      case 'ShaderNodeWireframe': case 'ShaderNodeTangent': case 'ShaderNodeBevel': case 'ShaderNodeShaderToRGB': case 'ShaderNodeScript': case 'ShaderNodeCameraData': case 'ShaderNodeParticleInfo': case 'ShaderNodeHairInfo': case 'ShaderNodePointInfo': case 'ShaderNodeCurvesInfo': case 'ShaderNodeVolumeInfo': case 'ShaderNodeUVAlongStroke':
        this.warn(`${n.name} (${n.idname.replace('ShaderNode', '')}) is not supported`); return this.lit(type === 'float' ? 0 : [0, 0, 0], type === 'float' ? 'float' : type === 'vector' ? 'vector' : 'color');
      default:
        this.warn(`${n.name} (${n.idname}) is not supported — its default output is used`);
        return this.lit(out?.value ?? 0, type === 'shader' ? 'float' : type);
    }
  }

  private blendCode(mode: string, a: string, b: string, fac: string, clampResult: boolean): string {
    if (['HUE', 'SATURATION', 'VALUE', 'COLOR'].includes(mode)) this.warn(`Mix › ${mode.toLowerCase()} blend rendered as a plain mix`);
    if (mode === 'MIX') { const m = `${this.use('mix')}(${a}, ${b}, ${fac})`; return clampResult ? `${m}.clamp()` : m; }
    for (const u of ['mix', 'abs', 'min', 'max', 'blendScreen', 'blendOverlay', 'blendDodge', 'blendBurn']) this.use(u);
    const m = `${this.helper('blend')}('${mode}', ${a}, ${b}, ${fac})`;
    return clampResult ? `${m}.clamp()` : m;
  }

  /** Texture input coordinates × Scale, with W folded in for 4D textures. */
  private texCoords(sc: Scope, n: ShaderNode, dims: number, note: string): string {
    const vec = this.input(sc, n, 'Vector', 'vector').code;
    const scale = this.input(sc, n, 'Scale', 'float').code;
    let code = `${vec}.mul(${scale})`;
    if (dims === 4) {
      const wSock = n.inputs.find((x) => x.id === 'W');
      const linked = sc.into.has(`${n.name}/W`);
      const w = typeof wSock?.value === 'number' ? wSock.value : 0;
      const offset = linked ? (() => { const wc = this.input(sc, n, 'W', 'float').code; return `${wc}.mul(7.3), ${wc}.mul(5.1), ${wc}.mul(3.7)`; })() : [7.3, 5.1, 3.7].map((k) => fmt(w * k)).join(', ');
      if (linked || w !== 0) code = `${code}.add(${this.use('vec3')}(${offset}))`;
      this.warn(`${n.name}: 4D noise — W offsets the 3D pattern instead of being a 4th dimension`);
    }
    else if (dims === 2) code = `${this.use('vec3')}(${code}.xy, 0)`;
    else if (dims === 1) { const w = this.input(sc, n, 'W', 'float').code; code = `${this.use('vec3')}(${w}.mul(${scale}), 0, 0)`; }
    return this.bind(code, 'vector', note).code;
  }

  // -- top level -------------------------------------------------------------------

  convert(): Converted {
    const m = this.material;
    let shaderCode: string;
    if (m.tree) {
      const sc = this.scope('', m.tree);
      const out = m.tree.nodes.find((n) => n.idname === 'ShaderNodeOutputMaterial' && n.activeOutput) ?? m.tree.nodes.find((n) => n.idname === 'ShaderNodeOutputMaterial');
      if (out && sc.into.has(`${out.name}/Surface`)) {
        if (sc.into.has(`${out.name}/Displacement`)) this.warn('Material Output › Displacement is ignored');
        if (sc.into.has(`${out.name}/Volume`)) this.warn('Material Output › Volume is ignored');
        shaderCode = this.input(sc, out, 'Surface', 'shader').code;
      } else {
        this.warn('No Material Output with a surface — using the viewport colour');
        shaderCode = this.viewportShader();
      }
    } else shaderCode = this.viewportShader();
    this.helper('apply');
    this.use('MeshPhysicalNodeMaterial'); this.use('DoubleSide'); this.use('float'); this.use('color');
    const warnings = [...this.warnings];
    const header = [
      `// "${m.name}" — Blender shader nodes converted to three.js TSL by Deco Designer (docs/09-blender-import.md).`,
      '// host supplies the coordinates, all in metres: uv (surface — the default for textures, so a pattern keeps its physical size),',
      '// generated (0..1 over the mesh bounds, Blender "Generated"), object (local), position (world), normal.',
      ...(this.images.size ? [`// Textures (host.texture): ${[...this.images.values()].map((i) => `${i.id} = ${i.name}${i.packed ? '' : ' (not packed)'}`).join(', ')}`] : []),
      ...(warnings.length ? ['// Not converted 1:1:', ...warnings.map((w) => `//   - ${w}`)] : []),
    ];
    const helpers = [...this.helpers].sort((a, b) => Object.keys(HELPERS).indexOf(a) - Object.keys(HELPERS).indexOf(b)).map((h) => HELPERS[h].split('\n').map((l) => `  ${l}`).join('\n'));
    const code = [
      ...header,
      '(tsl, host) => {',
      `  const { ${[...this.used].sort().join(', ')} } = tsl;`,
      ...helpers,
      '',
      ...this.lines,
      `  const material = apply(new MeshPhysicalNodeMaterial(), ${shaderCode});`,
      '  material.side = DoubleSide;',
      '  return material;',
      '}',
    ].join('\n');
    return { name: m.name, code, warnings, images: [...this.images.values()] };
  }

  private viewportShader(): string {
    const { color: [r, g, b], metallic, roughness } = this.material.viewport;
    return this.bind(`{ color: ${this.use('color')}(${fmt(r)}, ${fmt(g)}, ${fmt(b)}), roughness: ${this.use('float')}(${fmt(roughness)}), metalness: ${this.use('float')}(${fmt(metallic)}) }`, 'shader', 'viewport display').code;
  }
}

/** Convert one material's node tree to TSL source. */
export function convertMaterial(m: BlendMaterial): Converted {
  return new Emitter(m).convert();
}
