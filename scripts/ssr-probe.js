// SSR look probe (docs/31-ssr.md §4): run in the designer tab through the bridge —
//   node scripts/deco.mjs exec scripts/ssr-probe.js
// Adds a straight LED string over a gold sheet far above everything, looks at the sheet from the front,
// renders the frame the viewport presents with the Eevee `reflections` knob at 1 and at 0 (bloom, streaks
// and flare at 0, so the difference is the reflections alone), mirrors every lamp tip about the sheet and
// reads the pixel there. Then removes what it added and restores the script and the view.
const { PRESET_PROFILES } = await import('/src/model/profiles.ts');
const { POST_PRESETS } = await import('/src/model/post-presets.ts');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (document.hidden) return { error: 'the designer tab is hidden — the probe reads presented frames, bring it to the front' };
const led = PRESET_PROFILES.find((p) => p.id === 'led-strip');
const eevee = POST_PRESETS.find((p) => p.id === 'eevee');
const saved = { post: JSON.parse(JSON.stringify(project.post)), view: viewer.viewInfo(), selection: JSON.parse(JSON.stringify(store.selection)), camera: project.activeCamera };

// -- the rig: a 600 mm string 120 mm above a 900 × 500 mm gold sheet, 60 m up ----------------------------------
let profileId = project.profiles.find((p) => p.code === led.code)?.id ?? null;
let addedProfile = false;
if (!profileId) { profileId = cmd.addProfile(store, { ...led, label: 'LED (ssr probe)' }); addedProfile = true; }
const Y = 60000, LIFT = 120;   // 60 m up: nothing of a document is there (the look probe uses 50 m)
const gold = cmd.addMaterial(store, { name: 'Gold (ssr probe)', code: '(tsl) => { const m = new tsl.MeshPhysicalNodeMaterial(); m.color.set(0xd4a017); m.metalness = 1; m.roughness = 0.12; return m; }', source: '', warnings: [] });
const stringPlane = cmd.addPlane(store, 'front');
cmd.setPlanePlacement(store, stringPlane, { position: { x: 0, y: Y + LIFT, z: 0 } });
const string = cmd.addCurve(store, stringPlane);
cmd.addVertex(store, string, { x: -300, y: 0 }); cmd.addVertex(store, string, { x: 300, y: 0 }); cmd.exitEdit(store);
cmd.setCurveProfile(store, string, profileId);
cmd.setCurveParams(store, [string], { seed: 7 });
const sheetPlane = cmd.addPlane(store, 'top');
cmd.setPlanePlacement(store, sheetPlane, { position: { x: 0, y: Y, z: 0 } });
const frame = cmd.addCurve(store, sheetPlane);
for (const [x, y] of [[-450, -250], [450, -250], [450, 250], [-450, 250]]) cmd.addVertex(store, frame, { x, y });
cmd.exitEdit(store);
cmd.toggleClosed(store, frame);
for (const l of project.curves.find((c) => c.id === frame).outline) cmd.removeOutlineLayer(store, frame, l.id);   // a construction line: the sheet alone
const sheet = cmd.addShape(store, [frame], { name: 'Gold sheet (ssr probe)' });
const layer = project.shapes.find((s) => s.id === sheet)?.layers[0];
if (layer) cmd.updateShapeLayer(store, sheet, layer.id, { materialId: gold });
cmd.selectCurve(store, null);
// a probe camera (docs/36: the view always looks through one — the user's would pull the view back to its pose), removed
// at the end. Its world: no environment or sun, so the sheet shows the lamps' reflection and their glow, nothing else.
// From the front, well above the sheet (34° down), so the string and its mirror image are both in frame and the
// mirror image lands inside the sheet (from lower down it falls beyond the near edge).
const probeCam = cmd.addCamera(store, { name: 'SSR probe', frame: { show: false }, pose: { position: { x: 0, y: Y + 1500, z: 2200 }, target: { x: 0, y: Y, z: 0 } },
  world: { background: { kind: 'color', color: '#000000' }, environment: { kind: 'none' }, sun: { enabled: false }, emitters: { enabled: false } } });
