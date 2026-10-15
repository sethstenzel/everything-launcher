/**
 * Windows integration for single apps: desktop and Start menu shortcuts to an
 * app's .exe stub, and showing the stub in Explorer. Stubs are built by the
 * desktop app (`electron . --build-stubs`), on demand when one is missing.
 *
 * Only shortcuts the launcher created (recorded in shortcuts.json) are ever
 * removed, and an existing shortcut of the same name is never overwritten.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import config from '../lib/config.cjs';

const { ROOT, DATA_DIR, ELECTRON_EXE, stubPath, safeFileName } = config;
const RECORDS_FILE = path.join(DATA_DIR, 'shortcuts.json');
const START_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Everything Apps');

export const supported = process.platform === 'win32';

let records = {};
try {
  records = JSON.parse(readFileSync(RECORDS_FILE, 'utf8'));
} catch {
  /* none yet */
}

function saveRecords() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 1));
}

/** Runs a PowerShell script; values go in through environment variables, never into the script text. */
function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)),
    );
  });
}

let desktopDir = null;
async function desktop() {
  // Ask Windows: the Desktop is often redirected (OneDrive, a different drive).
  desktopDir ||= (await powershell("[Environment]::GetFolderPath('Desktop')")).trim();
  return desktopDir;
}

// One stub build at a time.
let building = Promise.resolve();
function buildStubs(args) {
  const run = () =>
    new Promise((resolve, reject) => {
      if (!existsSync(ELECTRON_EXE)) return reject(new Error('Electron is not installed. Run npm install in the everything-launcher folder.'));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(ELECTRON_EXE, [ROOT, '--build-stubs', ...args], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(output.split(/\r?\n/).filter((l) => l && !/cache/i.test(l)).slice(-2).join(' ') || 'Building the app launcher failed.'))));
    });
  building = building.then(run, run);
  return building;
}

/** Builds every missing stub in the background (after an update adds apps, or on first run). */
export function buildMissingStubs() {
  if (!supported || !existsSync(ELECTRON_EXE)) return;
  buildStubs(['--missing']).catch(() => {});
}

/** Rebuilds all stubs (pruning ones for removed apps) in the background. */
export function rebuildStubs() {
  if (!supported || !existsSync(ELECTRON_EXE) || !existsSync(config.STUBS_DIR)) return buildMissingStubs();
  buildStubs([]).catch(() => {});
}

async function ensureStub(app) {
  const stub = stubPath(app.name);
  if (!existsSync(stub)) await buildStubs([`--only=${app.id}`]);
  if (!existsSync(stub)) throw new Error(`Could not build ${path.basename(stub)}.`);
  return stub;
}

export function status(app) {
  if (!supported) return null;
  const rec = records[app.id] || {};
  return {
    desktop: Boolean(rec.desktop && existsSync(rec.desktop)),
    start: Boolean(rec.start && existsSync(rec.start)),
  };
}

/** A free shortcut path: "<Name>.lnk", or "<Name> (Everything).lnk" when the user already has a "<Name>.lnk". */
function freeLinkPath(dir, name) {
  const base = safeFileName(name);
  for (const candidate of [`${base}.lnk`, `${base} (Everything).lnk`, `${base} (Everything 2).lnk`]) {
    if (!existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
  }
  throw new Error(`There are already shortcuts named ${base} in ${dir}.`);
}

export async function add(app, where) {
  if (!supported) throw new Error('Shortcuts are only available on Windows.');
  const current = status(app);
  if (current[where]) return current;
  const stub = await ensureStub(app);
  const dir = where === 'desktop' ? await desktop() : START_DIR;
  mkdirSync(dir, { recursive: true });
  const link = freeLinkPath(dir, app.name);
  await powershell(
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = $env:TARGET; $s.WorkingDirectory = $env:WORKDIR; $s.IconLocation = "$($env:TARGET),0"; $s.Description = $env:DESC; $s.Save()',
    { LNK: link, TARGET: stub, WORKDIR: ROOT, DESC: app.alternativeTo ? `${app.name}: alternative to ${app.alternativeTo}` : app.name },
  );
  records[app.id] = { ...records[app.id], [where]: link };
  saveRecords();
  return status(app);
}

export function remove(app, where) {
  if (!supported) throw new Error('Shortcuts are only available on Windows.');
  const link = records[app.id]?.[where];
  if (link) rmSync(link, { force: true });
  if (records[app.id]) delete records[app.id][where];
  saveRecords();
  return status(app);
}

export async function reveal(app) {
  if (!supported) throw new Error('Only available on Windows.');
  const stub = await ensureStub(app);
  // explorer.exe parses its own command line: the quotes must reach it as-is.
  spawn('explorer.exe', [`/select,"${stub}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
}
