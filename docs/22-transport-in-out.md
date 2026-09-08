# Part 22 — The transport is a clock: in / out and loop

Status: **built 2026-09-01**. Revises Part 17 (docs/17-emitters.md §4).

## 1. Why the global animation selector goes
Every fixture already carries its own map (`curve.pixels.animation`, chosen in
the panel), and `PixelBuffer.fill` reads *that* — a chain that plays "Chase"
and one that plays "Sparkle" run side by side today. `project.playback.animation`
drives nothing in the render: it only says whose frame the topbar counter
prints, and it prints "▶ playing" in `overview()`. It is a preview leftover
from when the transport was built before per-fixture maps, and it makes the
project look like it has one animation when it does not.

So the transport becomes what a shared clock actually needs: **play / hold, a
range, and loop.**

```ts
interface Playback {
  playing: boolean;
  loop: boolean;
  /** the clock's range in seconds */
  start: number;
  /** null = as long as the longest map any fixture is patched to */
  end: number | null;
}
```
`animation` is dropped (project **version 12**; the migration drops the field,
`start = 0`, `end = null`, `loop` kept).

## 2. What the topbar shows
```
▶  ⏮   in [0.00]  out [20.00] s   ☑ loop        6.40 s
```
- **▶ / ‖** run or hold, **⏮** back to *in*.
- **in / out** in seconds (two decimals). *out* empty = the dim computed
  value: the longest map patched to any fixture, `frames / fps` — or, while
  nothing is patched yet, the longest map in the project.
- **loop** on: the clock wraps in `[in, out]`; off: it runs to *out* and holds.
- the counter is the clock, in seconds — no animation is singled out. The
  fixture's own frame (`37 / 600`) shows in its panel section, where its map
  is chosen.
- while it plays the counter also says **how fast the viewport is drawing**
  (`6.40 / 20.00 s · 58 fps`, sampled twice a second). The maps run on
  wall-clock time, so a low rate never slows them down — it drops rows of
  them: the number turns red once the viewport falls under 90 % of the
  fastest map playing, and its tooltip says so.

## 3. What each fixture does with the clock
`frameAt(animation, seconds)` keeps mapping the shared clock to that map's own
frame at its own `fps`, **wrapping within its own length** — a 2 s map repeats
seven times across a 14 s range, and two maps of different lengths stay in
phase with the clock, not with each other. The `loop` flag no longer reaches
`frameAt`: it is about the clock, not about a map.

## 4. Decisions
1. Seconds, not frames, are the shared unit — each map has its own `fps`, so a frame number only means something inside one map.
2. A map shorter than the range **repeats**; holding its last frame instead would be a per-fixture property, not a global mode (out of scope).
3. `out = null` (auto) is the default, so a project with one 20 s map needs no setting at all.

## 5. Out of scope
Per-fixture start offsets in time · scrubbing by dragging the counter · a
timeline view · Art-Net output.
