/**
 * Emissive geometry lighting the scene (docs/17-emitters.md), the maths.
 *
 * Every lamp of every LED string is an **emitter** with a pixel slot; the
 * scene is covered by a grid of spherical-harmonic **probes**. Because the
 * geometry is static and only the colours move, the expensive part — which
 * emitter reaches which probe, how strongly, and whether something is in
 * the way — is **baked once** into a transfer matrix (the `K` strongest
 * emitters per probe). Each frame the live pixel colours are multiplied
 * through it, which costs the same no matter how fast the pattern changes.
 *
 * Band 0 + 1 (4 coefficients) with three's basis, so the shader can use
 * three's `getShIrradianceAt` convention. Pure maths — no three.js, no DOM,
 * lengths in mm.
 */

/** A lamp: where it is (mm), how big its lit surface is (mm²) and which pixel drives it. */
export interface Emitter { x: number; y: number; z: number; area: number; slot: number }

export interface Vec3Like { x: number; y: number; z: number }

/** The probe lattice: `nx × ny × nz` probes `spacing` mm apart, the first at `min`. */
export interface ProbeGrid { min: Vec3Like; spacing: number; nx: number; ny: number; nz: number }

/** Coefficients per probe (band 0 + band 1). */
export const SH_COEFFS = 4;
/** three's real SH basis (SphericalHarmonics3.getBasisAt), bands 0 and 1. */
export const SH_Y0 = 0.282095;
export const SH_Y1 = 0.488603;

/**
 * A lattice covering `min..max` (padded) with at most `cap` probes — the spacing grows if the
 * box needs more. A degenerate box still gets a 2×2×2 lattice so interpolation has something to read.
 */
export function probeGrid(min: Vec3Like, max: Vec3Like, spacing: number, cap = 32768): ProbeGrid {
  const pad = Math.max(spacing, 200);
  const lo = { x: min.x - pad, y: min.y - pad, z: min.z - pad };
  const size = { x: max.x - min.x + 2 * pad, y: max.y - min.y + 2 * pad, z: max.z - min.z + 2 * pad };
  let s = Math.max(10, spacing);
  const dims = (step: number) => [
    Math.max(2, Math.ceil(size.x / step) + 1),
    Math.max(2, Math.ceil(size.y / step) + 1),
    Math.max(2, Math.ceil(size.z / step) + 1),
  ];
  let [nx, ny, nz] = dims(s);
  while (nx * ny * nz > cap) { s *= 1.25; [nx, ny, nz] = dims(s); }
  return { min: lo, spacing: s, nx, ny, nz };
}

export const probeCount = (g: ProbeGrid): number => g.nx * g.ny * g.nz;

export function probePosition(g: ProbeGrid, index: number, out: Vec3Like = { x: 0, y: 0, z: 0 }): Vec3Like {
  const ix = index % g.nx, iy = Math.floor(index / g.nx) % g.ny, iz = Math.floor(index / (g.nx * g.ny));
  out.x = g.min.x + ix * g.spacing;
  out.y = g.min.y + iy * g.spacing;
  out.z = g.min.z + iz * g.spacing;
  return out;
}

// -- visibility ------------------------------------------------------------------------

/** A coarse voxel grid of what is solid: the shadow caster for the bake. */
export interface Occupancy { min: Vec3Like; cell: number; nx: number; ny: number; nz: number; bits: Uint8Array }

export function emptyOccupancy(): Occupancy {
  return { min: { x: 0, y: 0, z: 0 }, cell: 1, nx: 0, ny: 0, nz: 0, bits: new Uint8Array(0) };
}

/**
 * Mark the cells a mesh covers. `triangles` is 9 floats per triangle (three world-space corners,
 * mm); each is sampled densely enough that no cell of a face is missed.
 */
