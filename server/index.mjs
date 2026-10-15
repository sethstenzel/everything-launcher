#!/usr/bin/env node
/**
 * Everything launcher: a local dashboard for the apps in the Everything repo.
 *
 *   npm start                 browser dashboard at http://localhost:4000/
 *
 * Opening an app installs its dependencies on first use (npm ci), builds its
 * worker when its dev script does, starts its Vite dev server and then sends
 * the browser there. The launcher also watches the Everything repo for new
 * upstream commits and can update it.
 *
 * Everything listens on 127.0.0.1 only. Ports are fixed per app (and saved) so
 * each app keeps the same origin, and its browser storage, between launches.
 */
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import config from '../lib/config.cjs';
import { APP_PORT_BASE, APP_PORT_SPAN, loadCatalog, readJson } from './catalog.mjs';
import { createRepo } from './repo.mjs';
import * as shortcuts from './shortcuts.mjs';
import { localCloudSettings } from './local-cloud/apps.mjs';

const { ROOT, EVERYTHING_DIR, EVERYTHING_REMOTE, EVERYTHING_BACKUP, DATA_DIR, CLOUD_DIR, safeFileName } = config;
const VITE_RUNNER = path.join(ROOT, 'server', 'local-cloud', 'vite-runner.mjs');
const SRC = path.join(EVERYTHING_DIR, 'src');
const PUBLIC = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4000;
const START_TIMEOUT_MS = 3 * 60 * 1000;
const LOG_LINES = 400;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const PORTS_FILE = path.join(DATA_DIR, 'ports.json');

function writeData(file, value) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
}

// ---------------------------------------------------------------- catalog

let catalog = [];
let byId = new Map();
let catalogVersion = 0;

function reloadCatalog() {
  const savedPorts = readJson(PORTS_FILE) || {};
  catalog = loadCatalog(EVERYTHING_DIR, { savedPorts, reservedPorts: [PORT] });
  byId = new Map(catalog.map((a) => [a.id, a]));
  catalogVersion++;
  const ports = { ...savedPorts };
  for (const a of catalog) if (a.port) ports[a.id] = a.port;
  if (JSON.stringify(ports) !== JSON.stringify(savedPorts)) writeData(PORTS_FILE, ports);
}

reloadCatalog();

// ---------------------------------------------------------------- processes

/** id -> { state, url, port, error, log, child, stopping, stale } */
const runs = new Map();
const ACTIVE = new Set(['installing', 'building', 'starting', 'running']);

function appDir(id) {
  return path.join(SRC, id);
}

/** Installed when node_modules was written by npm after the lockfile last changed. */
function isInstalled(id) {
  const dir = appDir(id);
  const marker = path.join(dir, 'node_modules', '.package-lock.json');
  const lock = path.join(dir, 'package-lock.json');
  if (!existsSync(marker) || !existsSync(path.join(dir, 'node_modules', 'vite', 'package.json'))) return false;
  return !existsSync(lock) || statSync(marker).mtimeMs >= statSync(lock).mtimeMs;
}

function pushLog(run, chunk) {
  for (const line of String(chunk).replace(ANSI, '').split(/\r?\n/)) if (line.trim()) run.log.push(line);
  if (run.log.length > LOG_LINES) run.log.splice(0, run.log.length - LOG_LINES);
}

function childEnv() {
  return { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', BROWSER: 'none' };
}

/** npm as [command, args, options]; reuses the npm that started us when there is one. */
function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli) && existsSync(cli)) return [process.execPath, [cli, ...args], {}];
  return ['npm', args, { shell: process.platform === 'win32' }];
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.pid == null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

