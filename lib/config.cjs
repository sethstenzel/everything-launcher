/**
 * Where things live. Shared by the launcher server (ESM) and the desktop app (CommonJS).
 *
 *   EVERYTHING_REPO      path to the Everything checkout (default: ../everything next to this repo)
 *   EVERYTHING_REMOTE    where to clone it from when it is missing
 *   EVERYTHING_DATA_DIR  per-user settings: favorites, app ports, window positions
 */
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const EVERYTHING_DIR = path.resolve(process.env.EVERYTHING_REPO || path.join(ROOT, '..', 'everything'));

const EVERYTHING_REMOTE = process.env.EVERYTHING_REMOTE || 'https://github.com/HeyPuter/everything.git';

const DATA_DIR = path.resolve(
  process.env.EVERYTHING_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'Everything')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Everything')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'everything')),
);

module.exports = { ROOT, EVERYTHING_DIR, EVERYTHING_REMOTE, DATA_DIR };
