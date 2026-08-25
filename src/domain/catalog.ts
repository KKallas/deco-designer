/**
 * Decolight product catalog. All dimensions are in millimetres.
 * These are the physical constraints the designer works within.
 */

export type PipeProfile = 'round' | 'square';

export interface PipeSpec {
  id: string;
  label: string;
  profile: PipeProfile;
  /** Outer diameter (round) or side length (square). */
  size: number;
  material: 'aluminium';
}

export const PIPES: Record<string, PipeSpec> = {
  round25: { id: 'round25', label: 'Round Ø25 mm', profile: 'round', size: 25, material: 'aluminium' },
  square15: { id: 'square15', label: 'Square 15×15 mm', profile: 'square', size: 15, material: 'aluminium' },
};

export const DEFAULT_PIPE = PIPES.round25;

/** Materials that can fill a lofted area between pipe curves. */
export type FillMaterial = 'pvc' | 'golden-garland';

export const FILL_MATERIALS: Record<FillMaterial, { label: string; color: number }> = {
  pvc: { label: 'PVC', color: 0xf2f2f2 },
  'golden-garland': { label: 'Golden garland', color: 0xd4a017 },
};

/** LED string: three twisted 4 mm wires with an LED every 50 mm. */
export interface LedStringSpec {
  id: string;
  label: string;
  /** Total cable length. */
  cableLength: number;
  /** Number of LEDs on the cable. */
  ledCount: number;
  /** Distance between consecutive LEDs. */
  pitch: number;
  wireDiameter: number;
  wireCount: number;
  led: {
    height: number;
    /** Thickness / diameter of the LED body. */
    thickness: number;
    /** Fraction of the LED body (from the base) that is opaque plastic. */
    opaqueFraction: number;
  };
}

const LED = { height: 40, thickness: 8, opaqueFraction: 2 / 3 };

export const LED_STRINGS: Record<string, LedStringSpec> = {
  led5m: { id: 'led5m', label: '5 m / 80 LEDs', cableLength: 5000, ledCount: 80, pitch: 50, wireDiameter: 4, wireCount: 3, led: LED },
  led10m: { id: 'led10m', label: '10 m / 80 LEDs', cableLength: 10000, ledCount: 80, pitch: 50, wireDiameter: 4, wireCount: 3, led: LED },
};

/** Lit length actually covered by LEDs on a string (ledCount × pitch). */
export function litLength(spec: LedStringSpec): number {
  return spec.ledCount * spec.pitch;
}

export const LED_COLORS: Record<string, number> = {
  warmWhite: 0xffd9a0,
  coldWhite: 0xf0f6ff,
  red: 0xff2020,
  green: 0x20ff40,
  blue: 0x2060ff,
  gold: 0xffc040,
};