function step(run, [cmd, args, opts], label) {
  return new Promise((resolve, reject) => {
    pushLog(run, `> ${label}`);
    const child = spawn(cmd, args, { cwd: appDir(run.id), env: childEnv(), windowsHide: true, ...opts });
    run.child = child;
    child.stdout.on('data', (d) => pushLog(run, d));
    child.stderr.on('data', (d) => pushLog(run, d));
    child.on('error', reject);
    child.on('exit', (code) => {
      run.child = null;
      if (run.stopping) reject(new Error('Stopped'));
      else if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit code ${code})`));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, HOST);
    const done = (ok) => (sock.destroy(), resolve(ok));
    sock.setTimeout(400, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function pickPort(app) {
  // Just after a restart the old server may still be letting go of the port.
  for (let i = 0; i < 10; i++) {
    if (await portFree(app.port)) return app.port;
    await new Promise((r) => setTimeout(r, 300));
  }
  const used = new Set(catalog.map((a) => a.port));
  for (let p = APP_PORT_BASE + APP_PORT_SPAN; p < APP_PORT_BASE + APP_PORT_SPAN + 400; p++) {
    if (!used.has(p) && (await portFree(p))) return p;
  }
  throw new Error(`No free port for ${app.name}`);
}

function viteBin(id) {
  const pkgDir = path.join(appDir(id), 'node_modules', 'vite');
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  const bin = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.vite;
  if (!bin) throw new Error('Vite is not installed for this app');
  return path.join(pkgDir, bin);
}

/** Starts Vite on run.port and resolves with the URL it prints (or localhost once the port answers). */
function startVite(run) {
  return new Promise((resolve, reject) => {
    const bin = viteBin(run.id);
    const app = byId.get(run.id);
    // Apps with local files run through our runner: the app's own Vite and config, plus the local-cloud plugin.
    const local = localCloudSettings(run.id);
    const args = local ? [VITE_RUNNER] : [bin, '--port', String(run.port), '--strictPort', '--host', HOST];
    const env = local
      ? { ...childEnv(), EVERYTHING_APP_ID: run.id, EVERYTHING_APP_NAME: app?.name || run.id, EVERYTHING_PORT: String(run.port), EVERYTHING_HOST: HOST, EVERYTHING_CLOUD_DIR: CLOUD_DIR }
      : childEnv();
    pushLog(run, `> vite --port ${run.port} --strictPort --host ${HOST}${local ? `  (files saved on this computer in ${CLOUD_DIR})` : ''}`);
    const child = spawn(process.execPath, args, { cwd: appDir(run.id), env, windowsHide: true });
    run.child = child;
    let settled = false;
    let scan = '';
    let openSince = 0;
    const finish = (err, url) => {
      if (settled) return;
      settled = true;
      clearInterval(probe);
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(url);
    };
    const onData = (d) => {
      pushLog(run, d);
      scan = (scan + String(d).replace(ANSI, '')).slice(-4000);
      const m = scan.match(/Local:\s+(https?:\/\/\S+)/);
      if (m) finish(null, m[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => {
      run.child = null;
      if (!settled) return finish(new Error(run.stopping ? 'Stopped' : `Dev server exited (code ${code})`));
      if (run.stopping) run.state = 'stopped';
      else {
        run.state = 'error';
        run.error = `Dev server exited (code ${code})`;
        pushLog(run, run.error);
      }
      run.url = null;
    });
    const probe = setInterval(async () => {
      if (!(await portOpen(run.port))) return;
      openSince ||= Date.now();
      if (Date.now() - openSince > 4000) finish(null, `http://localhost:${run.port}/`);
    }, 500);
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for the dev server')), START_TIMEOUT_MS);
  });
}

/** Installs (when needed), builds and starts an app. `after` delays the start until a previous run has exited. */
function launch(app, after = null) {
  const existing = runs.get(app.id);
  if (existing && ACTIVE.has(existing.state)) return existing;
  const run = { id: app.id, state: 'starting', url: null, port: null, error: null, log: [], child: null, stopping: false, stale: false };
  runs.set(app.id, run);
  (async () => {
    try {
      if (after) await after;
      if (run.stopping) throw new Error('Stopped');
      if (!isInstalled(app.id)) {
        run.state = 'installing';
        const ci = existsSync(path.join(appDir(app.id), 'package-lock.json'));
        await step(run, npm([ci ? 'ci' : 'install', '--no-audit', '--no-fund']), `npm ${ci ? 'ci' : 'install'}`);
      }
      const scripts = readJson(path.join(appDir(app.id), 'package.json'))?.scripts || {};
      if (/\bbuild:worker\b/.test(scripts.dev || '') && scripts['build:worker']) {
        run.state = 'building';
        await step(run, npm(['run', 'build:worker']), 'npm run build:worker');
      }
      run.state = 'starting';
      run.port = await pickPort(app);
      if (run.port !== app.port) pushLog(run, `Port ${app.port} is busy; using ${run.port} instead.`);
      run.url = await startVite(run);
      run.state = 'running';
      pushLog(run, `Ready at ${run.url}`);
    } catch (e) {
      killTree(run.child);
      run.state = run.stopping ? 'stopped' : 'error';
      run.error = run.stopping ? null : e.message;
      if (!run.stopping) pushLog(run, e.message);
    }
  })();
  return run;
}

