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
const STAR = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.1 6.6 20l1-6.1-4.4-4.3 6.1-.9z"/></svg>';

let apps = [];
let favorites = [];
let catalogVersion = -1;
let repoInfo = { exists: true };
let savingFavorites = 0; // while a save is in flight, a status refresh must not undo the click
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
    tile.append(star);
  }

  if (!tiles.has(app.id)) tiles.set(app.id, []);
  tiles.get(app.id).push({ tile, status, stop, app });
  return tile;
}

function section(id, title, items, extra) {
  return el(
    'section',
    { className: 'category', id },
    el('h2', {}, title, el('span', { className: 'count', textContent: String(items.length) })),
    items.length ? el('div', { className: 'grid' }, ...items.map(buildTile)) : extra,
  );
}

function render() {
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
  jumpEl.replaceChildren(
    ...(pinned.length ? [el('a', { href: '#favorites', textContent: 'Favorites', className: 'jump-fav' })] : []),
    ...categories.map((c) => el('a', { href: `#cat-${slug(c.name)}`, textContent: c.name })),
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
        const restart = el('button', { className: 'restart', type: 'button', textContent: 'Restart to update' });
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
  document.title = active ? `Everything (${active} running)` : 'Everything';
}

function applySearch() {
  const q = searchEl.value.trim().toLowerCase();
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

function renderRepoStatus(r) {
  const btn = repoStatusEl;
  btn.hidden = !r.exists;
  if (!r.exists) return;
  btn.className = 'repo-status';
  if (r.busy === 'pulling') {
    btn.classList.add('busy');
    btn.textContent = 'Updating Everything…';
  } else if (r.behind > 0) {
    btn.classList.add('available');
    btn.textContent = `${r.behind} update${r.behind === 1 ? '' : 's'} available`;
    btn.title = `Your Everything repo is ${r.behind} commit${r.behind === 1 ? '' : 's'} behind ${r.upstream}. Click to see what changed.`;
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

function renderUpdates(r) {
  const summary = document.getElementById('updates-summary');
  const notes = document.getElementById('updates-notes');
  const list = document.getElementById('updates-list');
  const checked = document.getElementById('updates-checked');
  const web = document.getElementById('updates-web');
  const checkBtn = document.getElementById('updates-check');
  const pullBtn = document.getElementById('updates-pull');

  if (r.behind > 0) {
    summary.textContent = `Your copy is ${r.behind} commit${r.behind === 1 ? '' : 's'} behind ${r.upstream}${r.ahead ? ` and has ${r.ahead} local commit${r.ahead === 1 ? '' : 's'}` : ''}. Oldest first:`;
  } else if (r.upstream) {
    summary.textContent = `You’re up to date with ${r.upstream}${r.ahead ? ` (plus ${r.ahead} local commit${r.ahead === 1 ? '' : 's'})` : ''}.`;
  } else summary.textContent = '';

  const noteList = [];
  if (r.error) noteList.push(el('p', { className: 'note error', textContent: r.error }));
  if (r.behind > 0 && r.ahead > 0) noteList.push(el('p', { className: 'note', textContent: 'Your branch has local commits, so it can’t be fast-forwarded. Update it with git yourself.' }));
  if (r.behind > 0 && r.dirty) noteList.push(el('p', { className: 'note', textContent: 'There are local changes to tracked files; the update stops if it would overwrite them.' }));
  if (r.behind > 0 && r.running) noteList.push(el('p', { className: 'note', textContent: `${r.running} app${r.running === 1 ? ' is' : 's are'} running. After the update, apps whose files changed show “Restart to update”.` }));
  if (r.truncated) noteList.push(el('p', { className: 'note', textContent: `Showing the newest ${r.commits.length} of ${r.behind} commits.` }));
  notes.replaceChildren(...noteList);

  list.replaceChildren(
    ...r.commits.map((c) => {
      const when = el('time', { dateTime: c.date, textContent: timeAgo(c.date), title: new Date(c.date).toLocaleString() });
      const hash = r.webUrl
        ? el('a', { href: `${r.webUrl}/commit/${c.hash}`, target: '_blank', rel: 'noopener', textContent: c.short, className: 'hash' })
        : el('code', { textContent: c.short, className: 'hash' });
      const item = el('li', { className: 'commit' }, el('p', { className: 'subject', textContent: c.subject }), el('p', { className: 'meta' }, hash, ` · ${c.author} · `, when));
      if (c.body) item.append(el('details', {}, el('summary', { textContent: 'Details' }), el('pre', { textContent: c.body })));
      return item;
    }),
  );
  list.hidden = !r.commits.length;

  checked.textContent = r.busy === 'checking' ? 'Checking…' : r.busy === 'pulling' ? 'Updating…' : r.checkedAt ? `Checked ${timeAgo(r.checkedAt)}` : '';
  web.hidden = !r.webUrl;
  if (r.webUrl) web.href = r.behind > 0 && r.upstream ? `${r.webUrl}/compare/${r.head}...${r.upstream.split('/').slice(1).join('/')}` : `${r.webUrl}/commits`;
  checkBtn.disabled = Boolean(r.busy);
  pullBtn.hidden = !(r.behind > 0);
  pullBtn.disabled = Boolean(r.busy) || r.ahead > 0;
  pullBtn.textContent = r.busy === 'pulling' ? 'Updating…' : `Update now`;
}

async function refreshRepo() {
  clearTimeout(repoTimer);
  try {
    const r = await (await fetch('/api/repo')).json();
    const finishedUpdate = lastRepo?.busy === 'pulling' && !r.busy;
    lastRepo = r;
    renderRepoStatus(r);
    // http://localhost:4000/#updates opens the update list directly.
    if (location.hash === '#updates' && r.exists && !updatesEl.open) {
      history.replaceState(null, '', location.pathname);
      updatesEl.showModal();
    }
    if (updatesEl.open) renderUpdates(r);
    if (!repoInfo.exists && !r.exists) renderSetup();
    if (finishedUpdate || (r.exists && !repoInfo.exists)) refresh();
    // Poll quickly while git is busy, otherwise once a minute (the server fetches every 15).
    repoTimer = setTimeout(refreshRepo, r.busy ? 1000 : 60_000);
  } catch {
    repoTimer = setTimeout(refreshRepo, 10_000);
  }
}

repoStatusEl.addEventListener('click', () => {
  if (lastRepo) renderUpdates(lastRepo);
  updatesEl.showModal();
});
updatesEl.addEventListener('click', (e) => {
  if (e.target === updatesEl) updatesEl.close(); // click on the backdrop
});
document.getElementById('updates-check').addEventListener('click', async () => {
  await post('/api/repo/check');
  refreshRepo();
});
document.getElementById('updates-pull').addEventListener('click', async () => {
  await post('/api/repo/pull');
  refreshRepo();
});

// ---------------------------------------------------------------- refresh loop

async function refresh() {
  try {
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
    if (changed) render();
    else updateStatus();
  } catch {
    catalogEl.replaceChildren(el('p', { className: 'empty', textContent: 'The launcher is not running. Start it again from the Everything shortcut or with npm start.' }));
    apps = [];
    tiles.clear();
  }
}

searchEl.addEventListener('input', applySearch);
stopAllEl.addEventListener('click', () => {
  for (const app of apps) if (ACTIVE.has(app.state)) control(app.id, 'stop');
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