export function voxelize(triangles: ArrayLike<number>, min: Vec3Like, max: Vec3Like, cell: number, cap = 4_000_000): Occupancy {
  const c = Math.max(10, cell);
  const lo = { x: min.x - c, y: min.y - c, z: min.z - c };
  let nx = Math.max(1, Math.ceil((max.x - min.x) / c) + 2);
  let ny = Math.max(1, Math.ceil((max.y - min.y) / c) + 2);
  let nz = Math.max(1, Math.ceil((max.z - min.z) / c) + 2);
  let step = c;
  while (nx * ny * nz > cap) {
    step *= 1.5;
    nx = Math.max(1, Math.ceil((max.x - min.x) / step) + 2);
    ny = Math.max(1, Math.ceil((max.y - min.y) / step) + 2);
    nz = Math.max(1, Math.ceil((max.z - min.z) / step) + 2);
  }
  const occ: Occupancy = { min: lo, cell: step, nx, ny, nz, bits: new Uint8Array(nx * ny * nz) };
  const mark = (x: number, y: number, z: number) => {
    const ix = Math.floor((x - lo.x) / step), iy = Math.floor((y - lo.y) / step), iz = Math.floor((z - lo.z) / step);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    occ.bits[ix + nx * (iy + ny * iz)] = 1;
  };
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
    const bx = triangles[t + 3], by = triangles[t + 4], bz = triangles[t + 5];
    const cx = triangles[t + 6], cy = triangles[t + 7], cz = triangles[t + 8];
    const e1 = Math.hypot(bx - ax, by - ay, bz - az), e2 = Math.hypot(cx - ax, cy - ay, cz - az);
    const n = Math.min(64, Math.max(1, Math.ceil(Math.max(e1, e2) / (step * 0.5))));
    for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      mark(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
    }
  }
  return occ;
}

/**
 * Is the straight line from a to b blocked? A 3D DDA over the voxels, ignoring the cells at both
 * ends (the emitter sits inside its own lamp, the probe may sit inside a wall).
 */
export function occluded(occ: Occupancy, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  if (!occ.bits.length) return false;
  const { min, cell, nx, ny, nz, bits } = occ;
  let ix = Math.floor((ax - min.x) / cell), iy = Math.floor((ay - min.y) / cell), iz = Math.floor((az - min.z) / cell);
  const ex = Math.floor((bx - min.x) / cell), ey = Math.floor((by - min.y) / cell), ez = Math.floor((bz - min.z) / cell);
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const inv = (d: number) => (d === 0 ? Infinity : Math.abs(cell / d));
  const tdx = inv(dx), tdy = inv(dy), tdz = inv(dz);
  const first = (a: number, lo: number, i: number, s: number, d: number) => {
    if (d === 0) return Infinity;
    const nextEdge = lo + (i + (s > 0 ? 1 : 0)) * cell;
    return (nextEdge - a) / d;
  };
  let tx = first(ax, min.x, ix, sx, dx), ty = first(ay, min.y, iy, sy, dy), tz = first(az, min.z, iz, sz, dz);
  const steps = Math.abs(ex - ix) + Math.abs(ey - iy) + Math.abs(ez - iz);
  for (let n = 0; n < steps; n++) {
    if (tx <= ty && tx <= tz) { ix += sx; tx += tdx; } else if (ty <= tz) { iy += sy; ty += tdy; } else { iz += sz; tz += tdz; }
    if (ix === ex && iy === ey && iz === ez) return false;   // reached the emitter's own cell
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
    if (n === 0) continue;                                    // the cell the probe sits in never blocks
    if (bits[ix + nx * (iy + ny * iz)]) return true;
  }
  return false;
}

// -- the transfer matrix ---------------------------------------------------------------

/** `k` strongest emitters per probe: `slots[p*k + i]` is a pixel slot (-1 = unused), `weights` its 4 SH weights. */
export interface Transfer {
  probes: number;
  k: number;
  slots: Int32Array;
  /** `weights[(p*k + i)*SH_COEFFS + c]` */
  weights: Float32Array;
  grid: ProbeGrid;
}

export interface BakeOptions {
  /** emitters kept per probe */
  k?: number;
  /** ignore emitters further than this (mm); 0 = no limit */
  radius?: number;
  occupancy?: Occupancy;
  /** probes to fill; the caller may bake in slices */
  from?: number;
  to?: number;
  /** re-use the arrays of a previous bake (same grid, same k) */
  into?: Transfer;
}

/**
 * Bake the emitters into the grid. A probe keeps its `k` strongest emitters — strength is the
 * unshadowed `area / distance²`, then blocked ones are dropped, so a shadowed lamp does not
 * take a slot from one that shines.
 */
