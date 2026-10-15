/**
 * Watches the Everything repository: whether it is there and how far it is
 * behind its upstream. Updates it (fast-forward only), switches it to an
 * earlier version, clones it when missing, and keeps a backup of it.
 *
 * The backup is a bare git repository that only ever grows: every commit,
 * branch and tag seen upstream or locally is copied into it, nothing is ever
 * deleted, and a branch or tag that upstream rewrites is kept as it was, with
 * the rewritten version stored next to it under refs/rewritten/. Restore with
 * `git clone <backup> everything`.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Never stop to ask for credentials: a background check must fail, not hang.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
const MAX_COMMITS = 300;
const HISTORY_COMMITS = 100;
const LOG_LINES = 60;

/** Runs git; resolves with { code, stdout, stderr } whatever the exit code. */
function gitRaw(cwd, args, timeout = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: ENV, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') return reject(new Error('Git is not installed (or not on PATH).'));
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function git(cwd, args, timeout) {
  const r = await gitRaw(cwd, args, timeout);
  if (r.code === 0) return r.stdout;
  const messages = r.stderr.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('hint:'));
  const important = messages.filter((l) => /^(fatal|error):/.test(l));
  throw new Error((important.length ? important : messages).slice(-3).join('\n') || `git ${args[0]} failed (${r.code})`);
}

