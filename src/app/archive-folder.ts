/**
 * Where an archive lives in the browser (docs/33-object-archive.md §3, §8):
 * a folder on disk through the File System Access API (Chrome / Edge — the
 * handle is kept in IndexedDB so the folder survives a reload), or, where the
 * API is missing, a folder picked per session and read only — saving there
 * downloads the file instead. The bridge (scripts/deco.mjs) reads the same
 * folders from Node with no browser API at all.
 */
import { settingGet, settingSet } from './autosave';
import { ITEM_EXT, itemFileName, readItem, type ArchiveItem } from './archive';

export interface ArchiveEntry {
  /** path within the folder, e.g. `brackets/corner-90.deco.json` */
  file: string;
  name: string;
  /** a data URL, or null */
  thumb: string | null;
  tags: string[];
  created: string;
  size: number;
}

export interface ArchiveFolder {
  readonly name: string;
  readonly writable: boolean;
  /** a stored handle needs the user's ok again after a reload */
  permitted(): Promise<boolean>;
  /** ask for it — must run from a click */
  request(): Promise<boolean>;
  /** the items: the folder and one level of subfolders */
  list(): Promise<ArchiveEntry[]>;
  read(file: string): Promise<unknown>;
  /** write `<slug>.deco.json` and its `.png` sidecar; returns the file name */
  write(item: ArchiveItem): Promise<string>;
}

// the File System Access API, as much of it as is used (TS's DOM lib does not carry all of it)
type Perm = 'granted' | 'denied' | 'prompt';
interface FsHandle { kind: 'file' | 'directory'; name: string; queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Perm>; requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Perm> }
interface FsFile extends FsHandle { kind: 'file'; getFile(): Promise<File>; createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }> }
interface FsDir extends FsHandle { kind: 'directory'; values(): AsyncIterable<FsFile | FsDir>; getFileHandle(name: string, o?: { create?: boolean }): Promise<FsFile>; getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<FsDir> }

const HANDLE_KEY = 'archive-folder';
export const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const isItem = (name: string) => name.toLowerCase().endsWith(ITEM_EXT);
const pngOf = (name: string) => `${name.slice(0, -ITEM_EXT.length)}.png`;

function dataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}

/** One listing row from a file's contents; null when the file is not an item. */
async function entryOf(file: string, blob: File, sidecar: () => Promise<string | null>): Promise<ArchiveEntry | null> {
  let raw: unknown;
  try { raw = JSON.parse(await blob.text()); } catch { return null; }
  const item = readItem(raw);
  if (!item) return null;
  const thumb = item.item.thumbnail ?? await sidecar();
  return { file, name: item.name, thumb, tags: item.item.tags, created: item.item.created, size: blob.size };
}

/** A folder on disk. */
class DirFolder implements ArchiveFolder {
  readonly writable = true;
  constructor(private readonly dir: FsDir) {}
  get name(): string { return this.dir.name; }
  async permitted(): Promise<boolean> { return ((await this.dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted') === 'granted'; }
  async request(): Promise<boolean> { return ((await this.dir.requestPermission?.({ mode: 'readwrite' })) ?? 'granted') === 'granted'; }

  async list(): Promise<ArchiveEntry[]> {
    const out: ArchiveEntry[] = [];
    const scan = async (dir: FsDir, prefix: string, deeper: boolean): Promise<void> => {
      const files = new Map<string, FsFile>(), subs: FsDir[] = [];
      for await (const h of dir.values()) { if (h.kind === 'file') files.set(h.name, h); else if (deeper) subs.push(h); }
      for (const [name, h] of files) {
        if (!isItem(name)) continue;
        const png = files.get(pngOf(name));
        const e = await entryOf(prefix + name, await h.getFile(), async () => (png ? dataUrl(await png.getFile()) : null));
        if (e) out.push(e);
      }
      for (const sub of subs.sort((a, b) => a.name.localeCompare(b.name))) await scan(sub, `${prefix}${sub.name}/`, false);
    };
    await scan(this.dir, '', true);
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }

  private async handle(path: string, create = false): Promise<FsFile> {
    const parts = path.split('/');
    let dir = this.dir;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async read(file: string): Promise<unknown> { return JSON.parse(await (await (await this.handle(file)).getFile()).text()); }

  async write(item: ArchiveItem): Promise<string> {
    const name = itemFileName(item);
    const w = await (await this.handle(name, true)).createWritable();
    await w.write(JSON.stringify(item));
    await w.close();
    if (item.item.thumbnail) {
      const pw = await (await this.handle(pngOf(name), true)).createWritable();
      await pw.write(await (await fetch(item.item.thumbnail)).blob());
      await pw.close();
    }
    return name;
  }
}

/** The files of a folder picked with `<input webkitdirectory>` — read only, gone on reload. */
class FilesFolder implements ArchiveFolder {
  readonly writable = false;
  readonly name: string;
  private readonly files = new Map<string, File>();
  constructor(files: File[]) {
    const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const root = rel(files[0] ?? new File([], '')).split('/')[0];
    this.name = root || 'folder';
    for (const f of files) {
      const parts = rel(f).split('/');
      const path = parts[0] === root ? parts.slice(1).join('/') : parts.join('/');
      if (path.split('/').length <= 2) this.files.set(path, f);   // the folder and one level down
    }
  }
  async permitted(): Promise<boolean> { return true; }
  async request(): Promise<boolean> { return true; }
  async list(): Promise<ArchiveEntry[]> {
    const out: ArchiveEntry[] = [];
    for (const [path, f] of this.files) {
      if (!isItem(path)) continue;
      const png = this.files.get(pngOf(path));
      const e = await entryOf(path, f, async () => (png ? dataUrl(png) : null));
      if (e) out.push(e);
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }
  async read(file: string): Promise<unknown> {
    const f = this.files.get(file);
    if (!f) throw new Error(`${file} is not in ${this.name}`);
    return JSON.parse(await f.text());
  }
  async write(item: ArchiveItem): Promise<string> { return downloadItem(item); }
}

/** Save an item as a download (the thumbnail stays inside the file). Returns the file name. */
export function downloadItem(item: ArchiveItem): string {
  const name = itemFileName(item);
  const url = URL.createObjectURL(new Blob([JSON.stringify(item)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** Ask for a folder on disk and remember it; null when the dialog is cancelled or the API is missing. */
export async function pickFolder(): Promise<ArchiveFolder | null> {
  if (!canPickFolder) return null;
  try {
    const dir = await (window as unknown as { showDirectoryPicker(o: { mode: string; id: string }): Promise<FsDir> }).showDirectoryPicker({ mode: 'readwrite', id: 'deco-archive' });
    await settingSet(HANDLE_KEY, dir).catch(() => undefined);
    return new DirFolder(dir);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return null;
    throw e;
  }
}

/** The folder picked last time, if the browser kept its handle. */
export async function restoreFolder(): Promise<ArchiveFolder | null> {
  const dir = await settingGet<FsDir>(HANDLE_KEY);
  return dir && dir.kind === 'directory' ? new DirFolder(dir) : null;
}

export function forgetFolder(): Promise<void> { return settingSet(HANDLE_KEY, undefined); }

/** The fallback picker: a folder's files for this session, read only. */
export function pickFolderFiles(): Promise<ArchiveFolder | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.onchange = () => { const files = [...(input.files ?? [])]; resolve(files.length ? new FilesFolder(files) : null); };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
