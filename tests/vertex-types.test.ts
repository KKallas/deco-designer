/** Vertex types Polygon / Equal / Free, Polygon the default (docs/27-vertex-types.md). */
import { describe, expect, it } from 'vitest';
import { Store } from '../src/app/store';
import * as cmd from '../src/app/commands';
import { DEFAULT_PROFILES } from '../src/model/defaults';
import { emptyProject, findCurve, migrateProject, type Id } from '../src/model/types';
import { handlesOf } from '../src/model/handles';

const store = () => new Store(emptyProject('Types', DEFAULT_PROFILES.map((p) => ({ ...p, limits: { ...p.limits } }))));

/** A curve through `pts` on a front plane. */
function drawn(s: Store, pts: [number, number][]): Id {
  const plane = cmd.addPlane(s, 'front');
  const id = cmd.addCurve(s, plane);
  for (const [x, y] of pts) cmd.addVertex(s, id, { x, y });
  cmd.exitEdit(s);
  return id;
}

const pts = (s: Store, id: Id) => findCurve(s.project, id)!.curve.points;

describe('vertex types', () => {
  it('draws polygon vertices: no handles, straight segments', () => {
    const s = store();
    const id = drawn(s, [[0, 0], [200, 300], [400, 0]]);
    const c = findCurve(s.project, id)!;
    expect(c.curve.points.map((v) => v.type)).toEqual(['polygon', 'polygon', 'polygon']);
    const h = handlesOf(c.curve.points, false, 1);
    expect(h.in).toEqual({ x: 0, y: 0, z: 0 });
    expect(h.out).toEqual({ x: 0, y: 0, z: 0 });
    // two legs of 200 × 300 mm, drawn straight
    expect(s.evals.get(id)!.sampling.length).toBeCloseTo(2 * Math.hypot(200, 300), 3);
  });

  it('V cycles polygon → equal → free, and equal → polygon → equal keeps the handles', () => {
    const s = store();
    const id = drawn(s, [[0, 0], [200, 300], [400, 0]]);
    const v = () => pts(s, id)[1];
    const mid = [v().id];
    cmd.cycleVertexType(s, id, mid);
    expect(v().type).toBe('equal');
    const rounded = { in: { ...v().in }, out: { ...v().out } };
    expect(Math.hypot(rounded.out.x, rounded.out.y)).toBeGreaterThan(0);   // handles come from the neighbours
    cmd.cycleVertexType(s, id, mid);
    expect(v().type).toBe('free');
    cmd.cycleVertexType(s, id, mid);
    expect(v().type).toBe('polygon');
    expect(s.evals.get(id)!.sampling.length).toBeCloseTo(2 * Math.hypot(200, 300), 3);   // straight again
    cmd.setVertexType(s, id, mid, 'equal');
    expect({ in: v().in, out: v().out }).toEqual(rounded);                  // the same handles come back
  });

  it('an equal vertex keeps its handles collinear, a free one does not; a polygon one has none to drag', () => {
    const s = store();
    const id = drawn(s, [[0, 0], [200, 300], [400, 0]]);
    const mid = pts(s, id)[1].id;
    cmd.moveHandle(s, id, mid, 'out', { x: 300, y: 300 }, false);
    expect(pts(s, id)[1].out).toEqual({ x: 0, y: 0, z: 0 });                // polygon: the drag does nothing

    cmd.setVertexType(s, id, [mid], 'equal');
    cmd.moveHandle(s, id, mid, 'out', { x: 300, y: 300 }, false);
    const eq = pts(s, id)[1];
    expect(eq.out).toEqual({ x: 100, y: 0, z: 0 });
    expect(eq.in.y).toBeCloseTo(0, 9);
    expect(eq.in.x).toBeLessThan(0);                                        // mirrored through the vertex

    cmd.setVertexType(s, id, [mid], 'free');
    cmd.moveHandle(s, id, mid, 'in', { x: 200, y: 400 }, false);
    const fr = pts(s, id)[1];
    expect(fr.in).toEqual({ x: 0, y: 100, z: 0 });
    expect(fr.out).toEqual({ x: 100, y: 0, z: 0 });                         // the other side stays put
  });

  it('migrates the Part 2 types (13 → 14) without changing any shape', () => {
    const v13 = {
      version: 13, name: 'old', profiles: DEFAULT_PROFILES, lofts: [], groups: [], materials: [], textures: [], animations: [], cameras: [],
      planes: [{ id: 'front', name: 'Front', placement: { preset: 'front', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, array: null, image: null }],
      curves: [{
        id: 'c', name: 'c', planeId: 'front', profileId: 'round15', type: 'planar', constraints: [], materialId: null, params: {}, pixels: null,
        curve: {
          closed: false, points: [
            { id: 'a', x: 0, y: 0, z: 0, type: 'auto', in: { x: 0, y: 0, z: 0 }, out: { x: 0, y: 0, z: 0 } },
            { id: 'b', x: 300, y: 0, z: 0, type: 'smooth', in: { x: -30, y: 0, z: 0 }, out: { x: 30, y: 0, z: 0 } },
            { id: 'c', x: 600, y: 300, z: 0, type: 'corner', in: { x: -40, y: 0, z: 0 }, out: { x: 0, y: 0, z: 0 } },
            { id: 'd', x: 900, y: 300, z: 0, type: 'corner', in: { x: 0, y: 0, z: 0 }, out: { x: 0, y: 0, z: 0 } },
          ],
        },
      }],
    };
    const p = migrateProject(JSON.parse(JSON.stringify(v13)))!;
    expect(p.version).toBe(18);
    const points = p.curves[0].curve.points;
    expect(points.map((v) => v.type)).toEqual(['equal', 'equal', 'free', 'polygon']);
    expect(points[0].out).toEqual({ x: 100, y: 0, z: 0 });                  // the auto handles it was drawn with, baked
    expect(points[1].in).toEqual({ x: -30, y: 0, z: 0 });                   // smooth keeps its own
    expect(points[2].in).toEqual({ x: -40, y: 0, z: 0 });
  });
});
