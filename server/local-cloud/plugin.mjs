/**
 * Vite plugin added to an app's own dev server by the launcher (the app's
 * repository is not touched). It
 *   - adds the local-cloud adapter (shim.js) to the page, ahead of everything else, and
 *   - serves the local-cloud file API at /__everything/fs/ on the app's own origin.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalFs, HOME } from './fs-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_URL = '/__everything/puter-local.js';

/** Requests must come from the app's own page: same host, same origin, and (for changes) our header. */
function allowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!(host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost'))) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  // A custom header forces a CORS preflight that is never granted, so other sites can't send changes.
  if (req.method !== 'GET' && req.headers['x-everything-local'] !== '1') return false;
  return true;
}

export function localCloudPlugin({ appId, appName, root, cloudPaths = [] }) {
  const store = createLocalFs({ root, appId });
  const config = {
    appId,
    appName,
    home: HOME,
    cloudPaths: cloudPaths.map((r) => [r.source, r.flags]),
  };

  function shimSource() {
    // Read on each request so edits to the adapter show up on reload.
    return `window.__EVERYTHING_LOCAL__ = ${JSON.stringify(config)};\n${readFileSync(path.join(HERE, 'shim.js'), 'utf8')}`;
  }

  return {
    name: 'everything-local-cloud',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__everything/')) return next();
        if (!allowed(req)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          return res.end('Forbidden');
        }
        const url = new URL(req.url, 'http://local');
        if (url.pathname === SHIM_URL) {
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(shimSource());
        }
        const m = url.pathname.match(/^\/__everything\/fs\/([a-z]+)$/);
        if (!m) return next();
        store.handle(req, res, m[1], Object.fromEntries(url.searchParams));
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // A plain (not deferred) script at the very top of <head>: it is in place before
        // the Puter SDK or the app run, whatever order they load in.
        const tag = `<script src="${SHIM_URL}"></script>`;
        return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${tag}`) : `${tag}\n${html}`;
      },
    },
  };
}
