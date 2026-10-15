// Dashboard: favorites and the catalog by category, live app status, and updates to the Everything repo.
const catalogEl = document.getElementById('catalog');
const jumpEl = document.getElementById('jump');
const searchEl = document.getElementById('search');
const stopAllEl = document.getElementById('stop-all');
const repoStatusEl = document.getElementById('repo-status');
const updatesEl = document.getElementById('updates');

const LABELS = {
  running: 'Running',
  installing: 'Installing…',
  building: 'Building…',
  starting: 'Starting…',
  error: 'Error',
};
const ACTIVE = new Set(['installing', 'building', 'starting', 'running']);
const DOTS = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STAR = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.1 6.6 20l1-6.1-4.4-4.3 6.1-.9z"/></svg>';

let apps = [];
let favorites = [];
let catalogVersion = -1;
let repoInfo = { exists: true };
let windowsHost = false; // shortcut options need the launcher to run on Windows
let savingFavorites = 0; // while a save is in flight, a status refresh must not undo the click
let collapsed = new Set(); // section ids folded away ("favorites", "cat-games", ...), saved with the user's settings
let collapseVersion = 0; // bumped around every save, so a refresh that started earlier cannot undo a fold
const tiles = new Map(); // app id -> every tile showing it (favorites and its category)

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function post(url, body = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({}));
}

async function control(id, action) {
  await post(`/api/apps/${id}/${action}`);
  refresh();
}

async function toggleFavorite(id) {
  const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
  favorites = next;
  render();
  savingFavorites++;
  try {
    const saved = await post('/api/favorites', { favorites: next });
    if (savingFavorites === 1 && Array.isArray(saved.favorites) && saved.favorites.join() !== favorites.join()) {
      favorites = saved.favorites;
      render();
    }
  } finally {
    savingFavorites--;
  }
}

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(message, { error = false } = {}) {
  let box = document.getElementById('toast');
  if (!box) document.body.append((box = el('div', { id: 'toast', className: 'toast', role: 'status' })));
  box.textContent = message;
  box.classList.toggle('error', error);
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), error ? 8000 : 6000);
}

// ---------------------------------------------------------------- per-app menu

let openMenu = null; // { button, menu, tile }

function closeMenu({ focus = false } = {}) {
  if (!openMenu) return;
  const { button, menu, tile } = openMenu;
  openMenu = null;
  menu.remove();
  tile.classList.remove('menu-open');
  button.setAttribute('aria-expanded', 'false');
  if (focus) button.focus();
}

async function shortcutAction(app, where, verb) {
  const place = where === 'desktop' ? 'the desktop' : 'the Start menu';
  if (verb === 'add') toast(`Adding ${app.name} to ${place}…`);
  const res = await post(`/api/apps/${app.id}/shortcut`, { where, action: verb });
  if (res.error) return toast(res.error, { error: true });
  app.shortcuts = res.shortcuts;
  if (verb === 'remove') toast(`Removed ${app.name} from ${place}.`);
  else if (where === 'desktop') toast(`Added a ${app.name} shortcut to the desktop.`);
  // Windows lets only the user pin to Start; the shortcut puts the app one right-click away.
  else toast(`Added ${app.name} to the Start menu (Everything Apps). To pin it, find it in Start, right-click it and choose Pin to Start.`);
}

