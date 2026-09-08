/**
 * Minimal .blend reader (docs/09-blender-import.md). Parses the file's own DNA
 * (struct catalogue) and exposes blocks as objects whose fields are read by
 * name, with pointer resolution — enough to walk materials and node trees.
 * Handles the classic header (BLENDER-v405, 20/24-byte block heads) and the
 * large-file header of Blender 5 (BLENDER17-01v0501, 32-byte block heads),
 * zstd (Blender ≥ 3.0 "Compress") and gzip. Little-endian only.
 */
import { decompress as zstd } from 'fzstd';

export interface DnaField { name: string; raw: string; type: string; offset: number; size: number; pointer: boolean; count: number }
export interface DnaStruct { index: number; name: string; size: number; fields: DnaField[]; byName: Map<string, DnaField> }
export interface Block { code: string; sdna: number; old: bigint; offset: number; len: number; count: number }

const td = new TextDecoder('utf-8');

export class BlendFile {
  readonly view: DataView;
  readonly version: string;
  readonly pointerSize: 4 | 8;
  readonly blocks: Block[] = [];
  readonly structs: DnaStruct[] = [];
  readonly structByName = new Map<string, DnaStruct>();
  readonly typeSizes = new Map<string, number>();
  private byOld = new Map<bigint, Block>();
  private sorted: Block[] = [];

