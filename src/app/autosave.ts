/**
 * The autosave (docs/16-world.md, decision 4): the project JSON in IndexedDB
 * — localStorage's ~5 MB would not hold a project with an HDR. A project
 * saved by an earlier version in localStorage is read once and moved over.
 */
const DB = 'deco', STORE = 'autosave', KEY = 'project';
/** small settings that must outlive a reload and are not JSON — the archive folder handle (docs/33-object-archive.md §8) */
const SETTINGS = 'settings';
const LEGACY_KEY = 'deco/project-v3';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);   // 1 → 2
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, name = STORE): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

/** The last autosaved project (raw, to be migrated), or null. */
export async function loadAutosave(): Promise<unknown | null> {
  try {
    const raw = await withStore<string | undefined>('readonly', (s) => s.get(KEY));
    if (typeof raw === 'string') return JSON.parse(raw);
  } catch (e) { console.warn('autosave: IndexedDB unavailable —', e); }
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return JSON.parse(legacy);
  } catch { /* ignore */ }
  return null;
}

let pending: number | null = null;
let latest = '';

/** Save the project soon (writes are coalesced); errors are logged, never thrown. */
export function saveAutosave(project: unknown): void {
  latest = JSON.stringify(project);
  if (pending !== null) return;
  pending = window.setTimeout(() => {
    pending = null;
    withStore('readwrite', (s) => s.put(latest, KEY))
      .then(() => { try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ } })
      .catch((e) => console.warn('autosave failed —', e));
  }, 250);
}

/** A stored setting (structured-clonable, e.g. a FileSystemDirectoryHandle), or undefined. */
export function settingGet<T>(key: string): Promise<T | undefined> {
  return withStore<T | undefined>('readonly', (s) => s.get(key), SETTINGS).catch(() => undefined);
}

export function settingSet(key: string, value: unknown): Promise<void> {
  if (value === undefined) return withStore<undefined>('readwrite', (s) => s.delete(key), SETTINGS);
  return withStore<IDBValidKey>('readwrite', (s) => s.put(value, key), SETTINGS).then(() => undefined);
}