function showMenu(id, button, tile) {
  closeMenu();
  const app = apps.find((a) => a.id === id);
  if (!app) return;
  const active = ACTIVE.has(app.state);
  const sc = app.shortcuts || {};
  const items = [
    ['Open', () => window.open(`/launch/${app.id}`, `everything-${app.id}`)],
    active && ['Restart', () => control(app.id, 'restart')],
    active && ['Stop', () => control(app.id, 'stop')],
    app.localFiles && [
      'Show saved files',
      async () => {
        const res = await post(`/api/apps/${app.id}/files`);
        if (res.error) toast(res.error, { error: true });
        else toast(`${app.name} saves to ${res.folder}`);
      },
    ],
    windowsHost && '-',
    windowsHost && [sc.desktop ? 'Remove desktop shortcut' : 'Add shortcut to desktop', () => shortcutAction(app, 'desktop', sc.desktop ? 'remove' : 'add')],
    windowsHost && [sc.start ? 'Remove from Start menu' : 'Add to Start menu', () => shortcutAction(app, 'start', sc.start ? 'remove' : 'add')],
    windowsHost && [
      'Show .exe in folder',
      async () => {
        const res = await post(`/api/apps/${app.id}/reveal`);
        if (res.error) toast(res.error, { error: true });
      },
    ],
  ].filter(Boolean);

  const menu = el('div', { className: 'menu', role: 'menu' });
  menu.setAttribute('aria-label', `${app.name} options`);
  for (const item of items) {
    if (item === '-') {
      menu.append(el('div', { className: 'menu-sep', role: 'separator' }));
      continue;
    }
    const [label, run] = item;
    const btn = el('button', { type: 'button', role: 'menuitem', textContent: label, tabIndex: -1 });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      run();
    });
    menu.append(btn);
  }
  menu.addEventListener('keydown', (e) => {
    const entries = [...menu.querySelectorAll('[role=menuitem]')];
    const i = entries.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      entries[(i + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu({ focus: true });
    }
  });
  tile.append(menu);
  tile.classList.add('menu-open');
  button.setAttribute('aria-expanded', 'true');
  openMenu = { button, menu, tile };
  menu.querySelector('[role=menuitem]')?.focus();
}

document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.menu.contains(e.target)) closeMenu();
});

// ---------------------------------------------------------------- tiles

function buildTile(app) {
  const tile = el('article', { className: 'tile' });
  const icon = app.icon ? el('img', { src: app.icon, alt: '', loading: 'lazy', width: 64, height: 64 }) : null;
  const name = el('span', { className: 'name', textContent: app.name });
  const desc = app.description ? el('p', { className: 'desc', textContent: app.description, title: app.description }) : null;
  const alt = app.alternativeTo
    ? el('p', { className: 'alt', textContent: `Alternative to ${app.alternativeTo}`, title: app.alternativeTo })
    : null;

  if (app.launchable) {
    // Its own named tab: opening a running app again returns to that tab.
    const link = el('a', { className: 'open', href: `/launch/${app.id}`, target: `everything-${app.id}` }, name);
    link.setAttribute('aria-label', `Open ${app.name}`);
    tile.append(icon ?? '', link, desc ?? '', alt ?? '');
  } else {
    tile.classList.add('unavailable');
    tile.title = 'No code in the Everything repo yet';
    tile.append(icon ?? '', name, el('p', { className: 'desc', textContent: 'Coming soon' }), alt ?? '');
  }

  const status = el('span', { className: 'status' });
  const stop = el('button', { className: 'stop', type: 'button', textContent: 'Stop', hidden: true });
  stop.addEventListener('click', () => control(app.id, 'stop'));
  tile.append(status, stop);

  if (app.launchable) {
    const pinned = favorites.includes(app.id);
    const star = el('button', { className: 'star', type: 'button', innerHTML: STAR });
    star.setAttribute('aria-pressed', String(pinned));
    star.setAttribute('aria-label', pinned ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`);
    star.title = pinned ? 'Remove from favorites' : 'Add to favorites';
    star.addEventListener('click', () => toggleFavorite(app.id));

    const more = el('button', { className: 'more', type: 'button', innerHTML: DOTS, title: 'More options' });
    more.setAttribute('aria-label', `More options for ${app.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu?.button === more) closeMenu();
      else showMenu(app.id, more, tile);
    });
    tile.append(star, more);
  }

  if (!tiles.has(app.id)) tiles.set(app.id, []);
  tiles.get(app.id).push({ tile, status, stop, app });
  return tile;
}

async function setCollapsed(id, fold) {
  if (fold === collapsed.has(id)) return;
  collapsed = new Set(collapsed);
  if (fold) collapsed.add(id);
  else collapsed.delete(id);
  collapseVersion++;
  applyCollapsed();
  await post('/api/collapsed', { collapsed: [...collapsed] });
  collapseVersion++; // and so can one that started while this save was in flight
}

