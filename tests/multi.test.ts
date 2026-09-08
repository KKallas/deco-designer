/** Several of one class at once (docs/35-outliner-multi-edit.md): picking, shared values, the selection lists, the commands over ids. */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_FILLS, DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findGroup, findLoft, findPlane, type Id } from '../src/model/types';
import { pickIds, pickMode, shared } from '../src/ui/multi';
import { selectionText } from '../src/ui/viewbar';

const store = () => new Store(emptyProject('Multi', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } })), DEFAULT_FILLS));

/** A plane with one two-point curve on it, at `x` mm. */
function plate(s: Store, x: number): { plane: Id; curve: Id } {
  const plane = cmd.addPlane(s, 'front');
  cmd.setPlanePlacement(s, plane, { position: { x, y: 0, z: 0 } });
  const curve = cmd.addCurve(s, plane)!;
  cmd.addVertex(s, curve, { x: 0, y: 0 });
  cmd.addVertex(s, curve, { x: 100, y: 0 });
  cmd.exitEdit(s);
  return { plane, curve };
}

describe('pickIds (docs/35 §3)', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('a plain click replaces', () => {
    expect(pickIds(['a', 'b'], 'd', order, 'replace')).toEqual(['d']);
  });
  it('⌘ toggles one, the newcomer becoming the primary', () => {
    expect(pickIds(['a'], 'c', order, 'toggle')).toEqual(['a', 'c']);
    expect(pickIds(['a', 'c'], 'a', order, 'toggle')).toEqual(['c']);
  });
  it('Shift ranges from the primary, either way round, and joins what was selected', () => {
    expect(pickIds(['b'], 'd', order, 'range')).toEqual(['b', 'c', 'd']);
    // upwards too — and the clicked row becomes the primary (last), so the next Shift ranges from it
    expect(pickIds(['d'], 'b', order, 'range')).toEqual(['c', 'd', 'b']);
    // an earlier pick outside the span stays; the clicked one ends up last
    expect(pickIds(['e', 'a'], 'c', order, 'range')).toEqual(['e', 'a', 'b', 'c']);
    // the range runs from the primary (the last), not from every selected one
    expect(pickIds(['a', 'd'], 'e', order, 'range')).toEqual(['a', 'd', 'e']);
  });
  it('Shift without a primary in the order is a toggle', () => {
    expect(pickIds([], 'c', order, 'range')).toEqual(['c']);
    expect(pickIds(['zz'], 'c', order, 'range')).toEqual(['zz', 'c']);
  });
  it('reads the modifier keys: Shift = range, ⌘ / Ctrl = toggle', () => {
    expect(pickMode({ shiftKey: true, metaKey: false, ctrlKey: false })).toBe('range');
    expect(pickMode({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe('toggle');
    expect(pickMode({ shiftKey: false, metaKey: false, ctrlKey: true })).toBe('toggle');
    expect(pickMode({ shiftKey: false, metaKey: false, ctrlKey: false })).toBe('replace');
  });
});

describe('shared (docs/35 §4)', () => {
  it('is the primary’s value, mixed when any other differs (deep)', () => {
    expect(shared([{ v: 1 }, { v: 2 }], (x) => x.v)).toEqual({ value: 2, mixed: true });
    expect(shared([{ v: 3 }, { v: 3 }], (x) => x.v)).toEqual({ value: 3, mixed: false });
    expect(shared([{ p: { x: 1 } }, { p: { x: 1 } }], (x) => x.p)).toEqual({ value: { x: 1 }, mixed: false });
    expect(shared([{ m: null }, { m: 'gold' }], (x) => x.m)).toEqual({ value: 'gold', mixed: true });
    expect(shared([{ m: undefined }, { m: null }], (x) => x.m)).toEqual({ value: null, mixed: false });
  });
});

describe('selection lists (docs/35 §2)', () => {
  it('a plane list names the primary as the active plane; the single-id commands still fill the list', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500);
    cmd.selectPlanes(s, [a.plane, b.plane]);
    expect(s.selection.planes).toEqual([a.plane, b.plane]);
    expect(s.selection.planeId).toBe(b.plane);
    expect(s.selection.planeSelected).toBe(true);
    expect(selectionText(s)).toBe('2 planes');

    cmd.selectPlane(s, a.plane);
    expect(s.selection.planes).toEqual([a.plane]);
    expect(s.selection.planeId).toBe(a.plane);

    // none selected keeps the active plane
    cmd.selectPlanes(s, []);
    expect(s.selection.planes).toEqual([]);
    expect(s.selection.planeSelected).toBe(false);
    expect(s.selection.planeId).toBe(a.plane);
  });

  it('lofts, shapes and cameras keep their lists in step with the single id, and drop what is deleted', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500), c = plate(s, 1000);
    const l1 = cmd.addLoft(s, a.curve, b.curve)!, l2 = cmd.addLoft(s, b.curve, c.curve)!;
    cmd.selectLofts(s, [l1, l2]);
    expect(s.selection.loftId).toBe(l2);
    cmd.selectLoft(s, l1);
    expect(s.selection.lofts).toEqual([l1]);
    cmd.selectLofts(s, [l1, l2]);
    cmd.removeLoft(s, l2);
    expect(s.selection.lofts).toEqual([l1]);
    expect(s.selection.loftId).toBe(l1);

    const s1 = cmd.addShape(s, a.curve)!, s2 = cmd.addShape(s, b.curve)!;
    cmd.selectShapes(s, [s1, s2]);
    expect(s.selection.shapeId).toBe(s2);
    expect(s.selection.lofts).toEqual([]);
    expect(selectionText(s)).toBe('2 shapes');

    const c1 = cmd.addCamera(s, { name: 'One' }), c2 = cmd.addCamera(s, { name: 'Two' });
    cmd.selectCameras(s, [c1, c2]);
    expect(s.selection.cameraId).toBe(c2);
    expect(s.selection.shapes).toEqual([]);
    cmd.selectCamera(s, c1);
    expect(s.selection.cameras).toEqual([c1]);
  });

  it('deleting the selection takes every selected loft / shape, duplicating every selected plane', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500), c = plate(s, 1000);
    const l1 = cmd.addLoft(s, a.curve, b.curve)!, l2 = cmd.addLoft(s, b.curve, c.curve)!;
    cmd.selectLofts(s, [l1, l2]);
    cmd.deleteSelection(s);
    expect(s.project.lofts).toEqual([]);
    cmd.selectPlanes(s, [a.plane, b.plane]);
    cmd.duplicateSelection(s);
    expect(s.project.planes.length).toBe(5);
  });
});

