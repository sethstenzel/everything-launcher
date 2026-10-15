/**
 * The local cloud: a folder on this computer that stands in for Puter's
 * cloud storage. Serves a small HTTP API (mounted in an app's own dev server,
 * so the app reaches it same-origin) that mirrors the puter.fs calls.
 *
 * Paths are Puter-style:
 *   /local/Documents/a.photo   absolute, under the local cloud
 *   ~/Documents/a.photo        home (= /local)
 *   photo-studio/x.json        relative: the app's own folder, /local/AppData/<app>/
 */
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

export const HOME = '/local';
const PLACES = ['Documents', 'Desktop', 'Pictures', 'Videos', 'Music', 'AppData'];

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.psd': 'image/vnd.adobe.photoshop',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};
export const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || null;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bool = (v, fallback) => (v == null ? fallback : v === '1' || v === 'true');

export function createLocalFs({ root, appId }) {
  root = path.resolve(root);
  for (const place of PLACES) mkdirSync(path.join(root, place), { recursive: true });
  mkdirSync(path.join(root, 'AppData', appId), { recursive: true });

  /** Puter path -> { real, virtual }; anything outside the local cloud is refused. */
  function resolve(input) {
    let p = String(input ?? '').replace(/\\/g, '/').trim();
    if (!p) throw new HttpError(400, 'invalid_path', 'No path given.');
    if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
    else if (!p.startsWith('/')) p = `${HOME}/AppData/${appId}/${p}`;
    if (p !== HOME && !p.startsWith(`${HOME}/`)) throw new HttpError(404, 'subject_does_not_exist', `${input} is not in the local cloud.`);
    const parts = p.slice(HOME.length).split('/').filter(Boolean);
    for (const part of parts) {
      if (part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)) {
        throw new HttpError(400, 'invalid_file_name', `"${part}" is not a valid file name on this computer.`);
      }
    }
    const real = path.resolve(root, ...parts);
    if (real !== root && !real.startsWith(root + path.sep)) throw new HttpError(400, 'invalid_path', 'Invalid path.');
    return { real, virtual: parts.length ? `${HOME}/${parts.join('/')}` : HOME };
  }

  async function item(real, virtual) {
    const st = await fsp.stat(real).catch(() => {
      throw new HttpError(404, 'subject_does_not_exist', `${virtual} does not exist.`);
    });
    const name = virtual === HOME ? 'local' : path.posix.basename(virtual);
    return {
      id: virtual,
      uid: virtual,
      name,
      path: virtual,
      is_dir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      created: Math.floor(st.birthtimeMs / 1000),
      modified: Math.floor(st.mtimeMs / 1000),
      accessed: Math.floor(st.atimeMs / 1000),
      type: st.isDirectory() ? null : mimeOf(name),
      immutable: false,
    };
  }

  const exists = (real) => fsp.stat(real).then(() => true, () => false);

  /** "name (1).ext", "name (2).ext", … next to an existing file. */
  async function dedupe(real, virtual) {
    const ext = path.extname(real);
    const base = real.slice(0, real.length - ext.length);
    const vbase = virtual.slice(0, virtual.length - ext.length);
    for (let i = 1; i < 10000; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!(await exists(candidate))) return { real: candidate, virtual: `${vbase} (${i})${ext}` };
    }
    throw new HttpError(409, 'item_with_same_name_exists', 'Too many files with that name.');
  }

  async function target(real, virtual, { overwrite, dedupeName }) {
    const st = await fsp.stat(real).catch(() => null);
    if (!st) return { real, virtual };
    if (dedupeName) return dedupe(real, virtual);
    if (st.isDirectory()) throw new HttpError(409, 'item_with_same_name_exists', `${virtual} is a folder.`);
    if (!overwrite) throw new HttpError(409, 'item_with_same_name_exists', `${virtual} already exists.`);
    return { real, virtual };
  }

  const ops = {
    async stat(q) {
      const { real, virtual } = resolve(q.path);
      return item(real, virtual);
    },

    async readdir(q) {
      const { real, virtual } = resolve(q.path);
      // Puter's readdir({ path, recursive, depth }): a flat list of everything below, to the given depth.
      const recursive = bool(q.recursive, false);
      const maxDepth = recursive ? Number(q.depth) || Infinity : 1;
      const items = [];
      async function walk(dirReal, dirVirtual, level) {
        const entries = await fsp.readdir(dirReal, { withFileTypes: true }).catch(() => {
          if (level === 1) throw new HttpError(404, 'subject_does_not_exist', `${virtual} is not a folder.`);
          return [];
        });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name.includes('.tmp-everything-')) continue;
          const childReal = path.join(dirReal, e.name);
          const childVirtual = dirVirtual === HOME ? `${HOME}/${e.name}` : `${dirVirtual}/${e.name}`;
          const it = await item(childReal, childVirtual).catch(() => null);
          if (!it) continue;
          items.push(it);
          if (it.is_dir && level < maxDepth) await walk(childReal, childVirtual, level + 1);
        }
      }
      await walk(real, virtual, 1);
      return items;
    },

    async write(q, req) {
      const resolved = resolve(q.path);
      await fsp.mkdir(path.dirname(resolved.real), { recursive: true }); // Puter's createMissingParents, always
      const { real, virtual } = await target(resolved.real, resolved.virtual, { overwrite: bool(q.overwrite, true), dedupeName: bool(q.dedupeName, false) });
      // Write beside the target, then swap in, so a failed save never leaves half a file.
      const temp = `${real}.tmp-everything-${randomBytes(4).toString('hex')}`;
      try {
        await pipeline(req, createWriteStream(temp));
        await fsp.rename(temp, real);
      } catch (e) {
        await fsp.rm(temp, { force: true });
        throw e;
      }
      return item(real, virtual);
    },

    async mkdir(q) {
      const resolved = resolve(q.path);
      const st = await fsp.stat(resolved.real).catch(() => null);
      if (st?.isDirectory() && !bool(q.dedupeName, false)) return item(resolved.real, resolved.virtual);
      const { real, virtual } = st ? await dedupe(resolved.real, resolved.virtual) : resolved;
      await fsp.mkdir(real, { recursive: true });
      return item(real, virtual);
    },

    async delete(q) {
      const { real, virtual } = resolve(q.path);
      if (virtual === HOME || PLACES.some((p) => virtual === `${HOME}/${p}`)) throw new HttpError(403, 'forbidden', `${virtual} can't be deleted.`);
      if (!(await exists(real))) throw new HttpError(404, 'subject_does_not_exist', `${virtual} does not exist.`);
      await fsp.rm(real, { recursive: bool(q.recursive, true), force: false });
      return { ok: true };
    },

    async move(q) {
      return transfer(q, 'move');
    },

    async copy(q) {
      return transfer(q, 'copy');
    },

    async rename(q) {
      const src = resolve(q.path);
      if (!q.newName || /[\\/]/.test(q.newName)) throw new HttpError(400, 'invalid_file_name', 'Invalid name.');
      const dest = resolve(`${path.posix.dirname(src.virtual)}/${q.newName}`);
      if (await exists(dest.real)) throw new HttpError(409, 'item_with_same_name_exists', `${dest.virtual} already exists.`);
      await fsp.rename(src.real, dest.real);
      return item(dest.real, dest.virtual);
    },
  };

  /** Puter semantics: a destination that is a folder receives the item under its own (or a new) name. */
  async function transfer(q, kind) {
    const src = resolve(q.source);
    let dest = resolve(q.destination);
    const destStat = await fsp.stat(dest.real).catch(() => null);
    if (destStat?.isDirectory()) dest = resolve(`${dest.virtual}/${q.newName || path.posix.basename(src.virtual)}`);
    if (dest.real === src.real) return item(src.real, src.virtual);
    if (dest.real.startsWith(src.real + path.sep)) throw new HttpError(400, 'invalid_path', 'A folder can’t go inside itself.');
    await fsp.mkdir(path.dirname(dest.real), { recursive: true });
    const { real, virtual } = await target(dest.real, dest.virtual, { overwrite: bool(q.overwrite, false), dedupeName: bool(q.dedupeName, false) });
    if (kind === 'move') {
      await fsp.rm(real, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(src.real, real);
    } else await fsp.cp(src.real, real, { recursive: true, force: true });
    return item(real, virtual);
  }

  async function read(q, res) {
    const { real, virtual } = resolve(q.path);
    const st = await fsp.stat(real).catch(() => null);
    if (!st || st.isDirectory()) throw new HttpError(404, 'subject_does_not_exist', `${virtual} is not a file.`);
    // Puter's ranged read: { offset, byte_count }
    const start = Math.max(0, Math.min(Number(q.offset) || 0, st.size));
    const count = q.byte_count != null ? Math.max(0, Number(q.byte_count) || 0) : st.size - start;
    const end = Math.min(st.size, start + count);
    res.writeHead(200, { 'Content-Type': mimeOf(real) || 'application/octet-stream', 'Content-Length': end - start, 'Cache-Control': 'no-store' });
    if (end > start) await pipeline(createReadStream(real, { start, end: end - 1 }), res);
    else res.end();
  }

  /** Connect-style handler for /__everything/fs/<op>?… */
  async function handle(req, res, op, query) {
    try {
      if (op === 'read') return await read(query, res);
      if (!Object.hasOwn(ops, op)) throw new HttpError(404, 'not_found', `Unknown operation ${op}.`);
      if (op !== 'stat' && op !== 'readdir' && req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
      const result = await ops[op](query, req);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (e) {
      if (res.headersSent) return res.destroy();
      const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EEXIST' || e.code === 'ENOTEMPTY' ? 409 : 500);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: e.status ? e.code : e.code || 'internal_error', message: e.message } }));
    }
  }

  return { root, handle, resolve };
}
