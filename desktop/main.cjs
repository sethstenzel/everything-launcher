/**
 * Everything desktop: the launcher dashboard in its own window, and every app
 * it opens in a native window of its own (own icon, own taskbar button).
 *
 *   npm run desktop          start it
 *   npm run shortcuts        add "Everything" shortcuts (this folder, Desktop, Start menu)
 *
 * The launcher server (../server/index.mjs) runs under the system Node, hidden, since
 * it installs apps with npm and runs their Vite dev servers. Windows hold
 * nothing but web pages: no Node integration, sandboxed, context-isolated.
 */
const { app, BrowserWindow, dialog, nativeImage, nativeTheme, screen, session, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { ROOT, EVERYTHING_DIR, DATA_DIR, stubPath } = require('../lib/config.cjs');
const { writeIco, buildStubs } = require('./stubs.cjs');
const SERVER = path.join(ROOT, 'server', 'index.mjs');
const ICON = path.join(__dirname, 'icon.png');
const APP_ID = 'Everything.Launcher';
const FIRST_PORT = 4000;

app.setName('Everything');
app.setPath('userData', DATA_DIR);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let base = null; // http://127.0.0.1:<port>/
let server = null; // the launcher process, when we started it
let quitting = false;
let dashboard = null;
const appWindows = new Map(); // app id -> BrowserWindow

// ---------------------------------------------------------------- window state

const STATE_FILE = path.join(app.getPath('userData'), 'windows.json');
let windowState = {};
try {
  windowState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  /* first run */
}

function restoreBounds(key, win) {
  const saved = windowState[key];
  if (!saved?.bounds) return false;
  const b = saved.bounds;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
  if (onScreen) win.setBounds(b);
  return Boolean(saved.maximized);
}

function trackBounds(key, win) {
  win.on('close', () => {
    windowState[key] = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(windowState, null, 1));
    } catch {
      /* not worth failing a close over */
    }
  });
}

// ---------------------------------------------------------------- launcher server

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isLauncher(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/apps`, { signal: AbortSignal.timeout(1000) });
    return res.ok && Array.isArray((await res.json()).apps);
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Reuses a launcher already running (e.g. from `npm start`), or starts one. */
async function startServer() {
  if (await isLauncher(FIRST_PORT)) return FIRST_PORT;
  let port = FIRST_PORT;
  while (!(await portFree(port))) if (++port > FIRST_PORT + 100) throw new Error('No free port for the launcher.');

  const logFile = path.join(app.getPath('userData'), 'launcher.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'w');
  const env = { ...process.env, PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', [SERVER, '--no-open'], { cwd: ROOT, env, stdio: ['ignore', log, log], windowsHide: true });

  let failure = null;
  server.once('error', (e) => (failure = e.code === 'ENOENT' ? new Error('Node.js was not found. Install it from https://nodejs.org/ and try again.') : e));
  server.once('exit', (code) => {
    failure ||= new Error(`The launcher stopped (exit code ${code}). See ${logFile}`);
    server = null;
    // We end it ourselves on quit (taskkill reports exit code 1); only an unexpected exit is an error.
    if (base && !quitting) {
      dialog.showErrorBox('Everything', failure.message);
      app.quit();
    }
  });
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure;
    if (await isLauncher(port)) return port;
    await sleep(150);
  }
  throw new Error(`The launcher did not start. See ${logFile}`);
}

function stopServer() {
  quitting = true;
  if (!server || server.exitCode !== null) return;
  try {
    // /T takes the app dev servers it started down with it.
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

function postStop(id) {
  fetch(`${base}api/apps/${id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}

// ---------------------------------------------------------------- windows

const background = () => (nativeTheme.shouldUseDarkColors ? '#111418' : '#f6f7f9');

/** Local servers and Puter itself stay in the app; everything else goes to the default browser. */
function isInternal(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'blob:' || protocol === 'about:') return true;
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname.endsWith('.localhost') || /(^|\.)puter\.(com|site|work)$/.test(hostname);
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

function webPreferences() {
  return { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true };
}

function showWhenReady(win, maximized) {
  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    win.show();
  });
}

function guardNavigation(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (url === base || url === `${base}index.html`) {
      // "Back to all apps" from an app window: bring the dashboard forward instead.
      event.preventDefault();
      showDashboard();
    } else if (!isInternal(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 360,
    title: 'Everything',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: background(),
    webPreferences: webPreferences(),
  });
  showWhenReady(dashboard, restoreBounds('dashboard', dashboard));
  trackBounds('dashboard', dashboard);
  dashboard.webContents.setWindowOpenHandler(({ url }) => {
    const m = url.startsWith(base) && new URL(url).pathname.match(/^\/launch\/([a-z0-9-]+)\/?$/);
    if (m) openApp(m[1]);
    else openExternal(url);
    return { action: 'deny' };
  });
  guardNavigation(dashboard);
  dashboard.on('closed', () => (dashboard = null));
  dashboard.loadURL(base);
}

function showDashboard() {
  if (!dashboard) return createDashboard();
  if (dashboard.isMinimized()) dashboard.restore();
  dashboard.focus();
}