function applyCollapsed() {
  for (const sec of catalogEl.querySelectorAll('.category')) {
    const fold = collapsed.has(sec.id);
    sec.classList.toggle('collapsed', fold);
    sec.querySelector('.fold').setAttribute('aria-expanded', String(!fold));
  }
}

function section(id, title, items, extra) {
  const body = items.length ? el('div', { className: 'grid' }, ...items.map(buildTile)) : extra;
  body.id = `${id}-body`;
  const fold = el('button', { className: 'fold', type: 'button', innerHTML: CHEVRON }, title, el('span', { className: 'count', textContent: String(items.length) }));
  fold.setAttribute('aria-controls', body.id);
  fold.addEventListener('click', () => setCollapsed(id, !collapsed.has(id)));
  return el('section', { className: 'category', id }, el('h2', {}, fold), body);
}

// Jumping to a folded category opens it.
const jumpLink = (id, text, className) => {
  const link = el('a', { href: `#${id}`, textContent: text, className });
  link.addEventListener('click', () => setCollapsed(id, false));
  return link;
};

function render() {
  closeMenu();
  tiles.clear();
  if (!repoInfo.exists) return renderSetup();
  if (!apps.length) {
    jumpEl.replaceChildren();
    catalogEl.replaceChildren(el('p', { className: 'empty', textContent: `No apps were found in ${repoInfo.path}.` }));
    return;
  }
  const categories = [];
  for (const app of apps) {
    let group = categories.find((c) => c.name === app.category);
    if (!group) categories.push((group = { name: app.category, apps: [] }));
    group.apps.push(app);
  }
  const pinned = favorites.map((id) => apps.find((a) => a.id === id)).filter(Boolean);
  const hint = el('p', { className: 'fav-empty' }, 'Pin the apps you use most: hover over any app and click its star', el('span', { className: 'fav-star', innerHTML: STAR }));

  catalogEl.replaceChildren(
    section('favorites', 'Favorites', pinned, hint),
    ...categories.map((c) => section(`cat-${slug(c.name)}`, c.name, c.apps)),
  );
  catalogEl.querySelector('#favorites').classList.add('favorites');
  applyCollapsed();
  jumpEl.replaceChildren(
    ...(pinned.length ? [jumpLink('favorites', 'Favorites', 'jump-fav')] : []),
    ...categories.map((c) => jumpLink(`cat-${slug(c.name)}`, c.name)),
  );
  updateStatus();
  applySearch();
}

function updateStatus() {
  let active = 0;
  for (const app of apps) {
    for (const t of tiles.get(app.id) ?? []) {
      const label = LABELS[app.state];
      t.tile.className = t.tile.className.replace(/\bstate-\S+/g, '').trim() + (label ? ` state-${app.state}` : '');
      if (app.stale) {
        // The app's files changed in an update: offer to restart it.
        const restart = el('button', { className: 'restart', type: 'button', textContent: 'Restart', title: 'Updated: restart to load the changes' });
        restart.addEventListener('click', () => control(app.id, 'restart'));
        t.status.replaceChildren(el('span', { className: 'dot' }), restart);
      } else {
        t.status.replaceChildren(...(label ? [el('span', { className: 'dot' }), label] : []));
      }
      t.status.title = app.error || (app.state === 'stopped' && app.launchable && !app.installed ? 'First launch installs dependencies' : '');
      t.stop.hidden = !ACTIVE.has(app.state);
    }
    if (ACTIVE.has(app.state)) active++;
  }
  stopAllEl.hidden = active === 0;
  stopAllEl.textContent = active > 1 ? `Close all apps (${active})` : 'Close all apps';
  document.title = active ? `Everything (${active} running)` : 'Everything';
}

