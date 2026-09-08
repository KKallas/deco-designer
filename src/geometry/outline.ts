/**
 * An outline layer's own curve (docs/30-outline-and-shape-layers.md §3): the drawn curve
 * moved `offset` mm sideways in the plane (the offset tool's maths and sign, docs/29 §2) and
 * lifted `lift` mm along the plane normal. On a spatial curve the offset is taken in the
 * plane and every vertex keeps its z (a vertex the offset inserts interpolates it).
 */
import type { Curve, OutlineLayer } from '../model/types';
import { offsetCurve } from './modify';
import { sampleCurve, type CurveSampling } from './curve';

/** The curve a layer is built on — the drawn one itself when the layer sits on the line. */
export function layerCurve(curve: Curve, layer: Pick<OutlineLayer, 'offset' | 'lift'>, sampling?: CurveSampling): Curve {
  let out = curve;
  if (layer.offset && curve.points.length >= 2) out = offsetCurve(curve, layer.offset, sampling ?? sampleCurve(curve)) ?? curve;
  if (layer.lift) out = { closed: out.closed, points: out.points.map((v) => ({ ...v, z: v.z + layer.lift })) };
  return out;
}
