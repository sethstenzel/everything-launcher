// Launch page: starts one app, shows progress, then hands the tab over to the app.
const id = location.pathname.split('/').filter(Boolean)[1];
const ORDER = ['installing', 'building', 'starting', 'running'];
const HINTS = {
  installing: 'Installing dependencies. This happens once per app and can take a few minutes.',
  building: 'Building the app’s worker bundle.',
  starting: 'Starting the dev server.',
  running: 'Opening…',
};

const $ = (sel) => document.querySelector(sel);
let started = false;

async function launch() {
  started = true;
  $('#retry').hidden = true;
  const res = await fetch(`/api/apps/${id}/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    show({ state: 'error', error: body.error || `Could not start (${res.status})`, log: [] });
    return false;
  }
  return true;
}

function show(app) {
  if (app.name) {
    $('#title').textContent = app.state === 'error' ? `${app.name} did not start` : `Starting ${app.name}`;
    document.title = `Starting ${app.name}`;
  }
  if (app.icon) $('#icon').src = app.icon;
  const at = ORDER.indexOf(app.state);
  for (const li of document.querySelectorAll('.steps li')) {
    const i = ORDER.indexOf(li.dataset.step);
    li.className = at < 0 ? '' : i < at ? 'done' : i === at ? 'now' : '';
  }
  const hint = $('#hint');
  hint.className = app.state === 'error' ? 'hint error' : 'hint';
  hint.textContent = app.state === 'error' ? app.error || 'Something went wrong.' : HINTS[app.state] || '';
  const log = $('#log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.textContent = (app.log || []).join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
  $('#retry').hidden = app.state !== 'error' && app.state !== 'stopped';
}

async function poll() {
  try {
    const app = await (await fetch(`/api/apps/${id}`)).json();
    show(app);
    if (app.state === 'running' && app.url) return location.replace(app.url);
    if (app.state === 'error' || (app.state === 'stopped' && started)) return;
  } catch {
    show({ state: 'error', error: 'Lost contact with the launcher. Is it still running?' });
    return;
  }
  setTimeout(poll, 700);
}

$('#retry').addEventListener('click', async () => {
  if (await launch()) poll();
});

if (await launch()) poll();
