/**
 * Material library shared by the designer and the materials page through
 * localStorage (same origin, docs/10-materials.md, docs/13-material-editor.md).
 * The panel's dropdowns offer its entries; picking one copies it into the
 * project (so a saved project stays self-contained).
 */
import { slug, type Material, type Texture } from '../model/types';
import { createLibrary } from '../app/library';

/** A library material carries the textures its code samples, so adding it to a project brings them along. */
export type LibraryMaterial = Material & { textures?: Texture[] };

const lib = createLibrary<LibraryMaterial>('deco/material-library', (m) => (typeof m.code === 'string'
  ? { ...m, source: m.source ?? '', warnings: m.warnings ?? [], textures: (m.textures ?? []).filter((t) => t && t.id && typeof t.data === 'string') }
  : null));

export function readLibrary(): LibraryMaterial[] { return lib.read(); }

/** The material name written in a converted code header: `// "name" — Blender …`. */
export function nameFromCode(code: string): string | null {
  return /^\/\/ "(.+?)" — Blender/.exec(code)?.[1] ?? null;
}

/** Add or replace (same id) a material. An empty name falls back to the code header, then "material". */
export function saveToLibrary(m: Omit<LibraryMaterial, 'id'> & { id?: string }): LibraryMaterial {
  const name = m.name.trim() || nameFromCode(m.code) || 'material';
  return lib.save({ id: m.id ?? slug(name), name, code: m.code, source: m.source ?? '', warnings: m.warnings ?? [], textures: m.textures ?? [] });
}

export function removeFromLibrary(id: string): void { lib.remove(id); }

/** Move an entry to `index` (the order the dropdowns list). */
export function moveInLibrary(id: string, index: number): void { lib.move(id, index); }

/** Fires when the library changes — in this tab or another one. */
export function onLibraryChange(cb: () => void): () => void { return lib.onChange(cb); }
