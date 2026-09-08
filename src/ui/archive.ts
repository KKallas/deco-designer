/**
 * The archive browser (docs/33-object-archive.md §8): the popup under
 * ▦ Insert on the left rail — the folder, a filter, a grid of thumbnails; a
 * click brings the item into the selected object. The folder comes back from
 * IndexedDB on load where the browser can keep it (src/app/archive-folder.ts).
 */
import { btn, el } from './dom';
import { canPickFolder, forgetFolder, pickFolder, pickFolderFiles, restoreFolder, type ArchiveEntry, type ArchiveFolder } from '../app/archive-folder';

export class ArchiveBrowser {
  readonly root = el('div', { class: 'pop archive' });
  private folder: ArchiveFolder | null = null;
  private entries: ArchiveEntry[] | null = null;
  private permitted = true;
  private filter = '';
  private error = '';
  private loading = false;

  constructor(private readonly on: { insert: (raw: unknown, name: string) => void; status: (text: string) => void }) {
    // a click inside must not count as "outside the rail" for the popup closer (main.ts)
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.render();
    restoreFolder().then((f) => { this.folder = f; return this.refresh(); }).catch(() => this.render());
  }

  /** The folder in use — saves go here when it is writable. */
  get current(): ArchiveFolder | null { return this.folder; }

  async setFolder(f: ArchiveFolder | null): Promise<void> {
    this.folder = f;
    this.entries = null;
    await this.refresh();
  }

  /** Re-read the folder. */
  async refresh(): Promise<void> {
    this.error = '';
    const f = this.folder;
    if (!f) { this.entries = null; this.render(); return; }
    this.loading = true;
    this.render();
    try {
      this.permitted = await f.permitted();
      this.entries = this.permitted ? await f.list() : null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.entries = null;
    }
    this.loading = false;
    this.render();
  }

  private async choose(): Promise<void> {
    try {
      const f = canPickFolder ? await pickFolder() : await pickFolderFiles();
      if (f) await this.setFolder(f);
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); this.render(); }
  }

  private async allow(): Promise<void> {
    if (!this.folder) return;
    if (await this.folder.request()) await this.refresh();
  }

  private async insert(e: ArchiveEntry): Promise<void> {
    if (!this.folder) return;
    try {
      this.on.insert(await this.folder.read(e.file), e.name);
    } catch (err) { this.error = err instanceof Error ? err.message : String(err); this.render(); }
  }

  render(): void {
    const f = this.folder;
    const q = this.filter.trim().toLowerCase();
    const shown = (this.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)) || e.file.toLowerCase().includes(q));
    const filter = el('input', {
      class: 'arc-filter', type: 'search', placeholder: 'Filter by name or tag', value: this.filter,
      oninput: (ev: Event) => { this.filter = (ev.target as HTMLInputElement).value; this.render(); },
    });
    const head = el('div', { class: 'arc-head' },
      el('span', { class: 'name', title: f ? (f.writable ? 'The archive folder — items are saved here' : 'Read only this session (this browser cannot keep a folder) — saving downloads the file') : 'No archive folder yet' }, f ? `${f.name}${f.writable ? '' : ' · read only'}` : 'No folder'),
      btn(f ? 'Change…' : (canPickFolder ? 'Folder…' : 'Open…'), () => { void this.choose(); }, { title: canPickFolder ? 'Pick the archive folder on disk (kept across reloads)' : 'Open a folder of items for this session' }),
      ...(f ? [btn('↻', () => { void this.refresh(); }, { title: 'Re-read the folder' })] : []),
      ...(f && canPickFolder ? [btn('✕', () => { void forgetFolder().then(() => this.setFolder(null)); }, { title: 'Forget this folder' })] : []),
    );
    const body: HTMLElement[] = [];
    if (!f) body.push(el('div', { class: 'arc-msg' }, canPickFolder ? 'Pick a folder of items — every .deco.json in it (and one level of subfolders) shows here.' : 'This browser cannot keep a folder between reloads: open one for this session, or drop a .deco.json file on the viewport.'));
    else if (!this.permitted) body.push(btn(`Allow access to ${f.name}`, () => { void this.allow(); }, { class: 'primary', title: 'The browser asks again after a reload' }));
    else if (this.loading && !this.entries) body.push(el('div', { class: 'arc-msg' }, 'Reading…'));
    else if (this.entries && !this.entries.length) body.push(el('div', { class: 'arc-msg' }, `No items in ${f.name} yet — ⤓ Archive saves the selected object here.`));
    else if (this.entries) {
      body.push(filter);
      body.push(el('div', { class: 'arc-grid' }, ...shown.map((e) => el('button', {
        class: 'btn arc-tile', title: `${e.name}${e.tags.length ? ` · ${e.tags.join(', ')}` : ''}\n${e.file} · ${Math.max(1, Math.round(e.size / 1024))} kB${e.created ? ` · ${e.created.slice(0, 10)}` : ''}\nClick to bring it in`,
        onclick: (ev: Event) => { ev.stopPropagation(); void this.insert(e); },
      }, e.thumb ? el('img', { src: e.thumb, alt: '' }) : el('span', { class: 'ph' }, '▣'), el('span', { class: 'name' }, e.name)))));
      if (q && !shown.length) body.push(el('div', { class: 'arc-msg' }, 'Nothing matches.'));
    }
    if (this.error) body.push(el('div', { class: 'arc-msg err' }, this.error));
    const active = document.activeElement === this.root.querySelector('.arc-filter');
    this.root.replaceChildren(head, ...body);
    if (active) { filter.focus(); filter.setSelectionRange(filter.value.length, filter.value.length); }
  }
}
