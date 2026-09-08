/** The viewport status bar's wording (docs/20-viewport-status-bar.md §2). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, type Id } from '../src/model/types';
import { selectionText } from '../src/ui/viewbar';

const store = () => new Store(emptyProject('Bar', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));

/** A plane named `name` with one two-point curve on it. */
function plate(s: Store, name: string): { plane: Id; curve: Id } {
  const plane = cmd.addPlane(s, 'front');
  s.update((x) => { const p = x.project.planes.find((q) => q.id === plane)!; p.name = name; });
  const curve = cmd.addCurve(s, plane)!;
  cmd.addVertex(s, curve, { x: 0, y: 0 });
  cmd.addVertex(s, curve, { x: 100, y: 0 });
  cmd.exitEdit(s);
  return { plane, curve };
}

describe('viewport status bar', () => {
  it('names the lowest selected level, and the plane the curves sit on', () => {
    const s = store();
    const a = plate(s, 'Left'), b = plate(s, 'Right');
    cmd.selectCurve(s, null);
    expect(selectionText(s)).toBe('Nothing selected');

    cmd.selectCurve(s, a.curve);
    const name = s.project.curves.find((c) => c.id === a.curve)!.name;
    expect(selectionText(s)).toBe(`${name} · Left`);

    // two curves on two planes: no plane to name
    cmd.selectCurve(s, b.curve, true);
    expect(selectionText(s)).toBe('2 curves');

    cmd.selectPlane(s, a.plane);
    expect(selectionText(s)).toBe('Plane · Left');

    const g = cmd.addGroup(s, { planes: [a.plane, b.plane], name: 'Rig' })!;
    cmd.selectGroup(s, g, false);
    expect(selectionText(s)).toBe('Rig');
  });

  it('counts the points of the edited curve, and the selected ones', () => {
    const s = store();
    const { curve } = plate(s, 'Left');
    cmd.enterEdit(s, curve);
    const name = s.project.curves.find((c) => c.id === curve)!.name;
    expect(selectionText(s)).toBe(`Edit · ${name} · 2 points`);
    cmd.selectVertices(s, [s.project.curves.find((c) => c.id === curve)!.curve.points[0].id]);
    expect(selectionText(s)).toBe(`Edit · ${name} · 1 / 2 points`);
  });
});
