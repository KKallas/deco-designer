/**
 * Designer ↔ materials page (docs/13-material-editor.md). The designer tab
 * owns the store; the materials page (materials.html, its own tab) mirrors
 * the project over a BroadcastChannel and sends commands back — each call is
 * run through the designer's store, so it is undoable there and shows in its
 * viewport at once. Same origin only; nothing leaves the browser.
 */
import type { Store } from './store';
import * as cmd from './commands';
import type { Id, Project, Vec3 } from '../model/types';

const NAME = 'deco-designer';
/** The pages that mirror the designer: window name → path (docs/13-material-editor.md, docs/14-shapes.md). */
export const PAGES = { 'deco-materials': '/materials.html', 'deco-shapes': '/shapes.html' } as const;
export type PageName = keyof typeof PAGES;

/** Live viewer state the camera page reads (docs/15-camera.md). */
export interface ViewInfo { position: Vec3; target: Vec3; fov: number; aspect: number; postError: string | null }
export interface ChannelState { project: Project; selection: { curves: Id[]; loftId: Id | null; shapeId: Id | null }; viewer: ViewInfo | null }
/** What the designer offers a page beyond commands: the viewer's pose and focus helpers. */
export interface ViewerExtras { view(): ViewInfo; setView(position: Vec3, target: Vec3): void; fit(): void; selectionDistance(): number | null }
interface Call { name: string; args: unknown[] }
type Msg =
  | { kind: 'hello' } | { kind: 'bye' } | { kind: 'state'; state: ChannelState }
  | { kind: 'call'; id: string; calls: Call[] } | { kind: 'result'; id: string; ok: boolean; value?: unknown; error?: string }
  | { kind: 'show'; page: PageName; id: Id | null } | { kind: 'ping' } | { kind: 'pong' };

/** Commands the page may run (docs/13-material-editor.md §2). */
const ALLOWED = new Set([
  'addMaterial', 'updateMaterial', 'removeMaterial', 'duplicateMaterial', 'moveMaterial', 'setCurveMaterial', 'setLoftMaterial', 'addLibraryMaterial', 'addTexture', 'updateTexture', 'removeTexture', 'moveTexture',
  'addProfile', 'updateProfile', 'removeProfile', 'duplicateProfile', 'moveProfile', 'setCurveProfile', 'setCurveParams', 'setLimit',
  'addFill', 'updateFill', 'removeFill', 'duplicateFill', 'moveFill', 'addShapeLayer', 'updateShapeLayer', 'addOutlineLayer', 'updateOutlineLayer',
  'addCamera', 'updateCamera', 'setCameraPose', 'removeCamera', 'duplicateCamera', 'moveCamera', 'setActiveCamera', 'setPost', 'setWorld',
  'addAnimation', 'updateAnimation', 'removeAnimation', 'moveAnimation', 'setCurvePixels', 'chainCurvePixels', 'setPlayback',
]);
/** Argument placeholder replaced by the previous call's return value (e.g. the id of a just-added material). */
export const PREV = '$prev';

// -- designer side -------------------------------------------------------------------