  /** Parse bytes; decompresses zstd / gzip first. */
  static async parse(input: ArrayBuffer | Uint8Array): Promise<BlendFile> {
    let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) bytes = zstd(bytes);
    else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const ds = new DecompressionStream('gzip');
      const buf = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
      bytes = new Uint8Array(buf);
    }
    return new BlendFile(bytes);
  }

  private constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = td.decode(bytes.subarray(0, 7));
    if (magic !== 'BLENDER') throw new Error('not a .blend file');
    let pos: number, large: boolean;
    if (bytes[7] === 0x2d || bytes[7] === 0x5f) {
      // classic: BLENDER-v405
      this.pointerSize = bytes[7] === 0x5f ? 4 : 8;
      if (bytes[8] !== 0x76) throw new Error('big-endian .blend files are not supported');
      this.version = `${td.decode(bytes.subarray(9, 12))}`;
      pos = 12; large = false;
    } else {
      // Blender 5: BLENDER17-01v0501 (header size, pointer size, format version, version)
      const headerSize = parseInt(td.decode(bytes.subarray(7, 9)), 10);
      this.pointerSize = bytes[9] === 0x5f ? 4 : 8;
      const format = td.decode(bytes.subarray(10, 12));
      if (format !== '01') throw new Error(`unknown .blend header format ${format}`);
      if (bytes[12] !== 0x76) throw new Error('big-endian .blend files are not supported');
      this.version = td.decode(bytes.subarray(13, headerSize));
      pos = headerSize; large = true;
    }
    // blocks
    while (pos + 4 <= bytes.length) {
      const code = td.decode(bytes.subarray(pos, pos + 4)).replace(/\0+$/, '');
      if (code === 'ENDB') break;
      let b: Block;
      if (large) {
        b = { code, sdna: this.view.getInt32(pos + 4, true), old: this.view.getBigUint64(pos + 8, true), len: Number(this.view.getBigInt64(pos + 16, true)), count: Number(this.view.getBigInt64(pos + 24, true)), offset: pos + 32 };
      } else {
        const len = this.view.getInt32(pos + 4, true);
        const old = this.pointerSize === 8 ? this.view.getBigUint64(pos + 8, true) : BigInt(this.view.getUint32(pos + 8, true));
        const p = pos + 8 + this.pointerSize;
        b = { code, len, old, sdna: this.view.getInt32(p, true), count: this.view.getInt32(p + 4, true), offset: p + 8 };
      }
      this.blocks.push(b);
      if (code === 'DNA1') this.readDna(b.offset);
      pos = b.offset + b.len;
    }
    if (!this.structs.length) throw new Error('no DNA1 block — corrupt .blend?');
    for (const b of this.blocks) if (b.old && !this.byOld.has(b.old)) this.byOld.set(b.old, b);
    this.sorted = this.blocks.filter((b) => b.old).sort((a, b) => (a.old < b.old ? -1 : a.old > b.old ? 1 : 0));
  }

  private readDna(start: number): void {
    const { bytes, view } = this;
    let pos = start;
    const tag = (p: number) => td.decode(bytes.subarray(p, p + 4));
    // Blender pads to 4 bytes relative to the start of the DNA data, not the file
    const align = () => { pos = start + (((pos - start) + 3) & ~3); };
    const int = () => { const v = view.getInt32(pos, true); pos += 4; return v; };
    if (tag(pos) !== 'SDNA' || tag(pos + 4) !== 'NAME') throw new Error('bad DNA1 block');
    pos += 8;
    const readStrings = (count: number) => {
      const out: string[] = [];
      for (let i = 0; i < count; i++) { const s = pos; while (bytes[pos]) pos++; out.push(td.decode(bytes.subarray(s, pos))); pos++; }
      align();
      return out;
    };
    const names = readStrings(int());
    if (tag(pos) !== 'TYPE') throw new Error('bad DNA1 block (TYPE)');
    pos += 4;
    const types = readStrings(int());
    if (tag(pos) !== 'TLEN') throw new Error('bad DNA1 block (TLEN)');
    pos += 4;
    const lens: number[] = [];
    for (let i = 0; i < types.length; i++) { lens.push(view.getInt16(pos, true)); pos += 2; }
    align();
    types.forEach((t, i) => this.typeSizes.set(t, lens[i]));
    if (tag(pos) !== 'STRC') throw new Error('bad DNA1 block (STRC)');
    pos += 4;
    const nStructs = int();
    for (let i = 0; i < nStructs; i++) {
      const typeIdx = view.getInt16(pos, true), nFields = view.getInt16(pos + 2, true); pos += 4;
      const fields: DnaField[] = [];
      let offset = 0;
      for (let f = 0; f < nFields; f++) {
        const ft = types[view.getInt16(pos, true)], raw = names[view.getInt16(pos + 2, true)]; pos += 4;
        const pointer = raw.startsWith('*') || raw.startsWith('(*');
        const dims = [...raw.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10));
        const count = dims.reduce((a, b) => a * b, 1);
        const size = (pointer ? this.pointerSize : lens[types.indexOf(ft)]) * count;
        const name = raw.replace(/^\(?\*+/, '').replace(/\)\(.*$/, '').replace(/\[.*$/, '');
        fields.push({ name, raw, type: ft, offset, size, pointer, count });
        offset += size;
      }
      const s: DnaStruct = { index: i, name: types[typeIdx], size: lens[typeIdx], fields, byName: new Map(fields.map((x) => [x.name, x])) };
      this.structs.push(s);
      this.structByName.set(s.name, s);
    }
  }

  blocksByCode(code: string): Block[] { return this.blocks.filter((b) => b.code === code); }
  structOf(b: Block): DnaStruct { return this.structs[b.sdna]; }

  /** The object at the start of a block (or the `index`-th element of an array block). */
  obj(b: Block, index = 0, struct: DnaStruct = this.structOf(b)): BlendObject {
    return new BlendObject(this, struct, b.offset + index * struct.size, b);
  }

  /** Resolve an old pointer to the object it points at (struct of its block). */
  deref(ptr: bigint, struct?: DnaStruct): BlendObject | null {
    if (!ptr) return null;
    let b = this.byOld.get(ptr);
    let off = 0;
    if (!b) {
      // pointer into the middle of a block (array element)
      let lo = 0, hi = this.sorted.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, x = this.sorted[mid];
        if (x.old > ptr) hi = mid - 1;
        else if (x.old + BigInt(x.len) <= ptr) lo = mid + 1;
        else { b = x; off = Number(ptr - x.old); break; }
      }
      if (!b) return null;
    }
    return new BlendObject(this, struct ?? this.structOf(b), b.offset + off, b);
  }
}

