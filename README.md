# Everything Launcher

A desktop launcher and dashboard for [HeyPuter/everything](https://github.com/HeyPuter/everything), the open-source collection of apps that replace Office, Slack, Photoshop, AutoCAD and many more.

Everything ships as about fifty separate Vite apps, each with its own `npm install` and `npm run dev`. This launcher puts them all on one dashboard, installs and starts each one when you open it, and opens it in its own native window.

It lives in its own repository on purpose: the Everything checkout stays an untouched clone, so pulling upstream updates never conflicts with anything here.

## Features

- **Dashboard of every app** by category with icons, descriptions and "alternative to", read from the Everything README so new apps appear automatically.
- **One click to run**: on first open an app's dependencies are installed (`npm ci`), its worker is built if it has one, its dev server starts, and the window switches to the app.
- **Native windows** (Electron): each app gets its own window, taskbar button and icon, and remembers its size and position. Closing an app's window stops its dev server.
- **Favorites**: pin apps to a section at the top.
- **Updates**: the launcher fetches the Everything repo every 15 minutes and shows how many commits you're behind. Click the notice to read the incoming commit messages (oldest first) and update with a fast-forward pull. Running apps whose files changed offer a Restart.
- **Version history**: the History tab lists recent versions; switch back to an earlier one if a change broke something, and Update now returns to the latest.
- **Backup**: a separate git repository keeps every version of Everything ever seen, even if upstream later rewrites or wipes its history (see [Backup](#backup)).
- **Per-app .exe launchers** (Windows): `apps/<App>.exe` opens one app directly, with its own icon. Each tile's ⋯ menu adds a desktop shortcut or a Start menu entry, or shows the .exe in Explorer. Pin a running app from its taskbar button to pin its .exe.
- **Local files** (Photo Studio so far): saving and opening use a folder on this computer instead of Puter's cloud, while sign-in and AI still use Puter. See [Local files](#local-files).
- **First-run setup**: if the Everything repo isn't there yet, the dashboard offers to clone it.
- **Stable ports**: every app always runs on the same port, so data it keeps in the browser is still there next time.
- **Search** with `/`, live status (installing, starting, running, error) with logs, and Stop / Stop all.

## Requirements

- [Node.js](https://nodejs.org/) 22.12 or newer (npm comes with it)
- [Git](https://git-scm.com/)
- Windows, macOS or Linux. Desktop shortcuts are created on Windows only; elsewhere use `npm run desktop`.

## Setup

Clone this repo next to (or instead of first needing) the Everything repo:

```
git/
├── everything/            ← git clone https://github.com/HeyPuter/everything.git
└── everything-launcher/   ← this repo
```

```sh
git clone https://github.com/sethstenzel/everything-launcher.git
cd everything-launcher
npm install
npm run shortcuts      # Windows: adds "Everything" here, on the Desktop and in the Start menu
npm run stubs          # Windows: builds apps/<App>.exe launchers (the launcher also builds missing ones itself)
npm run desktop        # or double-click the Everything shortcut
```

If `../everything` doesn't exist yet, the dashboard offers to download it.

To use the browser instead of the desktop app, run `npm start` and open <http://localhost:4000/>.

## Configuration

Environment variables, all optional:

| Variable | Default | |
| --- | --- | --- |
| `EVERYTHING_REPO` | `../everything` | Path to the Everything checkout |
| `EVERYTHING_REMOTE` | `https://github.com/HeyPuter/everything.git` | Where to clone it from when missing |
| `EVERYTHING_BACKUP` | `../everything-backup.git` | Backup of every version of Everything seen |
| `EVERYTHING_CLOUD_DIR` | `./cloud` | The local cloud: where apps with local files save |
| `EVERYTHING_LOCAL_APPS` | (the list in `server/local-cloud/apps.mjs`) | `all`, `none`, or app ids like `photo-studio,notes` |
| `EVERYTHING_DATA_DIR` | `%APPDATA%\Everything` (Windows), `~/Library/Application Support/Everything` (macOS), `~/.config/everything` (Linux) | Favorites, app ports, window positions, launcher log |
| `PORT` | `4000` | Dashboard port for `npm start` |

## How updates work

The launcher runs `git fetch` in the Everything repo when it starts and every 15 minutes, then compares your branch with its upstream. Nothing changes on disk until you click **Update now**, which runs `git pull --ff-only`. If you have local commits or changes that would be overwritten, it stops and tells you instead of merging. An update that would delete a large share of the files asks for confirmation first. After an update, apps whose dependencies changed are reinstalled the next time they start.

**History** lists the last 100 versions of the upstream branch. *Use this version* moves the Everything repo to that commit (`git reset --hard`, refused if there are local changes); the header then shows that you're on an older version, and **Update to latest** brings it back.

## Backup

Everything is open source today; this keeps it that way on your machine. `../everything-backup.git` is a bare git repository that collects every commit, branch and tag the launcher has seen, refreshed after every update check and before every update or version switch:

- Nothing is ever removed from it, and git's garbage collection is told never to prune.
- Branches only move forward. If upstream rewrites or rolls back a branch (or moves a tag), the backup keeps the original and stores the new version beside it under `refs/rewritten/`, and the dashboard warns you. Such an update is also refused in the Everything repo itself.

Restore it with:

```sh
git clone ../everything-backup.git everything
```

## Local files

The Everything apps save to Puter's cloud. For apps on the local-files list (`server/local-cloud/apps.mjs`, currently Photo Studio), the launcher makes them save on this computer instead, without changing the Everything repo:

- The launcher starts the app's own Vite dev server through `server/local-cloud/vite-runner.mjs`, which adds one plugin to the app's unchanged config.
- The plugin puts an adapter (`server/local-cloud/shim.js`) at the top of the page. It replaces `puter.fs` and Puter's file pickers with local versions: Open, Save As and folder pickers become a file dialog for the local cloud folder, and reads and writes go to it.
- Sign-in, AI, key-value storage, workers and everything else stay Puter's own. Paths an app needs in the real cloud (Photo Studio's collaboration identity files, which a Puter worker reads) are listed per app and still go to Puter.

The local cloud lives in `cloud/` in this repo (ignored by git, so your files are never committed). It's laid out like a Puter home folder: `Documents/`, `Desktop/`, `Pictures/`, …, and `AppData/<app>/` for an app's own data. Each app's dialogs start in its own folder, `Documents/<App name>/`; the ⋯ menu on its tile has **Show saved files**. Files Photo Studio keeps in its own Puter folder (its libraries, when you're signed in) go to `AppData/photo-studio/`.

The file API is served on the app's own origin and only answers that page: other hosts, cross-site requests and requests without the adapter's header are refused, and paths can't leave the local cloud folder.

## Security notes

- The dashboard and every app dev server listen on `127.0.0.1` only.
- The launcher's API only answers requests addressed to `localhost`/`127.0.0.1`, and state-changing requests require a JSON content type and a matching origin, so other websites can't drive it.
- App windows are sandboxed web pages with no Node.js access. Links to other sites open in your default browser. Camera, microphone and similar permissions are granted only to the local apps and Puter.
- Apps are installed with `npm ci`, exactly as pinned by each app's lockfile.

## Project layout

```
server/index.mjs     launcher server: dashboard, app processes, API
server/catalog.mjs   reads the app list from the Everything repo
server/repo.mjs      git: update checks, updates, version switching, backup, first-time clone
server/shortcuts.mjs desktop and Start menu shortcuts to app .exe launchers (Windows)
server/local-cloud/  local files: per-app settings, Vite runner and plugin, file API, page adapter
public/              dashboard and launch pages
desktop/main.cjs     Electron app: dashboard window, app windows, shortcuts
desktop/stubs.cjs    builds the per-app .exe launchers and Windows icons
lib/config.cjs       paths and settings shared by the server and the desktop app
```

## License

MIT. The Everything apps themselves are © Puter Technologies Inc. under their own license; this project is not affiliated with Puter.
