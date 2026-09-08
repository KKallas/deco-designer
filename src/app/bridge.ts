/**
 * Agent bridge, browser side (dev server only, docs/07-agent-bridge.md).
 * The Vite plugin in vite.config.ts forwards `POST /__deco/exec` bodies here
 * over the HMR websocket; the code runs in the page with the given API
 * names in scope, inside one store transaction (= one undo step), and the
 * result goes back as JSON.
 */
import type { Store } from './store';

export type BridgeApi = Record<string, unknown> & { store: Store };

function compile(code: string, names: string[]): (...args: unknown[]) => unknown {
  try {
    return new Function(...names, `"use strict"; return (\n${code}\n);`) as (...a: unknown[]) => unknown;   // expression
  } catch {
    return new Function(...names, `"use strict"; return (async () => {\n${code}\n})();`) as (...a: unknown[]) => unknown;   // statements, `return` / `await` allowed
  }
}

function toJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value === undefined ? null : value, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') return String(v);
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    if (v instanceof Error) return v.stack ?? v.message;
    if (v && typeof v === 'object') { if (seen.has(v)) return '[circular]'; seen.add(v); }
    return v;
  }) ?? 'null';
}

export function installBridge(api: BridgeApi): void {
  const hot = import.meta.hot;
  if (!hot) return;
  const names = Object.keys(api);
  hot.on('deco:ping', ({ id }: { id: string }) => hot.send('deco:pong', { id }));   // "I am the designer tab"
  hot.on('deco:exec', async ({ id, code }: { id: string; code: string }) => {
    let ok = true, value: unknown;
    try {
      const fn = compile(code, names);
      value = await api.store.transaction(() => fn(...names.map((k) => api[k])));
    } catch (e) {
      ok = false;
      value = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    hot.send('deco:result', { id, ok, json: toJson(value) });
  });
}