/** A struct instance inside the file; fields are read on demand. */
export class BlendObject {
  constructor(readonly file: BlendFile, readonly struct: DnaStruct, readonly offset: number, readonly block: Block) {}

  get typeName(): string { return this.struct.name; }
  has(field: string): boolean { return this.struct.byName.has(field); }
  private f(field: string): DnaField {
    const x = this.struct.byName.get(field);
    if (!x) throw new Error(`${this.struct.name} has no field ${field}`);
    return x;
  }

  /** Scalar number (first element for arrays). */
  num(field: string, index = 0): number {
    const x = this.f(field), v = this.file.view, p = this.offset + x.offset;
    if (x.pointer) return Number(this.ptrAt(p));
    const elem = x.size / x.count, q = p + index * elem;
    switch (x.type) {
      case 'float': return v.getFloat32(q, true);
      case 'double': return v.getFloat64(q, true);
      case 'int': case 'int32_t': return v.getInt32(q, true);
      case 'uint32_t': return v.getUint32(q, true);
      case 'short': case 'int16_t': return v.getInt16(q, true);
      case 'ushort': case 'uint16_t': return v.getUint16(q, true);
      case 'char': case 'int8_t': return v.getInt8(q);
      case 'uchar': case 'uint8_t': return v.getUint8(q);
      case 'int64_t': return Number(v.getBigInt64(q, true));
      case 'uint64_t': return Number(v.getBigUint64(q, true));
      default: throw new Error(`cannot read ${x.type} ${x.raw} as a number`);
    }
  }

  nums(field: string, n?: number): number[] {
    const x = this.f(field), count = n ?? x.count, out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.num(field, i));
    return out;
  }

  /** Null-terminated char array. */
  str(field: string): string {
    const x = this.f(field), p = this.offset + x.offset, b = this.file.bytes;
    let end = p;
    while (end < p + x.size && b[end]) end++;
    return td.decode(b.subarray(p, end));
  }

  private ptrAt(p: number): bigint {
    return this.file.pointerSize === 8 ? this.file.view.getBigUint64(p, true) : BigInt(this.file.view.getUint32(p, true));
  }

  ptrValue(field: string): bigint { return this.ptrAt(this.offset + this.f(field).offset); }

  /** Follow a pointer field; the target's struct comes from its block unless given. */
  ptr(field: string, struct?: string): BlendObject | null {
    const x = this.f(field);
    if (!x.pointer) throw new Error(`${x.raw} is not a pointer`);
    return this.file.deref(this.ptrAt(this.offset + x.offset), struct ? this.file.structByName.get(struct) : undefined);
  }

  /** Embedded struct field (e.g. `id`, `base`, a ListBase). */
  sub(field: string): BlendObject {
    const x = this.f(field);
    const s = this.file.structByName.get(x.type);
    if (!s) throw new Error(`${x.type} is not a struct`);
    return new BlendObject(this.file, s, this.offset + x.offset, this.block);
  }

  /** Walk a ListBase field (`first` → `next` …). */
  list(field: string, struct?: string): BlendObject[] {
    const out: BlendObject[] = [];
    let cur = this.sub(field).ptr('first', struct);
    let guard = 0;
    while (cur && guard++ < 100000) { out.push(cur); cur = cur.ptr('next', struct ?? cur.struct.name); }
    return out;
  }

  /** Every numeric / string field as a plain object (for node storage). */
  plain(): Record<string, number | number[] | string> {
    const out: Record<string, number | number[] | string> = {};
    for (const x of this.struct.fields) {
      if (x.pointer) continue;
      if (x.type === 'char' && x.count > 1) { out[x.name] = this.str(x.name); continue; }
      if (this.file.structByName.has(x.type)) continue;
      try { out[x.name] = x.count > 1 ? this.nums(x.name) : this.num(x.name); } catch { /* skip */ }
    }
    return out;
  }
}