describe('commands over several ids (docs/35 §5)', () => {
  it('placement patches merge per thing: x set on two planes keeps each plane’s own y', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500);
    cmd.setPlanePlacement(s, b.plane, { position: { y: 77 } });
    cmd.setPlanePlacement(s, [a.plane, b.plane], { position: { x: 9 } });
    expect(findPlane(s.project, a.plane)!.placement.position).toEqual({ x: 9, y: 0, z: 0 });
    expect(findPlane(s.project, b.plane)!.placement.position).toEqual({ x: 9, y: 77, z: 0 });
    cmd.renamePlane(s, [a.plane, b.plane], 'Both');
    expect(s.project.planes.map((p) => p.name)).toEqual(['Both', 'Both']);
  });

  it('objects: placement, name and parent over a list, one undo step for the parent change', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500), c = plate(s, 1000);
    const g1 = cmd.addGroup(s, [a.plane])!, g2 = cmd.addGroup(s, [b.plane])!, rig = cmd.addGroup(s, [c.plane])!;
    cmd.setGroupPlacement(s, [g1, g2], { rotation: { z: 30 } });
    expect(findGroup(s.project, g1)!.placement.rotation.z).toBe(30);
    expect(findGroup(s.project, g2)!.placement.rotation.z).toBe(30);
    cmd.renameGroup(s, [g1, g2], 'Leg');
    const before = s.canUndo;
    cmd.setGroupParent(s, [g1, g2], rig);
    expect(findGroup(s.project, rig)!.groups).toEqual([g1, g2]);
    expect(before).toBe(true);
    s.undo();
    expect(findGroup(s.project, rig)!.groups).toEqual([]);   // both moves undone together
    expect(findGroup(s.project, g1)!.name).toBe('Leg');       // the rename is the step before
  });

  it('curves: type and plane over a list; lofts: fields and edges over a list', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500), c = plate(s, 1000);
    cmd.setCurveType(s, [a.curve, b.curve], 'spatial');
    expect(s.project.curves.filter((x) => x.type === 'spatial').map((x) => x.id)).toEqual([a.curve, b.curve]);
    cmd.setCurvePlane(s, [a.curve, b.curve], c.plane);
    expect(s.project.curves.filter((x) => x.planeId === c.plane).length).toBe(3);
    cmd.renameCurve(s, [a.curve, b.curve], 'Same');
    expect(s.project.curves.filter((x) => x.name === 'Same').length).toBe(2);

    const l1 = cmd.addLoft(s, a.curve, b.curve)!, l2 = cmd.addLoft(s, b.curve, c.curve)!;
    cmd.updateLoft(s, [l1, l2], { strips: 7 });
    cmd.setLoftEdge(s, [l1, l2], 'a', { start: 25 });
    for (const id of [l1, l2]) {
      expect(findLoft(s.project, id)!.strips).toBe(7);
      expect(findLoft(s.project, id)!.edgeA?.start).toBe(25);
    }
  });

  it('shapes: values over a list, fill layers by index (a shape without the layer is skipped)', () => {
    const s = store();
    const a = plate(s, 0), b = plate(s, 500);
    const s1 = cmd.addShape(s, a.curve)!, s2 = cmd.addShape(s, b.curve)!;
    cmd.updateShape(s, [s1, s2], { expand: -12 });
    expect(s.project.shapes.map((x) => x.expand)).toEqual([-12, -12]);
    cmd.addShapeLayer(s, s1);   // s1 has two layers, s2 one
    cmd.updateShapeLayers(s, [s1, s2], 1, { offset: 40 });
    expect(s.project.shapes.find((x) => x.id === s1)!.layers[1].offset).toBe(40);
    expect(s.project.shapes.find((x) => x.id === s2)!.layers.length).toBe(1);
    cmd.updateShapeLayers(s, [s1, s2], 0, { offset: 5 });
    expect(s.project.shapes.map((x) => x.layers[0].offset)).toEqual([5, 5]);
    cmd.removeShapeLayers(s, [s1, s2], 0);
    expect(s.project.shapes.map((x) => x.layers.length)).toEqual([1, 0]);
  });

  it('cameras: one patch over a list', () => {
    const s = store();
    const c1 = cmd.addCamera(s, { name: 'One' }), c2 = cmd.addCamera(s, { name: 'Two', focalLength: 85 });
    cmd.updateCamera(s, [c1, c2], { dof: { fStop: 4 } });
    expect(s.project.cameras.map((c) => c.dof.fStop)).toEqual([2.8, 4, 4]);   // Camera 1 (every project's, docs/36) untouched
    expect(s.project.cameras.map((c) => c.focalLength)).toEqual([50, 50, 85]);   // untouched
  });
});
