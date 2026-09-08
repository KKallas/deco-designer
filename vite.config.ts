import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';

/**
 * Agent bridge (dev server only, docs/07-agent-bridge.md). Forwards HTTP
 * requests to the page open in the browser over the HMR websocket:
 *   GET  /__deco/overview | /__deco/project | /__deco/help | /__deco/status
 *   POST /__deco/exec   (body = JavaScript, run in the page — see src/app/bridge.ts)
 * Talks to one tab only (the first that answers a ping — only the designer
 * page installs the bridge, so other pages like materials.html never receive a
 * mutation). Use it through `node scripts/deco.mjs`.
 */
function decoBridge(): Plugin {
  return {
    name: 'deco-bridge',
    apply: 'serve',
    configureServer(server) {
      type Result = { id: string; ok: boolean; json: string };
      const pending = new Map<string, (r: Result) => void>();
      let seq = 0;
      server.ws.on('deco:result', (data: Result) => { pending.get(data.id)?.(data); });

      type Client = { send: (event: string, data: unknown) => void };
      const pings = new Map<string, (c: Client) => void>();
      server.ws.on('deco:pong', (data: { id: string }, client: Client) => { pings.get(data.id)?.(client); });
      /** The designer tab: the first client that answers a ping. */
      const findClient = () => new Promise<Client>((resolve, reject) => {
        const clients = [...server.ws.clients];
        const url = server.resolvedUrls?.local[0] ?? 'the dev server URL';
        if (!clients.length) return reject(new Error(`no browser tab connected — open ${url}`));
        const id = `ping-${++seq}`;
        const timer = setTimeout(() => { pings.delete(id); reject(new Error(`no designer tab answered — open ${url} (materials.html alone is not enough)`)); }, 3000);
        pings.set(id, (c) => { clearTimeout(timer); pings.delete(id); resolve(c); });
        for (const c of clients) c.send('deco:ping', { id });
      });

      const exec = async (code: string, timeoutMs = 20000) => new Promise<Result>((resolve, reject) => {
        findClient().then((client) => {
        const id = `${Date.now()}-${++seq}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no answer from the page in ${timeoutMs / 1000} s`)); }, timeoutMs);
        pending.set(id, (r) => { clearTimeout(timer); pending.delete(id); resolve(r); });
        client.send('deco:exec', { id, code });
        }, reject);
      });

      const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
        let s = ''; req.setEncoding('utf8'); req.on('data', (c: string) => { s += c; }); req.on('end', () => resolve(s)); req.on('error', reject);
      });
      const SHORTCUTS: Record<string, string> = { overview: 'overview()', project: 'project', help: 'help()' };
      /** GET /__deco/status — how many tabs are connected and whether one of them is the designer. */
      const status = async () => {
        const clients = server.ws.clients.size;
        const designer = await findClient().then(() => true, () => false);
        return { clients, designer, url: server.resolvedUrls?.local[0] ?? null };
      };

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__deco/')) return next();
        const route = req.url.slice('/__deco/'.length).split('?')[0];
        res.setHeader('content-type', 'application/json');
        if (route === 'status') { res.end(JSON.stringify({ ok: true, value: await status() })); return; }
        const code = req.method === 'POST' && route === 'exec' ? await readBody(req) : SHORTCUTS[route];
        if (code == null) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, value: `unknown route /__deco/${route}` })); return; }
        try {
          const r = await exec(code);
          res.statusCode = r.ok ? 200 : 422;
          res.end(JSON.stringify({ ok: r.ok, value: JSON.parse(r.json) }));
        } catch (e) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, value: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [decoBridge()],
  build: {
    target: 'esnext', // top-level await for WebGPU renderer init
    rollupOptions: {
      // more pages: materials (docs/13-material-editor.md), shapes (docs/14-shapes.md)
      input: { main: resolve(__dirname, 'index.html'), materials: resolve(__dirname, 'materials.html'), shapes: resolve(__dirname, 'shapes.html') },
    },
  },
});
