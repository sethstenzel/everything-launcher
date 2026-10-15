/**
 * The app catalog, read from the Everything repository: categories, names and
 * "alternative to" from its README.md, descriptions from each app's
 * package.json (or web manifest), icons from src/<app>/icon-128.png.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Apps with code in src/ that the README does not list yet.
const EXTRA_CATEGORY = { tasks: 'Productivity', 'time-tracking': 'Productivity' };

// Apps that only work signed in to an online Puter account: signed out they show a sign-in
// screen (email, teamchat, help-desk) or cannot start a meeting (meetings). Hidden unless the
// launcher options say otherwise.
const REQUIRES_ACCOUNT = new Set(['email', 'teamchat', 'help-desk', 'meetings']);

const APP_PORT_BASE = 5400;
const APP_PORT_SPAN = 600;

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function decode(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function titleCase(id) {
  return id.replace(/(^|-)(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase());
}

/** "Expenses: receipt capture…" -> "Receipt capture…" (drops a short name prefix). */
function cleanDescription(text) {
  if (!text) return '';
  const m = text.match(/^(.{1,28}?)(?: — |: )(.+)$/);
  const rest = (m ? m[2] : text).trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function configuredPort(dir) {
  for (const name of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    const m = readFileSync(file, 'utf8').match(/\bport:\s*(\d{4,5})\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function makeApp(src, id, name, category, blurb) {
  const dir = path.join(src, id);
  const pkg = readJson(path.join(dir, 'package.json'));
  const isGame = category === 'Games';
  return {
    id,
    name,
    category,
    // The README's second column is "Alternative to", except for games, where it describes the game.
    description:
      (isGame && blurb) ||
      cleanDescription(pkg?.description) ||
      cleanDescription(readJson(path.join(dir, 'public', 'manifest.json'))?.description) ||
      '',
    alternativeTo: isGame ? '' : blurb,
    icon: existsSync(path.join(dir, 'icon-128.png')) ? `/icons/${id}.png` : null,
    launchable: Boolean(pkg?.scripts?.dev),
    requiresAccount: REQUIRES_ACCOUNT.has(id),
  };
}

/**
 * Gives every app a fixed port. Ports handed out before are kept, so an app
 * keeps its origin (and the data it stored in the browser) when updates add
 * apps. New apps get their own configured port when no other app claims it,
 * otherwise a slot derived from their name.
 */
function assignPorts(src, apps, { saved, reserved }) {
  const launchable = apps.filter((a) => a.launchable).sort((a, b) => a.id.localeCompare(b.id));
  const taken = new Set(reserved);
  const ports = new Map();
  for (const a of launchable) {
    const p = saved[a.id];
    if (Number.isInteger(p) && !taken.has(p)) ports.set(a.id, p), taken.add(p);
  }
  const wanted = new Map(launchable.map((a) => [a.id, configuredPort(path.join(src, a.id))]));
  const claims = {};
  for (const p of wanted.values()) if (p) claims[p] = (claims[p] || 0) + 1;
  for (const a of launchable) {
    const p = wanted.get(a.id);
    if (!ports.has(a.id) && p && claims[p] === 1 && !taken.has(p)) ports.set(a.id, p), taken.add(p);
  }
  for (const a of launchable) {
    if (ports.has(a.id)) continue;
    let p = APP_PORT_BASE + (hash(a.id) % APP_PORT_SPAN);
    while (taken.has(p)) p++;
    ports.set(a.id, p);
    taken.add(p);
  }
  return ports;
}

/** Returns the apps in README order (unlisted ones last), or [] when the repository is missing. */
export function loadCatalog(repoDir, { savedPorts = {}, reservedPorts = [] } = {}) {
  const src = path.join(repoDir, 'src');
  const readmeFile = path.join(repoDir, 'README.md');
  if (!existsSync(readmeFile) || !existsSync(src)) return [];
  const readme = readFileSync(readmeFile, 'utf8');
  const row = /<img src="src\/([^/"]+)\/[^"]+".*?<strong><a [^>]*>([^<]+)<\/a><\/strong><\/td>\s*<td[^>]*>([^<]*)<\/td>/;
  const apps = [];
  const seen = new Set();
  let category = null;
  for (const line of readme.split(/\r?\n/)) {
    const heading = line.match(/^## (.+)/);
    if (heading) {
      category = heading[1].trim();
      continue;
    }
    const m = category && line.match(row);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    apps.push(makeApp(src, m[1], decode(m[2]), category, decode(m[3])));
  }
  for (const id of readdirSync(src).sort()) {
    if (seen.has(id) || !existsSync(path.join(src, id, 'package.json'))) continue;
    apps.push(makeApp(src, id, titleCase(id), EXTRA_CATEGORY[id] || 'More', ''));
  }
  const ports = assignPorts(src, apps, { saved: savedPorts, reserved: reservedPorts });
  for (const a of apps) a.port = ports.get(a.id) ?? null;
  return apps;
}

export { APP_PORT_BASE, APP_PORT_SPAN };
