/**
 * Everything local-cloud adapter. Served by the launcher and loaded first on
 * the app's page; the app itself is unchanged.
 *
 * It replaces puter.fs and Puter's file pickers (ui.showOpenFilePicker,
 * showSaveFilePicker, showDirectoryPicker) with versions that use the local
 * cloud folder on this computer through /__everything/fs/. Sign-in, AI, KV,
 * workers and everything else stay Puter's own, as do the paths an app lists
 * in cloudPaths (e.g. files a Puter worker must read).
 */
(() => {
  'use strict';
  if (window.__everythingLocalCloud) return;

  const cfg = window.__EVERYTHING_LOCAL__ || {};
  const HOME = cfg.home || '/local';
  const APP = cfg.appId || 'app';
  const cloudRules = (cfg.cloudPaths || []).map(([source, flags]) => new RegExp(source, flags));
  const PATCHED = Symbol.for('everything.localCloud.patched');
  const PLACES = ['Documents', 'Desktop', 'Pictures', 'Videos', 'Music'];
  // The app's own folder, where its pickers start (like an app's folder in Puter's cloud).
  const APP_NAME = (cfg.appName || APP).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '') || APP;
  const APP_FOLDER = `${HOME}/Documents/${APP_NAME}`;

  // ------------------------------------------------------------------ file API

  class LocalCloudError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'LocalCloudError';
      this.code = code;
      this.error = { code, message }; // the shape Puter's errors have
    }
  }

  const headers = { 'X-Everything-Local': '1' };

  async function call(op, params, body) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.set(k, String(v));
    const get = op === 'stat' || op === 'readdir';
    const res = await fetch(`/__everything/fs/${op}?${query}`, { method: get ? 'GET' : 'POST', headers, body: get ? undefined : (body ?? '') });
    if (!res.ok) throw await failure(res, op);
    return res.json();
  }

  async function failure(res, op) {
    let error = {};
    try {
      error = (await res.json()).error || {};
    } catch {
      /* not JSON */
    }
    return new LocalCloudError(error.code || 'error', error.message || `${op} failed (${res.status})`);
  }

  function pathOf(arg) {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg.path === 'string') return arg.path;
    throw new LocalCloudError('invalid_path', 'A path is required.');
  }

  function toBlob(data) {
    if (data instanceof Blob) return data;
    if (data == null) return new Blob([]);
    if (typeof data === 'string') return new Blob([data], { type: 'text/plain' });
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
    return new Blob([JSON.stringify(data)], { type: 'application/json' });
  }

  /** Puter FS items have a read() helper; so do ours. */
  function wrap(item) {
    if (!item || typeof item !== 'object') return item;
    return Object.assign(item, {
      read: () => local.read(item.path),
      isDir: item.is_dir,
      localCloud: true,
    });
  }

  const local = {
    async write(target, data, options = {}) {
      if (target instanceof File && data === undefined) [target, data] = [target.name, target]; // write(file)
      const item = wrap(await call('write', { path: pathOf(target), overwrite: options.overwrite, dedupeName: options.dedupeName }, toBlob(data)));
      noteSaved(item);
      return item;
    },
    async read(target) {
      const res = await fetch(`/__everything/fs/read?path=${encodeURIComponent(pathOf(target))}`, { headers });
      if (!res.ok) throw await failure(res, 'read');
      return res.blob();
    },
    stat: async (target) => wrap(await call('stat', { path: pathOf(target) })),
    readdir: async (target) => (await call('readdir', { path: pathOf(target ?? '~') })).map(wrap),
    mkdir: async (target, options = {}) => wrap(await call('mkdir', { path: pathOf(target), dedupeName: options.dedupeName })),
    async delete(targets, options = {}) {
      for (const target of [].concat(targets)) await call('delete', { path: pathOf(target), recursive: options.recursive });
    },
    move: async (source, destination, options = {}) =>
      wrap(await call('move', { source: pathOf(source), destination: pathOf(destination), overwrite: options.overwrite, newName: options.newName, dedupeName: options.dedupeName })),
    copy: async (source, destination, options = {}) =>
      wrap(await call('copy', { source: pathOf(source), destination: pathOf(destination), overwrite: options.overwrite, newName: options.newName, dedupeName: options.dedupeName })),
    rename: async (target, newName) => wrap(await call('rename', { path: pathOf(target), newName })),
    getReadURL: async (target) => new URL(`/__everything/fs/read?path=${encodeURIComponent(pathOf(target))}`, location.href).href,
    async upload(items, dir = '~/Desktop', options = {}) {
      const files = items instanceof FileList ? [...items] : [].concat(items);
      const out = [];
      for (const file of files) {
        out.push(await local.write(`${pathOf(dir).replace(/\/+$/, '')}/${file.name}`, file, { overwrite: options.overwrite, dedupeName: options.dedupeName ?? !options.overwrite }));
      }
      return out.length === 1 ? out[0] : out;
    },
    space: async () => ({ capacity: 0, used: 0 }),
  };

  const isCloudPath = (p) => typeof p === 'string' && cloudRules.some((r) => r.test(p));

  // ------------------------------------------------------------------ patching window.puter

  /** puter.fs for the app: local, except cloudPaths, which go to Puter's real fs. */
  function wrapFs(real) {
    const wrapper = Object.create(real); // anything we don't handle falls through to Puter's
    for (const name of Object.keys(local)) {
      const original = typeof real[name] === 'function' ? real[name].bind(real) : null;
      wrapper[name] = (...args) => {
        const toCloud = original && (isCloudPath(args[0]) || ((name === 'move' || name === 'copy') && isCloudPath(args[1])));
        return toCloud ? original(...args) : local[name](...args);
      };
    }
    return wrapper;
  }

  function patch(puter) {
    if (!puter || typeof puter !== 'object' || puter[PATCHED]) return puter;
    try {
      Object.defineProperty(puter, PATCHED, { value: true });
    } catch {
      return puter; // frozen: leave it alone
    }
    // The app gets a wrapper; Puter's own fs object stays untouched, so the SDK's internal calls
    // (fs.write uses fs.upload, for one) still reach Puter for the paths that must go there.
    let real = puter.fs || {};
    let wrapped = wrapFs(real);
    Object.defineProperty(puter, 'fs', {
      configurable: true,
      enumerable: true,
      get: () => wrapped,
      set: (value) => {
        real = value || {};
        wrapped = wrapFs(real);
      },
    });
    const ui = puter.ui || (puter.ui = {});
    ui.showOpenFilePicker = (options = {}) => picker('open', options);
    ui.showSaveFilePicker = (content, suggestedName, options = {}) => picker('save', { ...options, content, suggestedName });
    ui.showDirectoryPicker = (options = {}) => picker('dir', options);
    puter.localCloud = { home: HOME, app: APP, root: `${HOME}/AppData/${APP}` };
    return puter;
  }

  let current = window.puter;
  if (current) patch(current);
  try {
    // Patch the SDK's object the moment it is assigned, whatever order the scripts load in.
    Object.defineProperty(window, 'puter', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = patch(value);
      },
    });
  } catch {
    /* already defined as non-configurable: fall back to the checks below */
  }
  const late = () => window.puter && patch(window.puter);
  document.addEventListener('DOMContentLoaded', late);
  window.addEventListener('load', () => {
    late();
    if (!window.puter) installOffline();
  });

  /** When Puter's SDK can't load (offline), files still work; Puter features report why they don't. */
  function installOffline() {
    const offline = () => Promise.reject(new Error('Puter can’t be reached right now. Files still save on this computer.'));
    current = patch({
      env: 'web',
      auth: { isSignedIn: () => false, signIn: offline, signOut() {}, getUser: offline },
      ai: new Proxy({}, { get: () => offline }),
      kv: { get: async () => null, set: offline, del: offline, list: async () => [] },
      fs: {},
      ui: {},
    });
  }

  // ------------------------------------------------------------------ "saved" notice

  let noticeTimer = 0;
  function noteSaved(item) {
    if (!item?.path || item.path.startsWith(`${HOME}/AppData/`)) return; // app data syncs quietly
    const where = item.path.slice(HOME.length + 1);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice(`Saved on this computer: ${where}`), 50);
  }

  function notice(text) {
    let el = document.getElementById('everything-local-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'everything-local-notice';
      el.setAttribute('role', 'status');
      el.style.cssText =
        'position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));padding:9px 14px;border-radius:10px;background:#1f2937;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgb(0 0 0/.35);pointer-events:none;opacity:0;transition:opacity .2s';
      document.documentElement.append(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._hide);
    el._hide = setTimeout(() => (el.style.opacity = '0'), 3500);
  }

  // ------------------------------------------------------------------ file dialog

  const ICON = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6.5 3h7l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3zM13 3.5V8h4.5"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5"/></svg>',
    app: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9 12h6M12 9v6"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 16px;
      background: rgb(0 0 0 / .45); font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
      --bg: #ffffff; --panel: #f4f5f7; --line: #e1e4e8; --text: #1b1f24; --muted: #5d6673; --accent: #2f6fed; --sel: #e3ecfd; --bad: #c53030; }
    @media (prefers-color-scheme: dark) { .backdrop { --bg: #1d2127; --panel: #16191e; --line: #2c323b; --text: #e8ebef; --muted: #9aa4b1; --accent: #6c9bff; --sel: #243553; --bad: #f26b6b; } }
    .dialog { display: flex; flex-direction: column; width: min(860px, 100%); height: min(580px, 100%); background: var(--bg); color: var(--text);
      border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 20px 60px rgb(0 0 0 / .35); overflow: hidden; }
    header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 16px; }
    .where { color: var(--muted); font-size: 12px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; }
    .x { margin-left: auto; }
    .body { flex: 1; display: flex; min-height: 0; }
    nav { width: 170px; flex: none; padding: 10px 8px; background: var(--panel); border-right: 1px solid var(--line); overflow: auto; }
    nav button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border-radius: 7px; text-align: left; }
    nav button[aria-current='true'] { background: var(--sel); color: var(--accent); font-weight: 600; }
    main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .bar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
    .crumbs { flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-width: 0; font-size: 13px; }
    .crumbs button { padding: 3px 6px; border-radius: 5px; }
    .crumbs span { color: var(--muted); }
    .list { flex: 1; overflow: auto; padding: 4px 6px; outline: none; }
    .row { display: grid; grid-template-columns: 22px 1fr 150px 80px; align-items: center; gap: 10px; width: 100%; padding: 6px 8px;
      border-radius: 6px; text-align: left; user-select: none; }
    .row:hover { background: var(--panel); }
    .row[aria-selected='true'] { background: var(--sel); }
    .row .meta { color: var(--muted); font-size: 12px; text-align: right; white-space: nowrap; }
    .row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row.dim { opacity: .45; }
    .row input { width: 100%; padding: 4px 6px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--accent); border-radius: 5px; }
    .empty { padding: 40px 12px; text-align: center; color: var(--muted); }
    svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; flex: none; }
    .row svg { color: var(--muted); }
    .row.dir svg { color: var(--accent); }
    footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); }
    footer label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    footer .name { flex: 1; min-width: 200px; }
    footer .name input { flex: 1; padding: 7px 10px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; }
    footer .name input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
    .error { width: 100%; color: var(--bad); font-size: 13px; }
    .error:empty { display: none; }
    .spacer { flex: 1; }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    button:focus-visible, .list:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .btn { padding: 7px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
    .btn:hover { border-color: var(--muted); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .btn:disabled { opacity: .5; cursor: default; }
    .small { padding: 4px 10px; font-size: 12px; }
    @media (max-width: 620px) { nav { display: none; } .row { grid-template-columns: 22px 1fr 70px; } .row .when { display: none; } }
  `;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);
  const whenText = (s) => (s ? new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const parentOf = (p) => (p === HOME ? HOME : p.slice(0, p.lastIndexOf('/')) || HOME);
  const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|[. ]$/;

  function acceptTest(accept) {
    const list = []
      .concat(accept || [])
      .flatMap((a) => String(a).split(','))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!list.length || list.includes('*') || list.includes('*/*')) return null;
    return (item) => {
      const name = item.name.toLowerCase();
      const type = (item.type || '').toLowerCase();
      return list.some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a));
    };
  }

  /** Resolves with the chosen item(s). Like Puter's pickers, it never settles when cancelled. */
  function picker(mode, options) {
    return new Promise((resolve) => openDialog(mode, options, resolve));
  }

  function openDialog(mode, options, resolve) {
    const multiple = Boolean(options.multiple);
    const matches = mode === 'open' ? acceptTest(options.accept) : null;
    const memoryKey = `everything-local-dir:${APP}:${mode}`;
    const title = mode === 'save' ? 'Save as' : mode === 'dir' ? 'Choose a folder' : multiple ? 'Open files' : 'Open';
    const okLabel = mode === 'save' ? 'Save' : mode === 'dir' ? 'Select folder' : 'Open';

    const host = document.createElement('everything-file-dialog');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="t">
          <header>
            <h2 id="t">${esc(title)}</h2>
            <span class="where" title="Files are kept in the everything-launcher's local cloud folder">On this computer</span>
            <button class="x btn small" type="button" aria-label="Close">Cancel</button>
          </header>
          <div class="body">
            <nav aria-label="Places"></nav>
            <main>
              <div class="bar">
                <div class="crumbs" aria-label="Folder"></div>
                <button class="btn small newfolder" type="button">New folder</button>
                ${mode === 'open' ? '<button class="btn small import" type="button">Import from computer…</button>' : ''}
              </div>
              <div class="list" role="listbox" tabindex="0" aria-label="Files" ${multiple ? 'aria-multiselectable="true"' : ''}></div>
            </main>
          </div>
          <footer>
            ${mode === 'save' ? '<label class="name">File name <input type="text" spellcheck="false" autocomplete="off"></label>' : ''}
            ${mode === 'open' && matches ? '<label><input type="checkbox" class="all"> Show all files</label>' : ''}
            <span class="spacer"></span>
            <button class="btn cancel" type="button">Cancel</button>
            <button class="btn primary ok" type="button">${esc(okLabel)}</button>
            <div class="error" role="alert"></div>
          </footer>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const list = $('.list');
    const nameInput = $('.name input');
    const errorEl = $('.error');
    const okBtn = $('.ok');
    let dir = APP_FOLDER;
    try {
      dir = localStorage.getItem(memoryKey) || dir;
    } catch {
      /* storage blocked */
    }
    let entries = [];
    let shown = [];
    let selected = new Set();
    let anchor = -1;
    let showAll = false;
    let busy = false;
    const previousFocus = document.activeElement;

    if (nameInput) nameInput.value = options.suggestedName || 'Untitled';

    function close() {
      host.remove();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }
    function finish(value) {
      try {
        localStorage.setItem(memoryKey, dir);
      } catch {
        /* storage blocked */
      }
      close();
      resolve(value);
    }
    const fail = (e) => {
      errorEl.textContent = e?.message || String(e);
      busy = false;
      okBtn.disabled = false;
    };

    function renderPlaces() {
      const nav = $('nav');
      nav.innerHTML = '';
      const places = [[APP_NAME, APP_FOLDER, ICON.app], ...PLACES.map((n) => [n, `${HOME}/${n}`, n === 'Pictures' ? ICON.image : ICON.folder]), ['All files', HOME, ICON.home]];
      for (const [label, p, icon] of places) {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `${icon}<span>${esc(label)}</span>`;
        const best = places.filter(([, q]) => q !== HOME && (dir === q || dir.startsWith(q + '/'))).sort((a, b) => b[1].length - a[1].length)[0];
        b.setAttribute('aria-current', String(best ? best[1] === p : p === HOME));
        b.addEventListener('click', () => go(p));
        nav.append(b);
      }
    }

    function renderCrumbs() {
      const crumbs = $('.crumbs');
      crumbs.innerHTML = '';
      const parts = dir.slice(HOME.length).split('/').filter(Boolean);
      const steps = [['This computer', HOME], ...parts.map((part, i) => [part, `${HOME}/${parts.slice(0, i + 1).join('/')}`])];
      steps.forEach(([label, p], i) => {
        if (i) crumbs.append(Object.assign(document.createElement('span'), { textContent: '›' }));
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => go(p));
        crumbs.append(b);
      });
    }

    function visible(item) {
      if (item.is_dir) return true;
      if (mode === 'dir') return false;
      return !matches || showAll || matches(item);
    }

    function renderList() {
      shown = entries.filter(visible);
      list.innerHTML = '';
      if (!shown.length) {
        list.innerHTML = `<div class="empty">${mode === 'open' ? 'No matching files here. Use “Import from computer…” to bring files in.' : 'This folder is empty.'}</div>`;
      }
      shown.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = `row${item.is_dir ? ' dir' : ''}${mode === 'save' && !item.is_dir ? ' dim' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(selected.has(item.path)));
        row.dataset.index = i;
        row.innerHTML = `${item.is_dir ? ICON.folder : /^image\//.test(item.type || '') ? ICON.image : ICON.file}
          <span class="label">${esc(item.name)}</span><span class="meta when">${esc(whenText(item.modified))}</span><span class="meta">${item.is_dir ? '' : esc(sizeText(item.size))}</span>`;
        row.addEventListener('click', (e) => select(i, e));
        row.addEventListener('dblclick', () => activate(item));
        list.append(row);
      });
      updateOk();
    }

    function updateOk() {
      if (mode === 'open') okBtn.disabled = !selected.size;
    }

    async function go(p) {
      errorEl.textContent = '';
      try {
        entries = (await local.readdir(p)).sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
        dir = p;
      } catch (e) {
        if (p === APP_FOLDER) {
          // First use: create the app's folder.
          try {
            await local.mkdir(APP_FOLDER);
            return go(APP_FOLDER);
          } catch {
            /* fall through */
          }
        }
        if (p !== HOME + '/Documents') return go(HOME + '/Documents');
        entries = [];
        fail(e);
      }
      selected = new Set();
      anchor = -1;
      renderPlaces();
      renderCrumbs();
      renderList();
    }

    function select(i, e = {}) {
      const item = shown[i];
      if (!item) return;
      if (multiple && (e.ctrlKey || e.metaKey)) selected.has(item.path) ? selected.delete(item.path) : selected.add(item.path);
      else if (multiple && e.shiftKey && anchor >= 0) {
        selected = new Set(shown.slice(Math.min(anchor, i), Math.max(anchor, i) + 1).map((x) => x.path));
      } else selected = new Set([item.path]);
      if (!e.shiftKey) anchor = i;
      if (mode === 'save' && !item.is_dir) nameInput.value = item.name;
      for (const row of list.querySelectorAll('.row')) row.setAttribute('aria-selected', String(selected.has(shown[row.dataset.index].path)));
      list.querySelector(`.row[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
      updateOk();
    }

    function activate(item) {
      if (item.is_dir) return go(item.path);
      if (mode === 'open') {
        selected = new Set([item.path]);
        ok();
      } else if (mode === 'save') {
        nameInput.value = item.name;
        ok();
      }
    }

    async function ok() {
      if (busy) return;
      errorEl.textContent = '';
      const picked = shown.filter((x) => selected.has(x.path));
      try {
        if (mode === 'open') {
          if (picked.length === 1 && picked[0].is_dir) return go(picked[0].path);
          const files = picked.filter((x) => !x.is_dir);
          if (!files.length) return;
          return finish(multiple ? files : files[0]);
        }
        if (mode === 'dir') {
          const folders = picked.filter((x) => x.is_dir);
          const chosen = folders.length ? folders : [await local.stat(dir)];
          return finish(multiple ? chosen : chosen[0]);
        }
        // save
        const name = nameInput.value.trim();
        if (!name) return fail(new Error('Enter a file name.'));
        if (BAD_NAME.test(name)) return fail(new Error('File names can’t contain < > : " / \\ | ? * or end with a dot or space.'));
        const existing = entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (existing?.is_dir) return go(existing.path);
        if (existing && !confirm(`${existing.name} already exists. Replace it?`)) return;
        busy = true;
        okBtn.disabled = true;
        const item = await local.write(`${dir}/${name}`, options.content, { overwrite: true });
        finish(item);
      } catch (e) {
        fail(e);
      }
    }

    // New folder: an inline name field at the top of the list.
    $('.newfolder').addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'row dir';
      row.innerHTML = `${ICON.folder}<input type="text" value="New folder" aria-label="New folder name" spellcheck="false"><span></span><span></span>`;
      list.prepend(row);
      list.querySelector('.empty')?.remove();
      const input = row.querySelector('input');
      input.select();
      input.focus();
      let done = false;
      const create = async () => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (!name) return renderList();
        if (BAD_NAME.test(name)) {
          fail(new Error('Folder names can’t contain < > : " / \\ | ? * or end with a dot or space.'));
          return renderList();
        }
        try {
          const folder = await local.mkdir(`${dir}/${name}`, { dedupeName: true });
          await go(dir);
          const i = shown.findIndex((x) => x.path === folder.path);
          if (i >= 0) select(i);
        } catch (e) {
          fail(e);
          renderList();
        }
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') create();
        else if (e.key === 'Escape') {
          done = true;
          renderList();
          list.focus();
        }
      });
      input.addEventListener('blur', create);
    });

    // Import: copy files from the computer into this folder, then select them.
    $('.import')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (options.accept) input.accept = [].concat(options.accept).join(',');
      input.addEventListener('change', async () => {
        if (!input.files?.length) return;
        try {
          const added = [].concat(await local.upload(input.files, dir, { dedupeName: true }));
          await go(dir);
          selected = new Set(added.map((x) => x.path));
          renderList();
        } catch (e) {
          fail(e);
        }
      });
      input.click();
    });

    $('.all')?.addEventListener('change', (e) => {
      showAll = e.target.checked;
      selected = new Set();
      renderList();
    });
    $('.cancel').addEventListener('click', close);
    $('.x').addEventListener('click', close);
    okBtn.addEventListener('click', ok);
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok();
    });

    // Keys stay in the dialog (the app's own shortcuts must not fire underneath it).
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const inField = e.composedPath()[0]?.tagName === 'INPUT';
      if (e.key === 'Escape') return close();
      if (inField) return;
      const current = shown.findIndex((x) => selected.has(x.path));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        select(Math.max(0, Math.min(shown.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1))), { shiftKey: e.shiftKey && multiple });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (current >= 0 && shown[current].is_dir && selected.size === 1) go(shown[current].path);
        else ok();
      } else if (e.key === 'Backspace' && dir !== HOME) {
        e.preventDefault();
        go(parentOf(dir));
      }
    });
    host.addEventListener('keydown', (e) => e.stopPropagation());
    host.addEventListener('keyup', (e) => e.stopPropagation());
    root.querySelector('.backdrop').addEventListener('mousedown', (e) => {
      if (e.target === e.currentTarget) close();
    });

    document.documentElement.append(host);
    go(dir).then(() => (nameInput ? (nameInput.focus(), nameInput.setSelectionRange(0, nameInput.value.replace(/\.[^.]*$/, '').length)) : list.focus()));
  }

  window.__everythingLocalCloud = { local, patch, picker, home: HOME, appFolder: APP_FOLDER };
})();
