/**
 * Part 11 (docs/11-navigation-edit-gizmo.md): the Edit-mode gizmo transforms
 * only the selected vertices (with their handles) and Object-mode box select
 * replaces / extends the curve selection.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findCurve } from '../src/model/types';
import { snapshotCurve } from '../src/model/transform';

function square(store: Store) {
  const id = cmd.addCurve(store, null, 'front');
  for (const p of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]) cmd.addVertex(store, id, p);
  cmd.toggleClosed(store, id);
  return id;
}

describe('edit-mode gizmo: transformVertices', () => {
  it('rotates the selected vertices about the pivot and leaves the others alone', () => {
    const store = new Store(emptyProject('t', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));
    const id = square(store);
    const c = findCurve(store.project, id)!;
    const [a, b, cc, d] = c.curve.points.map((v) => v.id);
    const snap = snapshotCurve(c);
    // rotate the top edge (c, d) by 90° about (50, 100): (100,100) → (50,150), (0,100) → (50,50)
    cmd.transformVertices(store, id, snap, [cc, d], { pivot: { x: 50, y: 100 }, angle: Math.PI / 2, sx: 1, sy: 1, tx: 0, ty: 0 }, true);
    cmd.commit(store);
    const after = findCurve(store.project, id)!;
    const at = (vid: string) => { const v = after.curve.points.find((x) => x.id === vid)!; return { x: Math.round(v.x), y: Math.round(v.y) }; };
    expect(at(cc)).toEqual({ x: 50, y: 150 });
    expect(at(d)).toEqual({ x: 50, y: 50 });
    expect(at(a)).toEqual({ x: 0, y: 0 });
    expect(at(b)).toEqual({ x: 100, y: 0 });
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(findCurve(store.project, id)!.curve.points.map((v) => [v.x, v.y])).toEqual(snap.points.map((v) => [v.x, v.y]));
  });

  it('is re-applied from the snapshot (no drift) and skips pinned vertices', () => {
    const store = new Store(emptyProject('t', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));
    const id = square(store);
    const c = findCurve(store.project, id)!;
    const [a, b] = c.curve.points.map((v) => v.id);
    cmd.togglePin(store, id, a);
    const snap = snapshotCurve(findCurve(store.project, id)!);
    cmd.transformVertices(store, id, snap, [a, b], { pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1, tx: 30, ty: 0 }, true);
    cmd.transformVertices(store, id, snap, [a, b], { pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1, tx: 50, ty: 0 }, true);
    const after = findCurve(store.project, id)!;
    expect(after.curve.points.find((v) => v.id === a)!.x).toBe(0);   // pinned
    expect(after.curve.points.find((v) => v.id === b)!.x).toBe(150); // 100 + 50, not 100 + 30 + 50
  });
});

describe('object-mode box select: selectCurves', () => {
  it('replaces the selection, and extends it additively', () => {
    const store = new Store(emptyProject('t', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));
    const a = square(store), b = square(store), c = square(store);
    cmd.exitEdit(store);
    cmd.selectCurves(store, [a]);
    expect(store.selection.curves).toEqual([a]);
    cmd.selectCurves(store, [b, c], true);
    expect(store.selection.curves).toEqual([a, b, c]);
    cmd.selectCurves(store, [c, 'nope']);
    expect(store.selection.curves).toEqual([c]);
    expect(store.selection.planeId).toBe(findCurve(store.project, c)!.planeId);
  });
});