function applySearch() {
  const q = searchEl.value.trim().toLowerCase();
  catalogEl.classList.toggle('searching', Boolean(q)); // search results show inside folded categories too
  for (const sec of catalogEl.querySelectorAll('.category')) {
    const heading = sec.querySelector('h2').textContent.toLowerCase();
    let shown = 0;
    for (const tile of sec.querySelectorAll('.tile')) {
      const match = !q || tile.textContent.toLowerCase().includes(q) || (!sec.classList.contains('favorites') && heading.includes(q));
      tile.hidden = !match;
      if (match) shown++;
    }
    // An empty favorites section keeps its hint, except while searching.
    const emptyFavorites = sec.classList.contains('favorites') && !sec.querySelector('.tile');
    sec.hidden = emptyFavorites ? Boolean(q) : shown === 0;
  }
}

// ---------------------------------------------------------------- setup (no Everything repo yet)

function renderSetup() {
  jumpEl.replaceChildren();
  const cloning = repoInfo.busy === 'cloning';
  const button = el('button', { className: 'primary', type: 'button', textContent: cloning ? 'Downloading…' : 'Download Everything', disabled: cloning });
  button.addEventListener('click', async () => {
    await post('/api/repo/clone');
    refreshRepo();
    refresh();
  });
  const log = el('pre', { className: 'log', id: 'clone-log', hidden: !cloning && !lastRepo?.log?.length });
  log.textContent = (lastRepo?.log || []).join('\n');
  const error = lastRepo?.error && !cloning ? el('p', { className: 'hint error', textContent: lastRepo.error }) : null;
  catalogEl.replaceChildren(
    el(
      'section',
      { className: 'setup' },
      el('img', { src: '/favicon.png', alt: '', width: 72, height: 72 }),
      el('h2', { textContent: 'The Everything apps are not downloaded yet' }),
      el('p', {}, 'The launcher looks for them in ', el('code', { textContent: repoInfo.path || '../everything' }), '. Download them from GitHub now (about a minute), or set EVERYTHING_REPO to where they are and restart the launcher.'),
      button,
      error,
      log,
    ),
  );
}

// ---------------------------------------------------------------- updates to the Everything repo

