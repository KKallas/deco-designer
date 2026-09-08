/** Selection filter (docs/08-selection-filter.md): the lowest enabled level wins. */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject } from '../src/model/types';
import { ALL_LEVELS, resolvePick, type PickFilter } from '../src/model/pick';

function fixture() {
  const store = new Store(emptyProject('t', DEFAULT_PROFILES));
  const line = (planeId: string, y: number) => {
    const id = cmd.addCurve(store, planeId);
    cmd.addVertex(store, id, { x: 0, y });
    cmd.addVertex(store, id, { x: 500, y });
    cmd.exitEdit(store);
    return id;
  };
  const front = cmd.addPlane(store, 'front');
  const top = cmd.addPlane(store, 'top');
  const loose = cmd.addPlane(store, 'side');
  const a = line(front, 0), b = line(top, 0), c = line(loose, 0);
  const inLoft = cmd.addLoft(store, a, b)!;
  const outLoft = cmd.addLoft(store, a, c)!;
  const group = cmd.addGroup(store, [front, top])!;
  return { project: store.project, front, loose, a, c, inLoft, outLoft, group };
}

const only = (...on: (keyof PickFilter)[]): PickFilter => ({ curve: false, loft: false, plane: false, object: false, ...Object.fromEntries(on.map((k) => [k, true])) });

describe('resolvePick', () => {
  const f = fixture();
  const hitA = { curveId: f.a, loftId: null };

  it('everything on: a curve hit selects the curve, a loft hit the loft', () => {
    expect(resolvePick(f.project, ALL_LEVELS, hitA)).toEqual({ kind: 'curve', id: f.a });
    expect(resolvePick(f.project, ALL_LEVELS, { curveId: null, loftId: f.inLoft })).toEqual({ kind: 'loft', id: f.inLoft });
  });

  it('curve off: the curve hit climbs to its plane, then to its object', () => {
    expect(resolvePick(f.project, only('plane', 'object'), hitA)).toEqual({ kind: 'plane', id: f.front, curveId: f.a });
    expect(resolvePick(f.project, only('object'), hitA)).toEqual({ kind: 'object', id: f.group, curveId: f.a });
  });

  it('a curve outside any object resolves to nothing at Object level', () => {
    expect(resolvePick(f.project, only('object'), { curveId: f.c, loftId: null })).toBeNull();
    expect(resolvePick(f.project, only('plane'), { curveId: f.c, loftId: null })).toEqual({ kind: 'plane', id: f.loose, curveId: f.c });
  });

  it('loft off: a loft hit selects the object that holds both its curves, else nothing', () => {
    expect(resolvePick(f.project, only('object'), { curveId: null, loftId: f.inLoft })).toEqual({ kind: 'object', id: f.group, curveId: null });
    expect(resolvePick(f.project, only('object'), { curveId: null, loftId: f.outLoft })).toBeNull();
    expect(resolvePick(f.project, only('curve', 'plane'), { curveId: null, loftId: f.inLoft })).toBeNull();
  });

  it('nothing enabled or nothing hit → null', () => {
    expect(resolvePick(f.project, only(), hitA)).toBeNull();
    expect(resolvePick(f.project, ALL_LEVELS, { curveId: null, loftId: null })).toBeNull();
  });
});