function stop(id) {
  const run = runs.get(id);
  if (!run || !ACTIVE.has(run.state)) return;
  run.stopping = true;
  killTree(run.child);
  if (!run.child) run.state = 'stopped';
}

/** Stops an app and starts it again on the same port (picking up updates and new dependencies). */
function restart(app) {
  const old = runs.get(app.id);
  let after = null;
  if (old && ACTIVE.has(old.state)) {
    old.stopping = true;
    if (old.child) {
      const exited = new Promise((r) => old.child.once('exit', r));
      after = Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    killTree(old.child);
  }
  runs.delete(app.id);
  return launch(app, after);
}

function status(app) {
  const run = runs.get(app.id);
  return {
    ...app,
    state: run?.state ?? 'stopped',
    url: run?.state === 'running' ? run.url : null,
    error: run?.error ?? null,
    stale: Boolean(run?.stale && ACTIVE.has(run.state)),
    installed: app.launchable && isInstalled(app.id),
    shortcuts: app.launchable ? shortcuts.status(app) : null,
    localFiles: Boolean(app.launchable && localCloudSettings(app.id)),
  };
}

// ---------------------------------------------------------------- the Everything repo

const repo = createRepo({
  dir: EVERYTHING_DIR,
  remote: EVERYTHING_REMOTE,
  backupDir: EVERYTHING_BACKUP,
  stateFile: path.join(DATA_DIR, 'repo.json'),
  onUpdated({ changed }) {
    reloadCatalog();
    shortcuts.rebuildStubs(); // .exe launchers for new or renamed apps
    // Running apps whose files changed keep serving until restarted; flag them so the dashboard can offer it.
    for (const run of runs.values()) {
      if (!ACTIVE.has(run.state)) continue;
      if (!changed || changed.some((f) => f.startsWith(`src/${run.id}/`) || f.startsWith('dev/'))) run.stale = true;
    }
  },
});

// ---------------------------------------------------------------- favorites

/** Favorite app ids in the order they were pinned; ids that are not launchable apps are dropped. */
const favoriteIds = (ids) => [...new Set(ids.filter((id) => typeof id === 'string' && byId.get(id)?.launchable))];

function readFavorites() {
  const ids = readJson(FAVORITES_FILE);
  // Keep the saved list while the repo is missing, so cloning it brings favorites back.
  if (!Array.isArray(ids)) return [];
  return catalog.length ? favoriteIds(ids) : [];
}

function writeFavorites(ids) {
  const clean = favoriteIds(ids);
  writeData(FAVORITES_FILE, clean);
  return clean;
}

// ---------------------------------------------------------------- http

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function sendFile(res, file) {
  if (!existsSync(file)) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('Body too large')), req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, body, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const ICON = path.join(ROOT, 'desktop', 'icon.png');

const server = http.createServer((req, res) => {
  // Only answer to our own name: blocks DNS-rebinding pages from driving the launcher.
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(res, 403, 'Forbidden');
  const { pathname } = new URL(req.url, `http://${host}`);
  let m;

  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'));
    if ((m = pathname.match(/^\/(app\.js|launch\.js|style\.css)$/))) return sendFile(res, path.join(PUBLIC, m[1]));
    if (pathname === '/favicon.png') return sendFile(res, ICON);
    if (pathname === '/logo.png') {
      const logo = path.join(EVERYTHING_DIR, 'assets', 'everything.png');
      return sendFile(res, existsSync(logo) ? logo : ICON);
    }
    if ((m = pathname.match(/^\/icons\/([a-z0-9-]+)\.png$/)) && byId.has(m[1])) return sendFile(res, path.join(SRC, m[1], 'icon-128.png'));
    if ((m = pathname.match(/^\/launch\/([a-z0-9-]+)\/?$/)) && byId.has(m[1])) return sendFile(res, path.join(PUBLIC, 'launch.html'));
    if (pathname === '/api/apps') {
      const { exists, path: repoPath, busy } = repo.snapshot();
      return json(res, {
        apps: catalog.map(status),
        favorites: readFavorites(),
        catalogVersion,
        repo: { exists, path: repoPath, busy },
        windows: shortcuts.supported,
      });
    }
    if ((m = pathname.match(/^\/api\/apps\/([a-z0-9-]+)$/)) && byId.has(m[1])) {
      return json(res, { ...status(byId.get(m[1])), log: runs.get(m[1])?.log.slice(-120) ?? [] });
    }
    if (pathname === '/api/repo') return json(res, { ...repo.snapshot(), running: [...runs.values()].filter((r) => ACTIVE.has(r.state)).length });
    if (pathname === '/api/repo/history') {
      repo.history().then((h) => json(res, h), (e) => json(res, { error: e.message }, 500));
      return;
    }
    return send(res, 404, 'Not found');
  }

  if (req.method === 'POST') {
    // A JSON content type forces a CORS preflight, which we never grant, so other sites cannot post here.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, 'Expected application/json');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== host) return send(res, 403, 'Forbidden');
  }

  if (req.method === 'POST' && pathname === '/api/favorites') {
    readBody(req)
      .then((body) => {
        const ids = JSON.parse(body)?.favorites;
        if (!Array.isArray(ids)) return json(res, { error: 'Expected { "favorites": [ids] }' }, 400);
        json(res, { favorites: writeFavorites(ids) });
      })
      .catch((e) => json(res, { error: e.message }, 400));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/repo/use') {
    readBody(req)
      .then((body) => {
        repo.useVersion(JSON.parse(body || '{}').commit);
        json(res, repo.snapshot());
      })
      .catch((e) => json(res, { error: e.message }, 400));
    return;
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/repo\/(check|pull|clone)$/))) {
    req.resume();
    repo[m[1]]();
    return json(res, repo.snapshot());
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/apps\/([a-z0-9-]+)\/files$/)) && byId.get(m[1])?.launchable) {
    // The app's folder in the local cloud (where its pickers start), opened in the file manager.
    req.resume();
    const folder = path.join(CLOUD_DIR, 'Documents', safeFileName(byId.get(m[1]).name));
    mkdirSync(folder, { recursive: true });
    const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [folder]] : process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return json(res, { ok: true, folder });
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/apps\/([a-z0-9-]+)\/(shortcut|reveal)$/)) && byId.get(m[1])?.launchable) {
    const app = byId.get(m[1]);
    const action =
      m[2] === 'reveal'
        ? shortcuts.reveal(app).then(() => ({ ok: true }))
        : readBody(req).then((body) => {
            const { where, action: verb } = JSON.parse(body || '{}');
            if (!['desktop', 'start'].includes(where) || !['add', 'remove'].includes(verb)) throw new Error('Expected { "where": "desktop"|"start", "action": "add"|"remove" }');
            return verb === 'add' ? shortcuts.add(app, where) : shortcuts.remove(app, where);
          });
    if (m[2] === 'reveal') req.resume();
    action.then((result) => json(res, { ok: true, shortcuts: shortcuts.status(app), result }), (e) => json(res, { error: e.message }, 400));
    return;
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/apps\/([a-z0-9-]+)\/(launch|stop|restart)$/)) && byId.has(m[1])) {
    const app = byId.get(m[1]);
    req.resume();
    if (m[2] === 'stop') stop(app.id);
    else if (!app.launchable) return json(res, { error: `${app.name} has no code in the Everything repo yet.` }, 409);
    else if (m[2] === 'launch') launch(app);
    else restart(app);
    return json(res, status(app));
  }

  send(res, 404, 'Not found');
});

function shutdown() {
  for (const run of runs.values()) {
    run.stopping = true;
    killTree(run.child);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Set PORT=<number> to use another.` : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  const ready = catalog.filter((a) => a.launchable).length;
  console.log(`Everything launcher: ${url}`);
  console.log(`  Everything repo: ${EVERYTHING_DIR}${catalog.length ? ` (${ready} apps)` : ' (not found: the dashboard can clone it)'}`);
  console.log('  Ctrl+C stops the launcher and every app it started.');
  if (catalog.length) shortcuts.buildMissingStubs();
  if (process.argv.includes('--no-open') || process.env.CI) return;
  const opener = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});
