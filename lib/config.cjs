/**
 * Where things live. Shared by the launcher server (ESM) and the desktop app (CommonJS).
 *
 *   EVERYTHING_REPO      path to the Everything checkout (default: ../everything next to this repo)
 *   EVERYTHING_REMOTE    where to clone it from when it is missing
 *   EVERYTHING_BACKUP    backup of every version seen (default: ../everything-backup.git)
 *   EVERYTHING_DATA_DIR  per-user settings: favorites, app ports, window positions
 */
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const EVERYTHING_DIR = path.resolve(process.env.EVERYTHING_REPO || path.join(ROOT, '..', 'everything'));

const EVERYTHING_REMOTE = process.env.EVERYTHING_REMOTE || 'https://github.com/HeyPuter/everything.git';

// A bare git repository holding every version of Everything ever seen (see server/repo.mjs).
const EVERYTHING_BACKUP = path.resolve(process.env.EVERYTHING_BACKUP || path.join(EVERYTHING_DIR, '..', 'everything-backup.git'));

const DATA_DIR = path.resolve(
  process.env.EVERYTHING_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'Everything')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Everything')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'everything')),
);

// Windows .exe stubs, one per app (built by `npm run stubs`).
const STUBS_DIR = path.join(ROOT, 'apps');

/** apps\Photo Studio.exe for "Photo Studio" (characters Windows forbids in file names are dropped). */
function stubPath(name) {
  return path.join(STUBS_DIR, `${safeFileName(name)}.exe`);
}

function safeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
}

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

module.exports = { ROOT, EVERYTHING_DIR, EVERYTHING_REMOTE, EVERYTHING_BACKUP, DATA_DIR, STUBS_DIR, ELECTRON_EXE, stubPath, safeFileName };
