#!/usr/bin/env node
// Agent CLI for the document open in the browser (docs/07-agent-bridge.md).
// Needs `npm run dev` running and one tab open on it.  DECO_URL overrides http://localhost:5173.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const base = (process.env.DECO_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const [command, ...rest] = process.argv.slice(2);
const ITEM_EXT = '.deco.json';   // an archive item (docs/33-object-archive.md)

const USAGE = `usage: node scripts/deco.mjs <command>
  overview            one-screen tree of the open project (objects ▣ planes ▤ curves ○ lofts ◇, lengths, violations)
  curve <id>          vertices (with ids / handles), constraints, violations of one curve
  exec '<js>'         run JavaScript in the page; the value of the expression (or a \`return\`) is printed
  exec <file.js>      … from a file      exec -   … from stdin
  project             full project JSON        load <file.json>   replace the project
  render <out.png> [width]   a still of the camera frame through the post script (default 3840 px wide, ≤ 8192)
  archive ls [dir]                 the items of an archive folder (docs/33-object-archive.md)
  archive save <groupId> [dir] [--images] [--tags a,b]   write the object as <slug>.deco.json + .png
  archive add <name|file> [dir] [--into <groupId>]        bring an item into the open project → its object id
  archive show <name|file> [dir]   the item's own overview
                      (dir: the argument, else $DECO_ARCHIVE, else ./archive)
  status              connected tabs / is the designer tab answering
  help                names in scope for exec`;

async function call(route, body) {
  let res;
  try {
    res = await fetch(`${base}/__deco/${route}`, body == null ? {} : { method: 'POST', body, headers: { 'content-type': 'text/plain' } });
  } catch {
    fail(`dev server not reachable at ${base} — start it with \`npm run dev\` and open it in a browser`);
  }
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { fail(`unexpected response ${res.status} from ${base}/__deco/${route}: ${text.slice(0, 200)}`); }
  if (!out.ok) fail(out.value);
  return out.value;
}

function fail(msg) { console.error(typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)); process.exit(1); }
function print(v) { console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }
const source = (arg) => (arg === '-' ? readFileSync(0, 'utf8') : /\.(m?js|ts)$/.test(arg) ? readFileSync(arg, 'utf8') : arg);

switch (command) {
  case 'overview': case 'help': case 'project': case 'status': print(await call(command)); break;
  case 'curve': if (!rest[0]) fail(USAGE); print(await call('exec', `curve(${JSON.stringify(rest[0])})`)); break;
  case 'exec': if (!rest[0]) fail(USAGE); print(await call('exec', source(rest[0]))); break;
  case 'render': {
    if (!rest[0]) fail(USAGE);
    const width = rest[1] ? Number(rest[1]) : undefined;
    const still = await call('exec', `const s = viewer.renderStill(${JSON.stringify({ width })}); return { width: s.width, height: s.height, name: s.name, url: s.url };`);
    writeFileSync(rest[0], Buffer.from(still.url.split(',')[1], 'base64'));
    print(`${rest[0]}: ${still.width} × ${still.height} px (${still.name})`);
    break;
  }
  case 'archive': { await archive(rest); break; }
  case 'load': if (!rest[0]) fail(USAGE); print(await call('exec', `setProject(${JSON.stringify(JSON.parse(readFileSync(rest[0], 'utf8')))})`)); break;
  default: fail(USAGE);
}

// -- the object archive (docs/33-object-archive.md §7): Node has the folder, the page has the project ----------------
async function archive(args) {
  const [sub, ...tail] = args;
  const flags = {}, pos = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--images') flags.images = true;
    else if (a === '--tags') flags.tags = (tail[++i] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    else if (a === '--into') flags.into = tail[++i];
    else if (a.startsWith('--')) fail(`unknown flag ${a}\n${USAGE}`);
    else pos.push(a);
  }
  // the folder: an extra positional, else $DECO_ARCHIVE, else ./archive
  const needsName = sub === 'save' || sub === 'add' || sub === 'show';
  const dir = resolve(pos[needsName ? 1 : 0] ?? process.env.DECO_ARCHIVE ?? 'archive');
  const items = () => {
    const out = [];
    const scan = (d, prefix, deeper) => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) { if (deeper) scan(p, `${prefix}${name}/`, false); continue; }
        if (!name.endsWith(ITEM_EXT)) continue;
        try {
          const item = JSON.parse(readFileSync(p, 'utf8'));
          out.push({ file: prefix + name, path: p, name: item.name ?? name, tags: item.item?.tags ?? [], created: item.item?.created ?? '', size: statSync(p).size, root: item.item?.root ?? null, curves: item.curves?.length ?? 0 });
        } catch { /* not an item */ }
      }
    };
    scan(dir, '', true);
    return out;
  };
  const locate = (arg) => {
    if (!arg) fail(USAGE);
    if (existsSync(arg) && statSync(arg).isFile()) return arg;
    for (const c of [join(dir, arg), join(dir, arg + ITEM_EXT), join(dir, arg + '.json')]) if (existsSync(c) && statSync(c).isFile()) return c;
    const hit = items().find((it) => it.name === arg || basename(it.file, ITEM_EXT) === arg);
    if (hit) return hit.path;
    fail(`no item "${arg}" in ${dir} — \`archive ls\` lists them`);
  };
  switch (sub) {
    case 'ls': {
      const list = items();
      if (!list.length) { print(`no items in ${dir}`); break; }
      for (const it of list) print(`${it.name.padEnd(28)} ${(it.tags.join(',') || '-').padEnd(20)} ${String(Math.max(1, Math.round(it.size / 1024))).padStart(6)} kB  ${it.created.slice(0, 10).padEnd(10)}  ${it.file}`);
      break;
    }
    case 'save': {
      if (!pos[0]) fail(USAGE);
      const item = await call('exec', `return archive.item(${JSON.stringify(pos[0])}, ${JSON.stringify({ images: !!flags.images, tags: flags.tags ?? [] })})`);
      if (!item) fail(`no object ${pos[0]} — \`overview\` lists them`);
      mkdirSync(dir, { recursive: true });
      const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'object';
      const file = join(dir, slug + ITEM_EXT);
      writeFileSync(file, JSON.stringify(item));
      if (item.item?.thumbnail) writeFileSync(join(dir, slug + '.png'), Buffer.from(item.item.thumbnail.split(',')[1], 'base64'));
      print(`${file}: ${item.curves.length} curves, ${item.planes.length} planes, ${item.groups.length} objects, ${Math.round(statSync(file).size / 1024)} kB${item.item?.thumbnail ? ' + thumbnail' : ''}`);
      break;
    }
    case 'add': {
      const raw = JSON.parse(readFileSync(locate(pos[0]), 'utf8'));
      const r = await call('exec', `return archive.insert(${JSON.stringify(raw)}, ${JSON.stringify({ into: flags.into ?? null })})`);
      if (!r) fail(`${pos[0]} is not an archive item`);
      print(`inserted ${r.root}${flags.into ? ` into ${flags.into}` : ''}`);
      print(r.overview);
      break;
    }
    case 'show': {
      const raw = JSON.parse(readFileSync(locate(pos[0]), 'utf8'));
      print(await call('exec', `return archive.overview(${JSON.stringify(raw)})`));
      break;
    }
    default: fail(USAGE);
  }
}