export function bakeTransfer(grid: ProbeGrid, emitters: Emitter[], opts: BakeOptions = {}): Transfer {
  const k = Math.max(1, opts.k ?? 24);
  const probes = probeCount(grid);
  const out: Transfer = opts.into && opts.into.k === k && opts.into.probes === probes
    ? opts.into
    : { probes, k, slots: new Int32Array(probes * k).fill(-1), weights: new Float32Array(probes * k * SH_COEFFS), grid };
  const from = Math.max(0, opts.from ?? 0), to = Math.min(probes, opts.to ?? probes);
  const r2max = opts.radius && opts.radius > 0 ? opts.radius * opts.radius : Infinity;
  const occ = opts.occupancy;
  // candidates: twice the slots, so dropping blocked ones still fills the list
  const wide = k * 2;
  const candW = new Float64Array(wide), candI = new Int32Array(wide);
  const p = { x: 0, y: 0, z: 0 };
  for (let pi = from; pi < to; pi++) {
    probePosition(grid, pi, p);
    let n = 0, worst = 0;
    for (let ei = 0; ei < emitters.length; ei++) {
      const e = emitters[ei];
      const dx = e.x - p.x, dy = e.y - p.y, dz = e.z - p.z;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > r2max) continue;
      // mm² over mm² → the 1/r² falloff in metres cancels the mm² of the area
      const w = e.area / Math.max(r2, 1);
      if (n < wide) {
        candW[n] = w; candI[n] = ei; n++;
        if (n === wide) { worst = 0; for (let i = 1; i < wide; i++) if (candW[i] < candW[worst]) worst = i; }
      } else if (w > candW[worst]) {
        candW[worst] = w; candI[worst] = ei;
        worst = 0; for (let i = 1; i < wide; i++) if (candW[i] < candW[worst]) worst = i;
      }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => candW[b] - candW[a]);
    let kept = 0;
    for (const oi of order) {
      if (kept >= k) break;
      const e = emitters[candI[oi]];
      if (occ && occluded(occ, p.x, p.y, p.z, e.x, e.y, e.z)) continue;
      const dx = e.x - p.x, dy = e.y - p.y, dz = e.z - p.z;
      const r = Math.max(1, Math.hypot(dx, dy, dz));
      const w = candW[oi];
      const base = (pi * k + kept) * SH_COEFFS;
      out.slots[pi * k + kept] = e.slot;
      out.weights[base] = w * SH_Y0;
      out.weights[base + 1] = w * SH_Y1 * (dy / r);
      out.weights[base + 2] = w * SH_Y1 * (dz / r);
      out.weights[base + 3] = w * SH_Y1 * (dx / r);
      kept++;
    }
    for (let i = kept; i < k; i++) {
      out.slots[pi * k + i] = -1;
      const base = (pi * k + i) * SH_COEFFS;
      out.weights[base] = out.weights[base + 1] = out.weights[base + 2] = out.weights[base + 3] = 0;
    }
  }
  return out;
}

/**
 * The per-frame step: probe SH from the live pixel colours. `colours` is RGB per slot,
 * `out` is `probes × SH_COEFFS × 3` and is overwritten. `scale` is the world's emitter strength.
 */
export function evaluate(t: Transfer, colours: Float32Array, out: Float32Array, scale = 1): Float32Array {
  out.fill(0);
  const { k, slots, weights, probes } = t;
  for (let pi = 0; pi < probes; pi++) {
    const o = pi * SH_COEFFS * 3;
    for (let i = 0; i < k; i++) {
      const slot = slots[pi * k + i];
      if (slot < 0) continue;
      const c = slot * 3;
      const r = colours[c] * scale, g = colours[c + 1] * scale, b = colours[c + 2] * scale;
      if (r === 0 && g === 0 && b === 0) continue;
      const w = (pi * k + i) * SH_COEFFS;
      for (let q = 0; q < SH_COEFFS; q++) {
        const wq = weights[w + q];
        if (wq === 0) continue;
        out[o + q * 3] += r * wq;
        out[o + q * 3 + 1] += g * wq;
        out[o + q * 3 + 2] += b * wq;
      }
    }
  }
  return out;
}

/** Irradiance on a surface facing `n` at probe `pi` — three's `getShIrradianceAt`, bands 0 and 1 (for tests). */
export function irradianceAt(sh: Float32Array, pi: number, n: Vec3Like, channel = 0): number {
  const o = pi * SH_COEFFS * 3 + channel;
  return sh[o] * 0.886227 + 2 * 0.511664 * (sh[o + 3] * n.y + sh[o + 6] * n.z + sh[o + 9] * n.x);
}