cmd.setActiveCamera(store, probeCam);
viewer.setView({ x: 0, y: Y + 1500, z: 2200 }, { x: 0, y: Y, z: 0 });
await wait(900);

// -- capture what the screen presents ---------------------------------------------------------------------------
// a 1:1 crop of the canvas centre (a downscale would average the sub-pixel lamps away)
const src = viewer.renderer.domElement, CW = Math.min(1400, src.width), CH = Math.min(900, src.height), OX = Math.round((src.width - CW) / 2), OY = Math.round((src.height - CH) / 2);
const capture = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const c = document.createElement('canvas'); c.width = CW; c.height = CH;
  const g = c.getContext('2d'); g.drawImage(src, OX, OY, CW, CH, 0, 0, CW, CH);
  res({ data: g.getImageData(0, 0, CW, CH), url: c.toDataURL('image/jpeg', 0.85) });
})));
const withKnobs = (extra) => cmd.setPost(store, { label: eevee.label, code: eevee.code, params: { ...eevee.params, strength: 0, streaks: 0, flare: 0, ...extra }, enabled: true });
withKnobs({ reflections: 1 }); await wait(900);
const on = await capture();
const onError = viewer.postError;
withKnobs({ reflections: 0 }); await wait(900);
const off = await capture();

// -- measure: the mirror image of every lamp tip in the sheet -----------------------------------------------------
const W = on.data.width, H = on.data.height;
const lum = (d) => { const out = new Float32Array(W * H); for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; return out; };
const Lon = lum(on.data.data), Loff = lum(off.data.data);
let mesh = null; viewer.content.traverse((o) => { if (o.isMesh && o.userData.curveId === string) mesh = o; });
const tips = [], mirrors = [];
if (mesh) {
  const pos = mesh.geometry.getAttribute('position'), em = mesh.geometry.getAttribute('emissive');
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < pos.count; i += 24) {
    if (em.getX(i) <= 0) continue;
    const c = new mesh.position.constructor();
    for (let k = 0; k < 24; k++) c.x += pos.getX(i + k) / 24, c.y += pos.getY(i + k) / 24, c.z += pos.getZ(i + k) / 24;
    c.applyMatrix4(mesh.matrixWorld);
    const m = c.clone(); m.y = Y - (c.y - Y);          // mirrored about the sheet
    for (const [p, list] of [[c, tips], [m, mirrors]]) {
      p.project(viewer.camera);
      const x = Math.round((p.x + 1) / 2 * src.width) - OX, y = Math.round((1 - p.y) / 2 * src.height) - OY;
      if (x >= 0 && y >= 0 && x < W && y < H) list.push([x, y]);
    }
  }
}
// the brightest pixel within 3 px of each mirrored tip, with and without reflections; and the sheet between the tips
const peak = (L, [tx, ty]) => { let v = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const x = tx + dx, y = ty + dy; if (x >= 0 && y >= 0 && x < W && y < H) v = Math.max(v, L[y * W + x]); } return v; };
const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
const mirrorOn = mean(mirrors.map((t) => peak(Lon, t))), mirrorOff = mean(mirrors.map((t) => peak(Loff, t)));
const lit = mirrors.filter((t) => peak(Lon, t) > peak(Loff, t) + 0.15).length;

// -- restore --------------------------------------------------------------------------------------------------------
cmd.removeShape(store, sheet);
cmd.removePlane(store, sheetPlane);
cmd.removePlane(store, stringPlane);
cmd.removeMaterial(store, gold);
if (addedProfile) cmd.removeProfile(store, profileId);
cmd.setPost(store, saved.post);
cmd.setActiveCamera(store, saved.camera);
cmd.removeCamera(store, probeCam);
viewer.setView(saved.view.position, saved.view.target);
store.update((s) => { s.selection = saved.selection; }, { history: false });

return { tips: tips.length, mirrors: mirrors.length, mirrorOn: +mirrorOn.toFixed(3), mirrorOff: +mirrorOff.toFixed(3), lit, onError, size: [W, H], image: on.url };
