/**
 * Watches the Everything repository: whether it is there, and how far it is
 * behind its upstream. Can update it (fast-forward only) or clone it.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Never stop to ask for credentials: a background check must fail, not hang.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
const MAX_COMMITS = 300;
const LOG_LINES = 60;

function git(cwd, args, timeout = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: ENV, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('Git is not installed (or not on PATH).'));
      const detail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
      reject(new Error(detail || err.message));
    });
  });
}

/** https://github.com/owner/repo for GitHub/GitLab/Bitbucket remotes, else null. */
function webUrl(remote) {
  const m = remote.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

export function createRepo({ dir, remote, onUpdated = () => {}, intervalMs = 15 * 60 * 1000 }) {
  const state = {
    path: dir,
    remote,
    exists: false,
    busy: null, // 'checking' | 'pulling' | 'cloning'
    branch: null,
    upstream: null,
    head: null,
    ahead: 0,
    behind: 0,
    commits: [], // what an update would bring in, oldest first
    truncated: false,
    dirty: false,
    webUrl: null,
    checkedAt: null,
    updatedAt: null,
    error: null,
    log: [],
  };

  const isRepo = () => existsSync(path.join(dir, '.git'));

  async function task(kind, fn) {
    if (state.busy) return;
    state.busy = kind;
    state.error = null;
    try {
      await fn();
    } catch (e) {
      state.error = e.message;
    } finally {
      state.busy = null;
    }
  }

  /** Reads branch, ahead/behind and the incoming commits from what was last fetched. */
  async function inspect() {
    state.exists = isRepo();
    if (!state.exists) return;
    state.branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    state.head = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
    state.dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
    try {
      state.upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    } catch {
      Object.assign(state, { upstream: null, ahead: 0, behind: 0, commits: [], truncated: false });
      throw new Error(state.branch === 'HEAD' ? 'The Everything repo is not on a branch (detached HEAD).' : `Branch "${state.branch}" has no upstream branch to compare with.`);
    }
    const [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/).map(Number);
    state.ahead = ahead;
    state.behind = behind;
    const out = behind ? await git(dir, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e', 'HEAD..@{u}']) : '';
    state.commits = out
      .split('\x1e')
      .map((rec) => rec.replace(/^\s+/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, short, author, date, subject, body = ''] = rec.split('\x1f');
        return { hash, short, author, date, subject, body: body.trim() };
      })
      .reverse();
    state.truncated = behind > state.commits.length;
    try {
      state.webUrl = webUrl(await git(dir, ['remote', 'get-url', state.upstream.split('/')[0]]));
    } catch {
      state.webUrl = null;
    }
  }

  function check() {
    return task('checking', async () => {
      state.exists = isRepo();
      if (!state.exists) return;
      let fetchError = null;
      try {
        await git(dir, ['fetch', '--quiet', '--prune'], 2 * 60 * 1000);
      } catch (e) {
        fetchError = e;
      }
      await inspect();
      state.checkedAt = new Date().toISOString();
      if (fetchError) throw new Error(`Could not reach the remote: ${fetchError.message}`);
    });
  }

  function pull() {
    return task('pulling', async () => {
      if (!isRepo()) throw new Error('The Everything repo is missing.');
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      await git(dir, ['pull', '--ff-only', '--quiet']);
      const changed = (await git(dir, ['diff', '--name-only', before, 'HEAD'])).split(/\r?\n/).filter(Boolean);
      await inspect();
      state.checkedAt = state.updatedAt = new Date().toISOString();
      onUpdated({ changed });
    });
  }

  function clone() {
    return task('cloning', async () => {
      if (isRepo()) return;
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and is not a git repository.`);
      state.log = [`> git clone ${remote}`];
      await new Promise((resolve, reject) => {
        const child = spawn('git', ['clone', '--progress', remote, dir], { env: ENV, windowsHide: true });
        const onData = (d) => {
          // git redraws progress lines with \r; keep only the latest of each.
          for (const line of String(d).split(/\r?\n|\r/)) {
            const text = line.trim();
            if (!text) continue;
            const key = text.split(':')[0];
            const last = state.log[state.log.length - 1];
            if (last && last.split(':')[0] === key && /\d+%/.test(text)) state.log[state.log.length - 1] = text;
            else state.log.push(text);
          }
          if (state.log.length > LOG_LINES) state.log.splice(0, state.log.length - LOG_LINES);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('Git is not installed (or not on PATH).') : e));
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(state.log.slice(-2).join('\n') || `git clone failed (${code})`))));
      });
      await inspect();
      state.checkedAt = state.updatedAt = new Date().toISOString();
      onUpdated({ changed: null });
    });
  }

  state.exists = isRepo();
  check();
  setInterval(check, intervalMs).unref();

  return {
    check,
    pull,
    clone,
    snapshot: () => ({ ...state, log: state.log.slice(-LOG_LINES) }),
  };
}
