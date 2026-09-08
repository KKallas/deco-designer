/** The toolbar rails' one width, which is also the display mode (docs/23-toolbar-rails.md §3). */
import { describe, expect, it } from 'vitest';
import { clampRailWidth, RAIL_ICON_W, RAIL_TEXT_MAX, RAIL_TEXT_MIN } from '../src/ui/rails';

describe('rail width', () => {
  it('snaps back to the icon rail under the threshold and clamps above the maximum', () => {
    expect(clampRailWidth(0)).toBe(RAIL_ICON_W);
    expect(clampRailWidth(RAIL_TEXT_MIN - 1)).toBe(RAIL_ICON_W);
    expect(clampRailWidth(RAIL_TEXT_MIN)).toBe(RAIL_TEXT_MIN);
    expect(clampRailWidth(160)).toBe(160);
    expect(clampRailWidth(RAIL_TEXT_MAX + 200)).toBe(RAIL_TEXT_MAX);
  });
});