/** https://github.com/owner/repo for GitHub/GitLab/Bitbucket remotes, else null. */
function webUrl(remote) {
  const m = remote.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}` : null;
}

const LOG_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e';
function parseLog(out) {
  return out
    .split('\x1e')
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash, short, author, date, subject, body = ''] = rec.split('\x1f');
      return { hash, short, author, date, subject, body: body.trim() };
    });
}

const lines = (out) => out.split(/\r?\n/).filter(Boolean);

export function createRepo({ dir, remote, backupDir = null, stateFile = null, onUpdated = () => {}, intervalMs = 15 * 60 * 1000 }) {
  let saved = {};
  try {
    saved = stateFile ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  } catch {
    /* first run */
  }

  const state = {
    path: dir,
    remote,
    exists: false,
    busy: null, // 'checking' | 'pulling' | 'switching' | 'cloning'
    branch: null,
    upstream: null,
    head: null,
    headHash: null,
    ahead: 0,
    behind: 0,
    diverged: false, // local and upstream both have commits the other lacks (e.g. upstream rewrote history)
    commits: [], // what an update would bring in, oldest first
    truncated: false,
    incoming: null, // { deleted, total, mass } files an update would delete
    dirty: false,
    webUrl: null,
    checkedAt: null,
    updatedAt: null,
    rolledBack: saved.rolledBack || null, // { from, fromShort, at } after switching to an older version
    backup: { path: backupDir, exists: false, updatedAt: null, size: null, error: null, rewritten: [] },
    error: null,
    log: [],
  };

  const isRepo = () => existsSync(path.join(dir, '.git'));

  function persist() {
    if (!stateFile) return;
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ rolledBack: state.rolledBack }, null, 1));
    } catch {
      /* not worth failing over */
    }
  }

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
    state.headHash = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    state.head = state.headHash.slice(0, 8);
    state.dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
    try {
      state.upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    } catch {
      Object.assign(state, { upstream: null, ahead: 0, behind: 0, diverged: false, commits: [], truncated: false, incoming: null });
      throw new Error(state.branch === 'HEAD' ? 'The Everything repo is not on a branch (detached HEAD).' : `Branch "${state.branch}" has no upstream branch to compare with.`);
    }
    const [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/).map(Number);
    state.ahead = ahead;
    state.behind = behind;
    state.diverged = ahead > 0 && behind > 0;
    state.commits = behind ? parseLog(await git(dir, ['log', `--max-count=${MAX_COMMITS}`, LOG_FORMAT, 'HEAD..@{u}'])).reverse() : [];
    state.truncated = behind > state.commits.length;
    if (behind) {
      // An update that deletes a large share of the files deserves a second look before it is applied.
      const deleted = lines(await git(dir, ['diff', '--name-only', '--diff-filter=D', 'HEAD', '@{u}'])).length;
      const total = lines(await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])).length;
      state.incoming = { deleted, total, mass: deleted >= 200 || (total > 0 && deleted / total >= 0.2) };
    } else state.incoming = null;
    if (state.rolledBack && behind === 0) {
      state.rolledBack = null;
      persist();
    }
    try {
      state.webUrl = webUrl(await git(dir, ['remote', 'get-url', state.upstream.split('/')[0]]));
    } catch {
      state.webUrl = null;
    }
  }

  // ---------------------------------------------------------------- backup

  async function readBackupInfo() {
    const b = state.backup;
    b.exists = Boolean(backupDir && existsSync(path.join(backupDir, 'HEAD')));
    if (!b.exists) return;
    const fetchHead = path.join(backupDir, 'FETCH_HEAD');
    b.updatedAt = existsSync(fetchHead) ? statSync(fetchHead).mtime.toISOString() : null;
    const counts = Object.fromEntries(lines(await git(backupDir, ['count-objects', '-v'])).map((l) => l.split(': ')));
    b.size = (Number(counts['size-pack'] || 0) + Number(counts.size || 0)) * 1024;
    b.rewritten = lines(await git(backupDir, ['for-each-ref', '--format=%(refname)', 'refs/rewritten/'])).map((ref) => {
      const [, stamp, ...rest] = ref.replace('refs/rewritten/', '').match(/^([^/]+)\/(.*)$/) || [];
      return { ref, at: stamp ? new Date(Number(stamp)).toISOString() : null, name: rest.join('/') };
    });
  }

  /**
   * Copies everything new from the Everything repo into the backup. Branches
   * only move forward; anything upstream rewrote is stored beside the original.
   */
  async function backup() {
    if (!backupDir || !isRepo()) return;
    const b = state.backup;
    try {
      if (!existsSync(path.join(backupDir, 'HEAD'))) {
        mkdirSync(backupDir, { recursive: true });
        await git(backupDir, ['init', '--bare', '--quiet']);
        // Keep every object and ref history forever, even what nothing points to any more.
        for (const [key, value] of [
          ['gc.pruneExpire', 'never'],
          ['gc.reflogExpire', 'never'],
          ['gc.reflogExpireUnreachable', 'never'],
          ['core.logAllRefUpdates', 'always'],
        ]) {
          await git(backupDir, ['config', key, value]);
        }
        writeFileSync(path.join(backupDir, 'description'), `Backup of ${remote}, kept by everything-launcher. Restore with: git clone "${backupDir}" everything\n`);
      }
      const remoteName = (state.upstream || 'origin/').split('/')[0] || 'origin';
      // 1. Bring everything over under a scratch namespace.
      await git(backupDir, [
        'fetch',
        '--quiet',
        '--no-auto-gc',
        dir,
        `+refs/remotes/${remoteName}/*:refs/incoming/heads/*`,
        `^refs/remotes/${remoteName}/HEAD`,
        '+refs/tags/*:refs/incoming/tags/*',
        '+refs/heads/*:refs/incoming/local/*',
      ]);
      // 2. Move each ref into place: new refs and fast-forwards only.
      const readRefs = async (prefix) =>
        new Map(lines(await git(backupDir, ['for-each-ref', '--format=%(objectname) %(refname)', prefix])).map((l) => l.split(' ').reverse()));
      const incoming = await readRefs('refs/incoming/');
      const current = await readRefs('refs/');
      const stamp = Date.now();
      const updates = [];
      for (const [ref, sha] of incoming) {
        const rest = ref.replace('refs/incoming/', ''); // heads/main, tags/v1, local/main
        const target = `refs/${rest}`;
        const old = current.get(target);
        const isAncestor = async (a, b) => (await gitRaw(backupDir, ['merge-base', '--is-ancestor', a, b])).code === 0;
        if (!old) updates.push(`update ${target} ${sha}`);
        else if (old === sha) continue;
        else if (!rest.startsWith('tags/') && (await isAncestor(old, sha))) updates.push(`update ${target} ${sha}`); // moved forward
        else if (rest.startsWith('local/') && (await isAncestor(sha, old))) continue; // a local rollback: the backup already has all of it
        else updates.push(`update refs/rewritten/${stamp}/${rest} ${sha}`); // rewritten, moved back or retagged: keep both
      }
      for (const ref of incoming.keys()) updates.push(`delete ${ref}`);
      if (updates.length) await gitStdin(backupDir, ['update-ref', '--stdin'], updates.join('\n') + '\n');
      // A bare repo's HEAD names the branch `git clone` checks out.
      if (state.branch && state.branch !== 'HEAD') await git(backupDir, ['symbolic-ref', 'HEAD', `refs/heads/${state.upstream?.split('/').slice(1).join('/') || state.branch}`]);
      b.error = null;
    } catch (e) {
      b.error = e.message;
      throw e;
    } finally {
      await readBackupInfo().catch(() => {});
    }
  }

  function gitStdin(cwd, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, env: ENV, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `git ${args[0]} failed (${code})`))));
      child.stdin.end(input);
    });
  }

  // ---------------------------------------------------------------- operations

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
      // Back up whatever was just fetched, before anyone upstream can take it away.
      await backup().catch(() => {});
      if (fetchError) throw new Error(`Could not reach the remote: ${fetchError.message}`);
    });
  }

  async function backupFirst() {
    try {
      await backup();
    } catch (e) {
      throw new Error(`The backup could not be updated, so nothing was changed: ${e.message}`);
    }
  }

  function pull() {
    return task('pulling', async () => {
      if (!isRepo()) throw new Error('The Everything repo is missing.');
      if (state.diverged) throw new Error('The upstream history no longer contains your version, so it can’t be updated by fast-forward. Nothing was changed; the backup keeps both histories.');
      await backupFirst();
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      await git(dir, ['pull', '--ff-only', '--quiet']);
      const changed = lines(await git(dir, ['diff', '--name-only', before, 'HEAD']));
      await inspect();
      state.checkedAt = state.updatedAt = new Date().toISOString();
      onUpdated({ changed });
    });
  }

  /** The upstream branch's recent history (first parent), newest first, for picking a version. */
  async function history() {
    if (!isRepo()) return { commits: [], head: null };
    const ref = state.upstream || 'HEAD';
    const commits = parseLog(await git(dir, ['log', '--first-parent', `--max-count=${HISTORY_COMMITS}`, LOG_FORMAT, ref]));
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    return { head, upstream: state.upstream, commits: commits.map(({ body, ...c }) => ({ ...c, current: c.hash === head })) };
  }

  /** Switches the Everything repo to a version from its upstream history (older or newer). */
  function useVersion(hash) {
    return task('switching', async () => {
      if (!isRepo()) throw new Error('The Everything repo is missing.');
      if (!/^[0-9a-f]{40}$/.test(hash || '')) throw new Error('Pick a version from the history.');
      if (!state.upstream) throw new Error('The Everything repo has no upstream branch.');
      if ((await gitRaw(dir, ['merge-base', '--is-ancestor', hash, '@{u}'])).code !== 0) throw new Error('That version is not part of the upstream history.');
      if ((await git(dir, ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('The Everything repo has local changes to tracked files; switching versions would discard them.');
      if (state.ahead > 0) throw new Error('The Everything repo has local commits that are not upstream; switching versions would orphan them.');
      await backupFirst();
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      const upstreamHash = (await git(dir, ['rev-parse', '@{u}'])).trim();
      await git(dir, ['reset', '--hard', '--quiet', hash]);
      const changed = lines(await git(dir, ['diff', '--name-only', before, 'HEAD']));
      // Remember the newest version seen, so the dashboard can say what was rolled back from.
      state.rolledBack = hash === upstreamHash ? null : (state.rolledBack ?? { from: before, fromShort: before.slice(0, 8), at: new Date().toISOString() });
      persist();
      await inspect();
      state.updatedAt = new Date().toISOString();
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
      await backup().catch(() => {});
      onUpdated({ changed: null });
    });
  }

  state.exists = isRepo();
  readBackupInfo().catch(() => {});
  check();
  setInterval(check, intervalMs).unref();

  return {
    check,
    pull,
    clone,
    history,
    useVersion,
    snapshot: () => ({ ...state, backup: { ...state.backup }, log: state.log.slice(-LOG_LINES) }),
  };
}
