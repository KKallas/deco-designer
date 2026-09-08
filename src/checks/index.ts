/**
 * Limitation checks. Pure: (curve, profile, sampling) → violations.
 * Each check corresponds to one entry in Profile.limits.
 */
import type { Curve, Profile, ProfileLimits } from '../model/types';
import type { CurveSampling, Sample } from '../geometry/curve';

export type CheckId = keyof ProfileLimits;

export interface CheckSpec { id: CheckId; label: string; unit: string; color: string; hint: string }

export const CHECKS: CheckSpec[] = [
  { id: 'minBendRadius', label: 'Min bend radius', unit: 'mm', color: '#ff5c5c', hint: 'Every bend must be at least this radius (curve centre line).' },
  { id: 'maxLength', label: 'Stock length', unit: 'mm', color: '#f5a623', hint: 'A curve longer than one stock piece needs a joint.' },
];

/** Fraction under the minimum bend radius that still passes (docs/29-offset-trim-fillet.md §7). */
export const BEND_SLACK = 0.005;

export interface Violation {
  check: CheckId;
  message: string;
  /** the outline layer it belongs to (docs/30 §3); set by the store */
  layer?: string;
  /** Arc-length span [s0, s1] along the curve, mm. Absent = whole curve. */
  span?: [number, number];
}

function runs<T>(items: T[], pred: (item: T) => boolean): T[][] {
  const out: T[][] = [];
  let cur: T[] | null = null;
  for (const it of items) {
    if (pred(it)) (cur ??= []).push(it);
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

export function runChecks(curve: Curve, profile: Profile, sampling: CurveSampling): Violation[] {
  const out: Violation[] = [];
  const { samples, length } = sampling;
  if (samples.length < 2) return out;
  const { minBendRadius, maxLength } = profile.limits;

  if (minBendRadius > 0) {
    // half a percent of slack: a cubic arc's radius wavers that much along it (a fillet at the
    // limit is legal, docs/29 §4), and the sampled estimate has noise of its own
    const limit = minBendRadius * (1 - BEND_SLACK);
    for (const run of runs(samples, (s: Sample) => s.radius < limit)) {
      const tightest = Math.min(...run.map((s) => s.radius));
      out.push({ check: 'minBendRadius', span: [run[0].s, run[run.length - 1].s], message: `R ${tightest.toFixed(0)} mm < ${minBendRadius} mm` });
    }
  }
  if (maxLength > 0 && length > maxLength) {
    out.push({ check: 'maxLength', message: `${length.toFixed(0)} mm > ${maxLength} mm` });
  }
  void curve;
  return out;
}

export interface LimitStatus extends CheckSpec { limit: number; ok: boolean; detail: string }

/** What the constraints window shows: each limitation with its value and current status. */
export function limitStatuses(profile: Profile, sampling: CurveSampling, violations: Violation[]): LimitStatus[] {
  return CHECKS.map((spec) => {
    const mine = violations.filter((v) => v.check === spec.id);
    let detail: string;
    if (mine.length) detail = mine[0].message + (mine.length > 1 ? ` (+${mine.length - 1})` : '');
    else if (spec.id === 'minBendRadius') {
      const tightest = Math.min(...sampling.samples.map((s) => s.radius));
      detail = Number.isFinite(tightest) ? `tightest R ${tightest.toFixed(0)} mm` : 'straight';
    } else detail = `${sampling.length.toFixed(0)} mm`;
    return { ...spec, limit: profile.limits[spec.id], ok: mine.length === 0, detail };
  });
}
