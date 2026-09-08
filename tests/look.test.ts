/**
 * The look, measured on real frames (docs/15-camera.md): needs `npm run dev` and the designer open
 * in a browser — skipped otherwise. Runs scripts/look-probe.js in the tab through the bridge: a
 * straight LED string, the frame the viewport presents with the Eevee post script on and off, and
 * on the pixels the halo around the lamp tips and the glare streaks along their four directions.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const BASE = process.env.DECO_URL ?? 'http://localhost:5173';
const probe = readFileSync(new URL('../scripts/look-probe.js', import.meta.url), 'utf8');

async function designerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/__deco/status`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { ok: boolean; value?: { designer?: boolean } };
    return !!j.ok && !!j.value?.designer;
  } catch { return false; }
}

describe('look (live designer tab)', () => {
  it('lamps glow with a halo and throw streaks along the four glare directions', async (ctx) => {
    if (!(await designerUp())) { ctx.skip(); return; }
    const r = await fetch(`${BASE}/__deco/exec`, { method: 'POST', body: probe, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(60000) });
    const out = (await r.json()) as { ok: boolean; value: { tips: number; halo: number; streakTop: number; streakRest: number; fxError: string | null } };
    expect(out.ok, JSON.stringify(out.value)).toBe(true);
    const m = out.value;
    expect(m.fxError).toBeNull();
    expect(m.tips, 'lamp tips projected into the frame').toBeGreaterThan(15);
    expect(m.halo, 'the ring around the tips is brighter with bloom').toBeGreaterThan(0.03);
    expect(m.streakTop, 'the streak knob adds light along a few directions').toBeGreaterThan(0.01);
    expect(m.streakTop, 'streaks are rays, not fog: the brightest angular bins clearly exceed the rest (isotropic glow would be ~1×)').toBeGreaterThan(m.streakRest * 1.3 + 0.01);
  }, 90000);
});
