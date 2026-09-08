// Look probe (docs/15-camera.md): run in the designer tab through the bridge —
//   node scripts/deco.mjs exec scripts/look-probe.js
// or by tests/look.test.ts. Adds a temporary straight LED string, frames it, renders the frame the
// viewport actually presents with the post script ON (Eevee preset) and OFF, and measures on the
// pixels: the halo ring around the lamp tips and the brightness along the four streak directions
// versus between them. Then removes what it added and restores the script and the view.
const { PRESET_PROFILES } = await import('/src/model/profiles.ts');
const { POST_PRESETS } = await import('/src/model/post-presets.ts');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const led = PRESET_PROFILES.find((p) => p.id === 'led-strip');
const eevee = POST_PRESETS.find((p) => p.id === 'eevee');
const saved = { post: JSON.parse(JSON.stringify(project.post)), view: viewer.viewInfo(), selection: JSON.parse(JSON.stringify(store.selection)), camera: project.activeCamera };
if (document.hidden) return { error: 'the designer tab is hidden — the probe reads presented frames, bring it to the front' };

// -- a straight 600 mm LED string far above everything, seen from 3 m (tips a couple of pixels wide) --
let profileId = project.profiles.find((p) => p.code === led.code)?.id ?? null;
let addedProfile = false;
if (!profileId) { profileId = cmd.addProfile(store, { ...led, label: 'LED (look probe)' }); addedProfile = true; }
const Y = 50000;
const plane = cmd.addPlane(store, 'front');
cmd.setPlanePlacement(store, plane, { position: { x: 0, y: Y, z: 0 } });
const curve = cmd.addCurve(store, plane);
cmd.addVertex(store, curve, { x: -300, y: 0 }); cmd.addVertex(store, curve, { x: 300, y: 0 }); cmd.exitEdit(store);
cmd.setCurveProfile(store, curve, profileId);
cmd.setCurveParams(store, [curve], { seed: 7 });
cmd.selectCurve(store, null);
// a probe camera (docs/36: the view always looks through one — the user's would pull the view back to its pose and
// the probe would measure the wrong frame): no frame, the world of the camera being left, removed at the end
const probeCam = cmd.addCamera(store, { name: 'Look probe', frame: { show: false }, world: store.project.cameras.find((c) => c.id === saved.camera)?.world, pose: { position: { x: 0, y: Y + 150, z: 3000 }, target: { x: 0, y: Y, z: 0 } } });
cmd.setActiveCamera(store, probeCam);
viewer.setView({ x: 0, y: Y + 150, z: 3000 }, { x: 0, y: Y, z: 0 });
await wait(900);

// -- capture what the screen presents: read the canvas in a frame callback that runs after the loop's tick --
const capture = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const src = viewer.renderer.domElement; const c = document.createElement('canvas'); const k = Math.min(1, 900 / src.width);
  c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
  const g = c.getContext('2d'); g.drawImage(src, 0, 0, c.width, c.height);
  res({ data: g.getImageData(0, 0, c.width, c.height), url: c.toDataURL('image/jpeg', 0.85) });
})));
// three presented frames: plain (script off), bloom only (streak and flare knobs 0), bloom + streaks (flare 0,
// so the difference is the streaks alone)
const withKnobs = (extra) => cmd.setPost(store, { label: eevee.label, code: eevee.code, params: { ...eevee.params, ...extra }, enabled: true });
withKnobs({ streaks: 0, flare: 0 }); await wait(800);
const bloomOnly = await capture();
withKnobs({ flare: 0 }); await wait(800);
const fx = await capture();
const fxError = viewer.postError;
cmd.setPost(store, { enabled: false }); await wait(500);
const plain = await capture();

// -- measure ------------------------------------------------------------------------------------
const W = fx.data.width, H = fx.data.height;
const lum = (d) => { const out = new Float32Array(W * H); for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; return out; };
const Lf = lum(fx.data.data), Lb = lum(bloomOnly.data.data), Lp = lum(plain.data.data);
// lamp tips: the lit boxes of the string's mesh (emissive vertices), projected to the frame
let mesh = null; viewer.content.traverse((o) => { if (o.isMesh && o.userData.curveId === curve) mesh = o; });
const tips = [];
if (mesh) {
  const pos = mesh.geometry.getAttribute('position'), em = mesh.geometry.getAttribute('emissive');
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < pos.count; i += 24) {
    if (em.getX(i) <= 0) continue;
    const c = new mesh.position.constructor();
    for (let k = 0; k < 24; k++) c.x += pos.getX(i + k) / 24, c.y += pos.getY(i + k) / 24, c.z += pos.getZ(i + k) / 24;
    c.applyMatrix4(mesh.matrixWorld).project(viewer.camera);
    const x = Math.round((c.x + 1) / 2 * W), y = Math.round((1 - c.y) / 2 * H);
    if (x >= 0 && y >= 0 && x < W && y < H) tips.push([x, y]);
  }
}
// halo: pixels 6..24 px from a tip that are dark in the plain frame — how much brighter with bloom alone
let haloSum = 0, haloN = 0;
for (const [tx, ty] of tips) for (let dy = -24; dy <= 24; dy++) for (let dx = -24; dx <= 24; dx++) {
  const d = Math.hypot(dx, dy); if (d < 6 || d > 24) continue;
  const x = tx + dx, y = ty + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const i = y * W + x; if (Lp[i] > 0.3) continue;
  haloSum += Lb[i] - Lp[i]; haloN++;
}
const halo = haloN ? haloSum / haloN : 0;
// streaks: what the streak knob adds (full − bloom only) around each tip, binned by angle (7.5°) at 40..160 px;
// four thin rays make a few bins much brighter than the rest
const BINS = 48, bins = new Float64Array(BINS), counts = new Float64Array(BINS);
for (const [tx, ty] of tips) for (let d = 40; d <= 160; d += 3) for (let b = 0; b < BINS; b++) {
  const a = ((b + 0.5) / BINS) * Math.PI * 2;
  const x = Math.round(tx + Math.cos(a) * d), y = Math.round(ty - Math.sin(a) * d);
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const i = y * W + x; if (Lp[i] > 0.3) continue;
  bins[b] += Lf[i] - Lb[i]; counts[b]++;
}
const means = Array.from(bins, (v, b) => (counts[b] ? v / counts[b] : 0));
const sorted = [...means].sort((p, q) => q - p);
const streakTop = sorted.slice(0, 8).reduce((p, q) => p + q, 0) / 8;          // the 8 brightest bins (4 rays × 2 sides ≈ 8 bins)
const streakRest = sorted.slice(8).reduce((p, q) => p + q, 0) / (BINS - 8);

// -- restore -----------------------------------------------------------------------------------
cmd.removePlane(store, plane);
if (addedProfile) cmd.removeProfile(store, profileId);
cmd.setPost(store, saved.post);
cmd.setActiveCamera(store, saved.camera);
cmd.removeCamera(store, probeCam);
viewer.setView(saved.view.position, saved.view.target);
store.update((s) => { s.selection = saved.selection; }, { history: false });

return { tips: tips.length, halo: +halo.toFixed(4), streakTop: +streakTop.toFixed(4), streakRest: +streakRest.toFixed(4), fxError, size: [W, H], image: fx.url };