let lastRepo = null;
let repoTimer = null;
let historyData = null;

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  const units = [
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let n = s / 60;
  for (const [size, unit] of units) {
    if (n < size) {
      const v = Math.max(1, Math.round(n));
      return `${v} ${unit}${v === 1 ? '' : 's'} ago`;
    }
    n /= size;
  }
  return '';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatBytes(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return `${bytes.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

const BUSY_TEXT = { pulling: 'Updating Everything…', switching: 'Switching version…', cloning: 'Downloading Everything…' };

function renderRepoStatus(r) {
  const btn = repoStatusEl;
  btn.hidden = !r.exists;
  if (!r.exists) return;
  btn.className = 'repo-status';
  btn.title = '';
  if (BUSY_TEXT[r.busy]) {
    btn.classList.add('busy');
    btn.textContent = BUSY_TEXT[r.busy];
  } else if (r.diverged) {
    btn.classList.add('warn');
    btn.textContent = 'Upstream history changed';
    btn.title = 'The upstream branch no longer contains your version. Click for details; your backup kept everything.';
  } else if (r.rolledBack && r.behind > 0) {
    btn.classList.add('rolled-back');
    btn.textContent = `Older version · ${plural(r.behind, 'newer commit')}`;
    btn.title = `You switched to an older version (${r.head}). Click to update or pick another version.`;
  } else if (r.behind > 0) {
    btn.classList.add('available');
    btn.textContent = `${plural(r.behind, 'update')} available`;
    btn.title = `Your Everything repo is ${plural(r.behind, 'commit')} behind ${r.upstream}. Click to see what changed.`;
  } else if (r.error && !r.checkedAt) {
    btn.classList.add('warn');
    btn.textContent = 'Couldn’t check for updates';
    btn.title = r.error;
  } else if (r.busy === 'checking' && !r.checkedAt) {
    btn.textContent = 'Checking for updates…';
  } else {
    btn.textContent = 'Up to date';
    btn.title = r.checkedAt ? `Checked ${timeAgo(r.checkedAt)}` : '';
  }
}

function commitItem(r, c, extra) {
  const when = el('time', { dateTime: c.date, textContent: timeAgo(c.date), title: new Date(c.date).toLocaleString() });
  const hash = r.webUrl
    ? el('a', { href: `${r.webUrl}/commit/${c.hash}`, target: '_blank', rel: 'noopener', textContent: c.short, className: 'hash' })
    : el('code', { textContent: c.short, className: 'hash' });
  const item = el('li', { className: 'commit' }, el('p', { className: 'subject', textContent: c.subject }), el('p', { className: 'meta' }, hash, ` · ${c.author} · `, when));
  if (c.body) item.append(el('details', {}, el('summary', { textContent: 'Details' }), el('pre', { textContent: c.body })));
  if (extra) item.append(extra);
  return item;
}

function repoNotes(r) {
  const notes = [];
  const note = (text, cls = '') => notes.push(el('p', { className: `note ${cls}`.trim(), textContent: text }));
  if (r.error) note(r.error, 'error');
  if (r.diverged) {
    note(
      `The upstream branch ${r.upstream} no longer contains your version: its history was rewritten (or you have local commits). Nothing was changed here, and the backup keeps both histories.`,
      'warn',
    );
  }
  const rewritten = (r.backup?.rewritten || []).filter((w) => !w.name.startsWith('local/')); // only what upstream did
  if (rewritten.length) {
    const names = [...new Set(rewritten.map((w) => w.name.replace(/^heads\//, '')))].join(', ');
    note(`Upstream rewrote history (${names}) at some point. The backup kept the original versions as well as the rewritten ones.`, 'warn');
  }
  if (r.rolledBack && r.behind > 0) note(`You’re on an older version (${r.head}). Update now returns to the latest, including the commits you rolled back from.`);
  if (r.behind > 0 && r.incoming?.mass) {
    note(`Careful: this update deletes ${r.incoming.deleted} of ${r.incoming.total} files. You’ll be asked to confirm, and the backup keeps the current version either way.`, 'warn');
  }
  if (r.behind > 0 && r.ahead > 0 && !r.diverged) note('Your branch has local commits, so it can’t be fast-forwarded. Update it with git yourself.');
  if (r.behind > 0 && r.dirty) note('There are local changes to tracked files; the update stops if it would overwrite them.');
  if (r.behind > 0 && r.running) note(`${plural(r.running, 'app')} running. After the update, apps whose files changed show a Restart button.`);
  if (r.truncated) note(`Showing the newest ${r.commits.length} of ${r.behind} commits.`);
  return notes;
}

function renderUpdates(r) {
  const $ = (id) => document.getElementById(id);
  const summary = $('updates-summary');
  if (r.diverged) summary.textContent = `Your copy and ${r.upstream} have different histories.`;
  else if (r.behind > 0) summary.textContent = `Your copy is ${plural(r.behind, 'commit')} behind ${r.upstream}. Oldest first:`;
  else if (r.upstream) summary.textContent = `You’re up to date with ${r.upstream}${r.ahead ? ` (plus ${plural(r.ahead, 'local commit')})` : ''}.`;
  else summary.textContent = '';

  $('updates-notes').replaceChildren(...repoNotes(r));
  const list = $('updates-list');
  list.replaceChildren(...r.commits.map((c) => commitItem(r, c)));
  list.hidden = !r.commits.length;

  $('updates-checked').textContent = BUSY_TEXT[r.busy] || (r.busy === 'checking' ? 'Checking…' : r.checkedAt ? `Checked ${timeAgo(r.checkedAt)}` : '');
  const b = r.backup || {};
  const backupEl = $('updates-backup');
  backupEl.textContent = b.error ? 'Backup failed' : b.exists ? `Backup: ${formatBytes(b.size)}${b.updatedAt ? `, updated ${timeAgo(b.updatedAt)}` : ''}` : '';
  backupEl.title = b.error ? b.error : b.path ? `${b.path}\nRestore with: git clone "${b.path}" everything` : '';
  backupEl.classList.toggle('error', Boolean(b.error));

  const web = $('updates-web');
  web.hidden = !r.webUrl;
  if (r.webUrl) web.href = r.behind > 0 && r.upstream && !r.diverged ? `${r.webUrl}/compare/${r.head}...${r.upstream.split('/').slice(1).join('/')}` : `${r.webUrl}/commits`;
  $('updates-check').disabled = Boolean(r.busy);
  const pullBtn = $('updates-pull');
  pullBtn.hidden = !(r.behind > 0) || r.diverged;
  pullBtn.disabled = Boolean(r.busy) || r.ahead > 0;
  pullBtn.textContent = r.busy === 'pulling' ? 'Updating…' : r.rolledBack ? 'Update to latest' : 'Update now';

  if (!$('panel-history').hidden) renderHistory();
}

// ---- version history

async function loadHistory() {
  try {
    historyData = await (await fetch('/api/repo/history')).json();
  } catch {
    historyData = { error: 'Could not load the history.' };
  }
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const notes = document.getElementById('history-notes');
  const r = lastRepo || {};
  const busy = Boolean(r.busy);
  notes.replaceChildren(...(historyData?.error ? [el("p", { className: "note error", textContent: historyData.error })] : []));
  if (!historyData) {
    list.replaceChildren(el('li', { className: 'commit muted', textContent: 'Loading history…' }));
    return;
  }
  const currentIndex = historyData.commits.findIndex((c) => c.current);
  list.replaceChildren(
    ...historyData.commits.map((c, i) => {
      let extra;
      if (c.current) extra = el('span', { className: 'badge', textContent: 'Current version' });
      else {
        const newer = currentIndex >= 0 && i < currentIndex;
        const btn = el('button', { className: 'ghost small', type: 'button', textContent: newer ? 'Move forward to this' : 'Use this version', disabled: busy });
        btn.addEventListener('click', () => useVersion(c));
        extra = btn;
      }
      const item = commitItem(r, c, el('div', { className: 'version-action' }, extra));
      item.classList.toggle('current', c.current);
      return item;
    }),
  );
}

async function useVersion(c) {
  const r = lastRepo || {};
  const message = [
    `Switch Everything to ${c.short}?`,
    `“${c.subject}”`,
    '',
    'The backup is updated first, so nothing is lost.',
    r.running ? `Running apps whose files change will show a Restart button.` : '',
    'To return to the latest version later, use Update now.',
  ]
    .filter((line, i, all) => line || all[i - 1])
    .join('\n');
  if (!confirm(message)) return;
  const res = await post('/api/repo/use', { commit: c.hash });
  if (res.error) return toast(res.error, { error: true });
  toast(`Switching Everything to ${c.short}…`);
  refreshRepo();
}

function selectTab(name) {
  for (const tab of ['updates', 'history']) {
    const on = tab === name;
    const button = document.getElementById(`tab-${tab}`);
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    document.getElementById(`panel-${tab}`).hidden = !on;
  }
  if (name === 'history') {
    historyData = null;
    renderHistory();
    loadHistory();
  }
}

for (const tab of ['updates', 'history']) document.getElementById(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = document.getElementById('tab-updates').getAttribute('aria-selected') === 'true' ? 'history' : 'updates';
  selectTab(next);
  document.getElementById(`tab-${next}`).focus();
});

async function refreshRepo() {
  clearTimeout(repoTimer);
  try {
    const r = await (await fetch('/api/repo')).json();
    const finished = lastRepo?.busy && ['pulling', 'switching', 'cloning'].includes(lastRepo.busy) && !r.busy;
    lastRepo = r;
    renderRepoStatus(r);
    // http://localhost:4000/#updates (or #history) opens the update window directly.
    if ((location.hash === '#updates' || location.hash === '#history') && r.exists && !updatesEl.open) {
      const tab = location.hash.slice(1);
      history.replaceState(null, '', location.pathname);
      renderUpdates(r);
      updatesEl.showModal();
      selectTab(tab);
    }
    if (updatesEl.open) renderUpdates(r);
    if (!repoInfo.exists && !r.exists) renderSetup();
    if (finished) {
      refresh();
      if (!document.getElementById('panel-history').hidden) loadHistory();
      if (r.error) toast(r.error, { error: true });
      else toast(lastDone(r));
    } else if (r.exists && !repoInfo.exists) refresh();
    // Poll quickly while git is busy, otherwise once a minute (the server fetches every 15).
    repoTimer = setTimeout(refreshRepo, r.busy ? 1000 : 60_000);
  } catch {
    repoTimer = setTimeout(refreshRepo, 10_000);
  }
}

function lastDone(r) {
  if (r.rolledBack && r.behind > 0) return `Everything is now on ${r.head} (${plural(r.behind, 'newer commit')} available).`;
  return `Everything is up to date (${r.head}).`;
}

repoStatusEl.addEventListener('click', () => {
  if (lastRepo) renderUpdates(lastRepo);
  updatesEl.showModal();
  selectTab('updates');
});
updatesEl.addEventListener('click', (e) => {
  if (e.target === updatesEl) updatesEl.close(); // click on the backdrop
});
document.getElementById('updates-check').addEventListener('click', async () => {
  await post('/api/repo/check');
  refreshRepo();
});
document.getElementById('updates-pull').addEventListener('click', async () => {
  const r = lastRepo || {};
  if (r.incoming?.mass && !confirm(`This update deletes ${r.incoming.deleted} of ${r.incoming.total} files in Everything.\n\nThe backup keeps the current version either way. Update anyway?`)) return;
  await post('/api/repo/pull');
  refreshRepo();
});

// ---------------------------------------------------------------- refresh loop

async function refresh() {
  try {
    const seenCollapse = collapseVersion;
    const data = await (await fetch('/api/apps')).json();
    const serverFavorites = savingFavorites ? favorites : data.favorites ?? [];
    const changed =
      data.catalogVersion !== catalogVersion ||
      data.repo.exists !== repoInfo.exists ||
      data.repo.busy !== repoInfo.busy ||
      serverFavorites.join() !== favorites.join();
    apps = data.apps;
    favorites = serverFavorites;
    catalogVersion = data.catalogVersion;
    repoInfo = data.repo;
    windowsHost = Boolean(data.windows);
    const serverCollapsed = new Set(data.collapsed ?? []);
    const collapseChanged = seenCollapse === collapseVersion && [...serverCollapsed].sort().join() !== [...collapsed].sort().join();
    if (collapseChanged) collapsed = serverCollapsed;
    if (changed) render();
    else {
      if (collapseChanged) applyCollapsed();
      updateStatus();
    }
  } catch {
    catalogEl.replaceChildren(el('p', { className: 'empty', textContent: 'The launcher is not running. Start it again from the Everything shortcut or with npm start.' }));
    apps = [];
    tiles.clear();
  }
}

searchEl.addEventListener('input', applySearch);
stopAllEl.addEventListener('click', async () => {
  const running = apps.filter((a) => ACTIVE.has(a.state));
  if (!running.length) return;
  const names = running.map((a) => a.name).join(', ');
  if (!confirm(`Close ${plural(running.length, 'app')} (${names})?

Their windows close and their dev servers stop. Save your work first. Next time you open them they start with the latest version.`)) return;
  stopAllEl.disabled = true;
  try {
    const res = await post('/api/apps/stop-all');
    if (res.error) toast(res.error, { error: true });
    else toast(`Closed ${plural(res.stopped?.length ?? running.length, 'app')}. They open with the latest version next time.`);
  } finally {
    stopAllEl.disabled = false;
    refresh();
  }
});
document.addEventListener('keydown', (e) => {
  // "/" jumps to search, Escape clears it.
  if (e.key === '/' && document.activeElement !== searchEl && !updatesEl.open) {
    e.preventDefault();
    searchEl.focus();
  } else if (e.key === 'Escape' && document.activeElement === searchEl && searchEl.value) {
    searchEl.value = '';
    applySearch();
  }
});

refresh();
refreshRepo();
setInterval(refresh, 3000);
