import type { Store } from '../app/store';
import * as cmd from '../app/commands';
import { playbackRange, fixturesOf } from '../model/types';
import { btn, el, numField, textField } from './dom';
import { isScrubbing } from './scrub';

export class Topbar {
  private status = el('span', { class: 'status' });
  /** the clock of the transport (docs/22-transport-in-out.md) — updated on its own, not by re-rendering */
  private frameLabel = el('span', { class: 'dim frame-label' });
  /** the fastest map any fixture plays: the rate the viewport has to keep up with (set on render) */
  private mapFps = 0;

  /**
   * Project-level only: what to add, the framing and the post buttons live on the viewport (docs/20). `file` is the
   * working file's export / import (docs/33 §13) beside its name.
   */
  constructor(private root: HTMLElement, private store: Store, private clock: { seconds: () => number; set: (s: number) => void; fps: () => number } = { seconds: () => 0, set: () => {}, fps: () => 0 }, private file: { export: () => void; import: () => void } | null = null) {
    store.subscribe(() => this.render());
    this.render();
    const tick = () => { this.showFrame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  /**
   * The transport's clock, written straight into the DOM so a running animation does not re-render
   * the app: where it stands, and while it plays how fast the viewport is drawing. The maps play on
   * wall-clock time, so a low rate does not slow them down — it drops frames of them.
   */
  private showFrame(): void {
    const { project } = this.store.state;
    if (!project.animations.length) { this.setFrameText('', false); return; }
    const { end } = playbackRange(project);
    const fps = this.clock.fps();
    const playing = project.playback.playing;
    const rate = playing && fps ? ` · ${Math.round(fps)} fps` : '';
    // a map at 30 fps needs 30 drawn frames a second to show every row
    const slow = playing && !!fps && !!this.mapFps && fps < this.mapFps * 0.9;
    this.setFrameText(`${this.clock.seconds().toFixed(2)} / ${end.toFixed(2)} s${rate}`, slow);
  }

  private setFrameText(text: string, slow: boolean): void {
    if (this.frameLabel.textContent !== text) this.frameLabel.textContent = text;
    const cls = `dim frame-label${slow ? ' slow' : ''}`;
    if (this.frameLabel.className !== cls) this.frameLabel.className = cls;
    const title = slow
      ? `The viewport is drawing slower than the ${this.mapFps} fps of the fastest map playing, so rows of it are skipped — the animation still runs in real time`
      : 'Where the clock stands, and how fast the viewport is drawing while it plays';
    if (this.frameLabel.title !== title) this.frameLabel.title = title;
  }

  /**
   * The one clock every fixture reads (docs/22-transport-in-out.md): play / hold, back to *in*,
   * the range in seconds and whether it loops. Which map a fixture plays is its own property.
   */
  private transport(): HTMLElement | null {
    const { project } = this.store.state;
    if (!project.animations.length) return null;
    const pb = project.playback;
    const { start, end } = playbackRange(project);
    const patched = new Set(fixturesOf(project).map(({ layer }) => layer.pixels?.animation));
    const playing = project.animations.filter((a) => patched.has(a.id));
    this.mapFps = Math.round(Math.max(0, ...(playing.length ? playing : project.animations).map((a) => a.fps)));
    // out is empty when it follows the longest map patched: the computed value shows as the placeholder
    const out = el('input', {
      type: 'number', class: 'out', step: 0.5, min: 0, value: pb.end == null ? '' : String(pb.end), placeholder: end.toFixed(2),
      title: 'Out point in seconds — empty follows the longest map any fixture is patched to',
      onchange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); cmd.setPlayback(this.store, { end: Number.isFinite(v) ? v : null }); },
    });
    return el('span', { class: 'transport' },
      btn(pb.playing ? '‖' : '▶', () => cmd.setPlayback(this.store, { playing: !pb.playing }), { title: pb.playing ? 'Hold the pixel animations' : 'Play the pixel animations', active: pb.playing }),
      btn('⏮', () => this.clock.set(start), { title: 'Back to the in point' }),
      numField('in', pb.start, (v) => cmd.setPlayback(this.store, { start: v }), { step: 0.5, min: 0, title: 'In point of the clock, in seconds' }),
      el('label', { class: 'field', title: 'Out point in seconds — empty follows the longest map any fixture is patched to' }, el('span', {}, 'out'), out),
      el('label', { class: 'chk', title: 'Loop between in and out, or run to out and hold' }, el('input', { type: 'checkbox', checked: pb.loop, onchange: (e: Event) => cmd.setPlayback(this.store, { loop: (e.target as HTMLInputElement).checked }) }), 'loop'),
      this.frameLabel,
    );
  }

  setStatus(text: string): void { this.status.textContent = text; }

  render(): void {
    if (isScrubbing()) return;                                                                   // docs/25-number-fields.md §3
    if (this.root.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const { project, mode } = this.store.state;
    const editing = this.store.editingCurve();
    const undo = btn('Undo', () => this.store.undo(), { title: '⌘Z' });
    const redo = btn('Redo', () => this.store.redo(), { title: '⇧⌘Z' });
    undo.disabled = !this.store.canUndo;
    redo.disabled = !this.store.canRedo;
    this.root.replaceChildren(
      el('span', { class: 'brand' }, 'Deco Designer'),
      el('span', { class: 'sep' }),
      textField(project.name, (v) => this.store.update((s) => { s.project.name = v; }), { class: 'project-name', placeholder: 'Project name' }),
      // the working file as one archive item, and an item brought into it (docs/33 §13)
      ...(this.file ? [
        btn('⤓ Export', this.file.export, { title: 'Save the whole file as one object (an archive item, .deco.json) — Import or ▦ Insert brings it into the next work as a single object; loose planes and objects get an enclosing object named after the project' }),
        btn('⤒ Import', this.file.import, { title: 'Bring an exported file (or any archive item) into this work, under the selected object or at the origin' }),
      ] : []),
      el('span', { class: 'sep' }),
      el('span', { class: `mode-badge ${mode.kind}` }, mode.kind === 'edit' ? `EDIT · ${editing?.name ?? ''}` : mode.kind === 'post' ? 'POST' : 'OBJECT'),
      el('span', { class: 'sep' }),
      el('span', { class: 'grow' }),
      this.transport() ?? el('span', {}),
      el('span', { class: 'sep' }),
      undo,
      redo,
      el('span', { class: 'sep' }),
      this.status,
    );
  }
}
