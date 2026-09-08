/** Dragging a number field (docs/25-number-fields.md §3) — the maths. */
import { describe, expect, it } from 'vitest';
import { PX_PER_STEP, scrubValue } from '../src/ui/scrub';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject } from '../src/model/types';

describe('scrubValue', () => {
  it('moves one step of the field per 8 px, right up and left down', () => {
    expect(PX_PER_STEP).toBe(8);
    expect(scrubValue(0, 8, { step: 10 })).toBe(10);
    expect(scrubValue(0, 80, { step: 10 })).toBe(100);
    expect(scrubValue(0, -24, { step: 10 })).toBe(-30);
    expect(scrubValue(0, 3, { step: 10 })).toBe(0);        // under half a step: still the start value
  });

  it('adds whole steps to where the drag started, it does not snap to the grid', () => {
    expect(scrubValue(3, 8, { step: 10 })).toBe(13);
    expect(scrubValue(3, 16, { step: 10 })).toBe(23);
    expect(scrubValue(-7.5, 8, { step: 10 })).toBe(2.5);
  });

  it('Shift is fine: tenths of a step, without float dust', () => {
    expect(scrubValue(0, 8, { step: 10, fine: true })).toBe(1);
    expect(scrubValue(0.1, 16, { step: 1, fine: true })).toBe(0.3);
    expect(scrubValue(0, 24, { step: 0.1, fine: true })).toBe(0.03);
  });

  it('clamps to min and max like typing does', () => {
    expect(scrubValue(50, -800, { step: 10, min: 0 })).toBe(0);
    expect(scrubValue(0, 800, { step: 10, max: 90 })).toBe(90);
    expect(scrubValue(1, 0, { step: 1, min: 1 })).toBe(1);
  });

  it('treats a missing or odd step as 1', () => {
    expect(scrubValue(5, 8)).toBe(6);
    expect(scrubValue(5, 8, { step: 0 })).toBe(6);
    expect(scrubValue(5, -8, { step: -10 })).toBe(-5);      // a negative step still drags left = down
  });
});

describe('a drag is one undo step (store.beginLive / endLive)', () => {
  /** One loft between two lines, as the panel would have it selected. */
  function fixture() {
    const store = new Store(emptyProject('t', DEFAULT_PROFILES));
    const plane = cmd.addPlane(store, 'front');
    const line = (y: number) => { const id = cmd.addCurve(store, plane); cmd.addVertex(store, id, { x: 0, y }); cmd.addVertex(store, id, { x: 1000, y }); cmd.exitEdit(store); return id; };
    const loft = cmd.addLoft(store, line(0), line(500))!;
    return { store, loft };
  }

  it('records once for the whole drag, and one undo takes it back', () => {
    const { store, loft } = fixture();
    store.beginLive();
    for (const v of [10, 20, 30, 40, 50]) cmd.setLoftEdge(store, loft, 'a', { start: v });   // every pointermove
    expect(store.project.lofts[0].edgeA!.start).toBe(50);                                    // live in the viewport all along
    store.endLive();
    store.undo();
    expect(store.project.lofts[0].edgeA!.start).toBe(0);
  });

  it('without the live edit every step is undoable on its own (the drag would need 5 undos)', () => {
    const { store, loft } = fixture();
    for (const v of [10, 20, 30, 40, 50]) cmd.setLoftEdge(store, loft, 'a', { start: v });
    store.undo();
    expect(store.project.lofts[0].edgeA!.start).toBe(40);
  });

  it('cancelLive closes an edit a page left open, so history keeps recording', () => {
    const { store, loft } = fixture();
    store.beginLive();
    cmd.setLoftEdge(store, loft, 'a', { start: 70 });
    store.cancelLive();                                   // the page went away mid-drag
    cmd.setLoftEdge(store, loft, 'a', { start: 80 });
    store.undo();
    expect(store.project.lofts[0].edgeA!.start).toBe(70);
  });
});