async function openApp(id) {
  const open = appWindows.get(id);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  let name = id;
  try {
    const res = await fetch(`${base}api/apps/${id}`);
    if (res.status === 404) return showDashboard(); // no such app (e.g. a stub for one removed upstream)
    name = (await res.json()).name || id;
  } catch {
    /* the launch page will report it */
  }
  const iconFile = path.join(EVERYTHING_DIR, 'src', id, 'icon-128.png');
  const icon = fs.existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : ICON;
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 360,
    minHeight: 300,
    title: name,
    icon,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: background(),
    webPreferences: webPreferences(),
  });
  if (process.platform === 'win32') {
    // Its own taskbar button and icon instead of grouping under the launcher. With a stub built,
    // "Pin to taskbar" on that button pins the app's .exe, so the pin opens this app directly.
    const stub = stubPath(name);
    win.setAppDetails(
      fs.existsSync(stub)
        ? { appId: `Everything.${id}`, relaunchCommand: `"${stub}"`, relaunchDisplayName: name, appIconPath: stub, appIconIndex: 0 }
        : { appId: `Everything.${id}` },
    );
  }
  appWindows.set(id, win);
  showWhenReady(win, restoreBounds(`app:${id}`, win));
  trackBounds(`app:${id}`, win);
  guardNavigation(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Puter's sign-in popup needs to stay a real child window (it reports back through window.opener).
    if (isInternal(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { icon, autoHideMenuBar: true, webPreferences: webPreferences() } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    appWindows.delete(id);
    postStop(id);
  });
  win.loadURL(`${base}launch/${id}`);
}

/** Closes an app's window when its dev server is stopped from the dashboard (its Stop, or Close all apps). */
function watchStoppedApps() {
  const ACTIVE = new Set(['installing', 'building', 'starting', 'running']);
  const seenRunning = new Set(); // windows whose app has been started, so "stopped" means stopped since
  setInterval(async () => {
    if (!appWindows.size) return;
    try {
      const { apps } = await (await fetch(`${base}api/apps`)).json();
      for (const a of apps) {
        const win = appWindows.get(a.id);
        if (!win) {
          seenRunning.delete(a.id);
          continue;
        }
        if (ACTIVE.has(a.state)) seenRunning.add(a.id);
        else if (a.state === 'stopped' && seenRunning.has(a.id)) {
          seenRunning.delete(a.id);
          win.close();
        }
      }
    } catch {
      /* launcher restarting or gone; its exit handler reports that */
    }
  }, 2000);
}

// ---------------------------------------------------------------- shortcuts

function createShortcuts() {
  if (process.platform !== 'win32') {
    console.log('Shortcuts are only created on Windows. Use `npm run desktop` elsewhere.');
    return;
  }
  const ico = path.join(app.getPath('userData'), 'everything.ico');
  writeIco(ICON, ico);
  const options = {
    target: process.execPath,
    args: `"${ROOT}"`,
    cwd: ROOT,
    description: 'Launch the Everything apps',
    icon: ico,
    iconIndex: 0,
    appUserModelId: APP_ID,
  };
  const places = [
    path.join(ROOT, 'Everything.lnk'),
    path.join(app.getPath('desktop'), 'Everything.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Everything.lnk'),
  ];
  for (const link of places) {
    const ok = shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', options);
    console.log(`${ok ? 'Created' : 'Could not create'} ${link}`);
  }
}

// ---------------------------------------------------------------- lifecycle

if (process.argv.includes('--create-shortcuts')) {
  app.whenReady().then(() => {
    createShortcuts();
    app.quit();
  });
} else if (process.argv.includes('--build-stubs')) {
  app.whenReady()
    .then(() => buildStubs({ only: process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? null, missing: process.argv.includes('--missing') }))
    .then(
      () => app.quit(),
      (e) => {
        console.error(e.message);
        app.exit(1);
      },
    );
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // `--open=<app id>` opens that app straight away (also when Everything is already running).
  const requestedApp = (argv) => {
    const id = argv.find((a) => a.startsWith('--open='))?.slice(7).toLowerCase();
    return id && /^[a-z0-9-]+$/.test(id) ? id : null;
  };
  // Requests from other launches (stubs, shortcuts) that arrive while the launcher is still starting.
  const pending = [];
  const handle = (id) => (id ? openApp(id) : showDashboard());
  app.on('second-instance', (_event, argv) => {
    const id = requestedApp(argv);
    if (base) handle(id);
    else pending.push(id);
  });

  app.whenReady().then(async () => {
    // Camera, microphone, notifications and the like: granted to the local apps and Puter, nobody else.
    session.defaultSession.setPermissionRequestHandler((wc, _permission, callback, details) => callback(isInternal(details.requestingUrl || wc.getURL())));
    try {
      base = `http://127.0.0.1:${await startServer()}/`;
    } catch (e) {
      dialog.showErrorBox('Everything', e.message);
      app.quit();
      return;
    }
    watchStoppedApps();
    // Started for one app (its .exe stub or --open=<app>): open just that app; "Back to all apps" brings up the dashboard.
    const id = requestedApp(process.argv);
    if (id) openApp(id);
    else createDashboard();
    for (const queued of pending.splice(0)) handle(queued);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => (quitting = true));
  app.on('will-quit', stopServer);
}
