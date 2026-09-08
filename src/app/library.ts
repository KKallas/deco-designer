/**
 * A browser library: a named list in localStorage shared by every tab of the
 * origin (materials — docs/10-materials.md; shapes — docs/14-shapes.md).
 * Saving with an existing id replaces in place; changes fire in this tab and
 * in the others (`storage` event).
 */
export interface LibraryStore<T extends { id: string }> {
  read(): T[];
  /** add or replace (same id) */
  save(entry: T): T;
  remove(id: string): void;
  /** move an entry to `index` */
  move(id: string, index: number): void;
  onChange(cb: () => void): () => void;
}

export function createLibrary<T extends { id: string }>(key: string, accept: (raw: T) => T | null): LibraryStore<T> {
  const EVENT = `deco:library:${key}`;
  const read = (): T[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as T[];
      return Array.isArray(raw) ? raw.map((x) => (x && x.id ? accept(x) : null)).filter((x): x is T => !!x) : [];
    } catch { return []; }
  };
  const write = (list: T[]): void => {
    localStorage.setItem(key, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(EVENT));
  };
  return {
    read,
    save(entry) {
      const list = read();
      const at = list.findIndex((x) => x.id === entry.id);
      if (at < 0) list.push(entry); else list[at] = entry;
      write(list);
      return entry;
    },
    remove(id) { write(read().filter((x) => x.id !== id)); },
    move(id, index) {
      const list = read();
      const from = list.findIndex((x) => x.id === id);
      if (from < 0) return;
      const [item] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(list.length, index)), 0, item);
      write(list);
    },
    onChange(cb) {
      const h = (e: StorageEvent) => { if (e.key === key || e.key === null) cb(); };
      window.addEventListener('storage', h);
      window.addEventListener(EVENT, cb);
      return () => { window.removeEventListener('storage', h); window.removeEventListener(EVENT, cb); };
    },
  };
}