export function hostChannel(store: Store, extras: ViewerExtras | null = null): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(NAME);
  let listeners = 0;
  let timer = 0;
  const state = (): ChannelState => ({ project: store.project, selection: { curves: store.selection.curves, loftId: store.selection.loftId, shapeId: store.selection.shapeId }, viewer: extras ? extras.view() : null });
  const VIEWER_CALLS: Record<string, (...a: unknown[]) => unknown> = {
    // a number field dragged on a page is one undo step here too (docs/25-number-fields.md §3)
    'live.begin': () => store.beginLive(),
    'live.end': () => store.endLive(),
    'viewer.setView': (p, t) => extras?.setView(p as Vec3, t as Vec3),
    'viewer.fit': () => extras?.fit(),
    'viewer.selectionDistance': () => extras?.selectionDistance() ?? null,
  };
  const send = () => { timer = 0; ch.postMessage({ kind: 'state', state: state() } satisfies Msg); };
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m.kind === 'hello') { listeners++; send(); }
    else if (m.kind === 'bye') { listeners = Math.max(0, listeners - 1); store.cancelLive(); }   // a page closed mid-drag must not hold the history open
    else if (m.kind === 'ping') ch.postMessage({ kind: 'pong' } satisfies Msg);
    else if (m.kind === 'call') {
      void store.transaction(() => {
        let prev: unknown;
        for (const c of m.calls) {
          const args = c.args.map((a) => (a === PREV ? prev : a));
          if (VIEWER_CALLS[c.name]) { prev = VIEWER_CALLS[c.name](...args); continue; }
          if (!ALLOWED.has(c.name)) throw new Error(`command ${c.name} is not allowed from a page`);
          const fn = (cmd as unknown as Record<string, (s: Store, ...a: unknown[]) => unknown>)[c.name];
          prev = fn(store, ...args);
        }
        return prev;
      }).then(
        (value) => ch.postMessage({ kind: 'result', id: m.id, ok: true, value } satisfies Msg),
        (err: unknown) => ch.postMessage({ kind: 'result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Msg),
      );
    }
  };
  // state changes arrive in bursts (drags): coalesce, and only while a page listens
  store.subscribe(() => { if (listeners && !timer) timer = window.setTimeout(send, 120); });
  // the camera pose is not store state: refresh it for listeners twice a second
  window.setInterval(() => { if (listeners && extras && !timer) timer = window.setTimeout(send, 0); }, 500);
}

/** Open (or focus) a page in its named tab, at an item (`?id=`). Called from a click — popup blockers allow it. */
export function openPage(page: PageName, id: Id | null = null): void {
  const url = `${PAGES[page]}${id ? `?id=${encodeURIComponent(id)}` : ''}`;
  const w = window.open('', page);
  if (!w) { window.open(url, page); return; }
  let blank = true;
  try { blank = w.location.href === 'about:blank'; } catch { blank = false; }
  if (blank) w.location.href = url;
  else {
    if (typeof BroadcastChannel !== 'undefined') { const ch = new BroadcastChannel(NAME); ch.postMessage({ kind: 'show', page, id } satisfies Msg); ch.close(); }
    w.focus();
  }
}
export const openMaterialsPage = (id: Id | null = null): void => openPage('deco-materials', id);
export const openShapesPage = (id: Id | null = null): void => openPage('deco-shapes', id);

// -- page side -----------------------------------------------------------------------

/** The materials page's view of the designer: `state` (null until a designer tab answers), `call` to change it. */
export class EditorClient {
  state: ChannelState | null = null;
  onState: () => void = () => {};
  onShow: (id: Id | null) => void = () => {};
  private ch: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME);
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;

  /** `page`: which page this is, so `show` messages for the other page are ignored. */
  constructor(private page: PageName) {
    if (!this.ch) return;
    this.ch.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.kind === 'state') { this.state = m.state; this.onState(); }
      else if (m.kind === 'show') { if (m.page === this.page) this.onShow(m.id); }
      else if (m.kind === 'result') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error ?? 'failed'));
      }
    };
    this.ch.postMessage({ kind: 'hello' } satisfies Msg);
    window.addEventListener('pagehide', () => this.ch?.postMessage({ kind: 'bye' } satisfies Msg));
  }

  get connected(): boolean { return !!this.state; }

  /** Run commands in the designer as one undo step; resolves with the last return value. `PREV` in args = the previous result. */
  call(...calls: (Call | [string, ...unknown[]])[]): Promise<unknown> {
    const list: Call[] = calls.map((c) => (Array.isArray(c) ? { name: c[0], args: c.slice(1) } : c));
    if (!this.ch) return Promise.reject(new Error('BroadcastChannel is not available in this browser'));
    const id = `${Date.now()}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error('the designer tab did not answer — is it open?')); }, 5000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ch!.postMessage({ kind: 'call', id, calls: list } satisfies Msg);
    });
  }
}
