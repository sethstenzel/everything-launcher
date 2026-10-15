/**
 * A local stand-in for Puter's key-value store (puter.kv), one per app, kept
 * as JSON in the app's own folder of the local cloud:
 *
 *   <cloud>/AppData/<app>/.everything-kv.json
 *
 * Values are whatever JSON the app stores. Expiry (expireAt, in Unix seconds)
 * is honoured on read. Writes are batched and saved atomically.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAVE_DELAY_MS = 150;

export function createLocalKv({ root, appId }) {
  const dir = path.join(root, 'AppData', appId);
  const file = path.join(dir, '.everything-kv.json');
  mkdirSync(dir, { recursive: true });

  /** key -> { v: value, x?: expireAt (seconds) } */
  let data = new Map();
  try {
    data = new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))));
  } catch {
    /* new store */
  }

  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(flushToDisk, SAVE_DELAY_MS);
  }
  function flushToDisk() {
    timer = null;
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(data)));
    renameSync(temp, file);
  }
  process.once('exit', () => timer && flushToDisk());

  const now = () => Date.now() / 1000;
  function live(key) {
    const entry = data.get(key);
    if (!entry) return undefined;
    if (entry.x && entry.x <= now()) {
      data.delete(key);
      save();
      return undefined;
    }
    return entry;
  }

  const check = (key) => {
    if (typeof key !== 'string' || !key) throw Object.assign(new Error('A key is required.'), { status: 400, code: 'invalid_key' });
    return key;
  };

  /** Puter's list pattern: "*" matches anything; a pattern without "*" is a prefix ("pm1:r:" lists pm1:r:…). */
  const patternToRegExp = (pattern) => {
    const body = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(pattern.includes('*') ? `^${body}$` : `^${body}`);
  };

  /** "a.b.c", or with bracket-quoted segments for names containing dots: 'tx["2026.10"]', '["tx.2026-10"]'. */
  function parsePath(text) {
    const parts = [];
    const re = /\[\s*(["'])(.*?)\1\s*\]|([^.[\]]+)/g;
    let m;
    while ((m = re.exec(text))) parts.push(m[2] ?? m[3]);
    return parts.length ? parts : [text];
  }

  /** Sets a path inside an object value (Puter's update/incr with a path map). */
  function setPath(obj, dotted, fn) {
    const parts = parsePath(dotted);
    let cur = obj;
    for (const part of parts.slice(0, -1)) cur = cur[part] = cur[part] && typeof cur[part] === 'object' ? cur[part] : {};
    const last = parts[parts.length - 1];
    cur[last] = fn(cur[last]);
  }

  /** Deletes a path inside an object value (Puter's remove). */
  function deletePath(obj, dotted) {
    const parts = parsePath(dotted);
    let cur = obj;
    for (const part of parts.slice(0, -1)) {
      if (!cur || typeof cur !== 'object') return;
      cur = cur[part];
    }
    if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
  }

  const ops = {
    get({ key, keys }) {
      // get([k1, k2]) returns the values in order
      if (Array.isArray(keys)) return keys.map((k) => live(check(k))?.v ?? null);
      return live(check(key))?.v ?? null;
    },
    remove({ key, paths = [] }) {
      const entry = live(check(key));
      if (!entry) return null;
      if (entry.v && typeof entry.v === 'object') for (const p of paths) deletePath(entry.v, p);
      save();
      return entry.v;
    },
    add({ key, value }) {
      // Atomic append: add(key, [values]) appends to the list at the key; add(key, { path: values }) to lists inside it.
      const entry = live(check(key));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = entry && entry.v && typeof entry.v === 'object' ? entry.v : {};
        for (const [p, items] of Object.entries(value)) setPath(obj, p, (old) => (Array.isArray(old) ? old : []).concat(items));
        data.set(key, { ...(entry?.x ? { x: entry.x } : {}), v: obj });
        save();
        return obj;
      }
      const list = (Array.isArray(entry?.v) ? entry.v : []).concat(value);
      data.set(key, { ...(entry?.x ? { x: entry.x } : {}), v: list });
      save();
      return list;
    },
    set({ key, value, expireAt, items }) {
      // Batch form: set([{ key, value, expireAt? }, …])
      for (const item of items ?? [{ key, value, expireAt }]) {
        data.set(check(item.key), item.expireAt ? { v: item.value, x: item.expireAt } : { v: item.value });
      }
      save();
      return true;
    },
    del({ key }) {
      data.delete(check(key));
      save();
      return true;
    },
    incr({ key, amount = 1 }) {
      return change(check(key), amount, 1);
    },
    decr({ key, amount = 1 }) {
      return change(check(key), amount, -1);
    },
    update({ key, values, expireAt }) {
      const entry = live(check(key));
      const obj = entry && entry.v && typeof entry.v === 'object' ? entry.v : {};
      for (const [p, v] of Object.entries(values || {})) setPath(obj, p, () => v);
      data.set(key, expireAt ? { v: obj, x: expireAt } : { ...(entry?.x ? { x: entry.x } : {}), v: obj });
      save();
      return obj;
    },
    list({ pattern, returnValues, reverse }) {
      // Always the complete list: callers that page with limit/cursor treat a plain array as the last page.
      const match = pattern ? patternToRegExp(pattern) : null;
      const out = [];
      const keys = [...data.keys()].sort();
      if (reverse) keys.reverse();
      for (const key of keys) {
        if (match && !match.test(key)) continue;
        const entry = live(key);
        if (!entry) continue;
        out.push(returnValues ? { key, value: entry.v } : key);
      }
      return out;
    },
    flush() {
      data.clear();
      save();
      return true;
    },
    expire({ key, ttl }) {
      return ops.expireAt({ key, expireAt: now() + Number(ttl) });
    },
    expireAt({ key, expireAt }) {
      const entry = live(check(key));
      if (!entry) return false;
      entry.x = Number(expireAt);
      save();
      return true;
    },
  };

  /** incr/decr by a number, or by a map of dotted paths to amounts inside an object value. */
  function change(key, amount, sign) {
    const entry = live(key);
    if (amount && typeof amount === 'object') {
      const obj = entry && entry.v && typeof entry.v === 'object' ? entry.v : {};
      for (const [p, n] of Object.entries(amount)) setPath(obj, p, (old) => (Number(old) || 0) + sign * Number(n));
      data.set(key, { ...(entry?.x ? { x: entry.x } : {}), v: obj });
      save();
      return obj;
    }
    const value = (Number(entry?.v) || 0) + sign * Number(amount);
    data.set(key, { ...(entry?.x ? { x: entry.x } : {}), v: value });
    save();
    return value;
  }

  async function handle(req, res, op) {
    try {
      if (req.method !== 'POST') throw Object.assign(new Error('Use POST.'), { status: 405, code: 'method_not_allowed' });
      if (!Object.hasOwn(ops, op)) throw Object.assign(new Error(`Unknown operation ${op}.`), { status: 404, code: 'not_found' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 50 * 1024 * 1024) throw Object.assign(new Error('Value too large.'), { status: 413, code: 'too_large' });
      }
      const result = ops[op](body ? JSON.parse(body) : {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: e.code || 'internal_error', message: e.message } }));
    }
  }

  return { handle };
}
