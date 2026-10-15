# Everything Launcher

A desktop launcher and dashboard for [HeyPuter/everything](https://github.com/HeyPuter/everything), the open-source collection of apps that replace Office, Slack, Photoshop, AutoCAD and many more.

Everything ships as about fifty separate Vite apps, each with its own `npm install` and `npm run dev`. This launcher puts them all on one dashboard, installs and starts each one when you open it, and opens it in its own native window.

It lives in its own repository on purpose: the Everything checkout stays an untouched clone, so pulling upstream updates never conflicts with anything here.

## Features

- **Dashboard of every app** by category with icons, descriptions and "alternative to", read from the Everything README so new apps appear automatically.
- **One click to run**: on first open an app's dependencies are installed (`npm ci`), its worker is built if it has one, its dev server starts, and the window switches to the app.
- **Native windows** (Electron): each app gets its own window, taskbar button and icon, and remembers its size and position. Closing an app's window stops its dev server.
- **Favorites**: pin apps to a section at the top.
- **Updates**: the launcher fetches the Everything repo every 15 minutes and shows how many commits you're behind. Click the notice to read the incoming commit messages (oldest first) and update with a fast-forward pull. Running apps whose files changed offer "Restart to update".
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
| `EVERYTHING_DATA_DIR` | `%APPDATA%\Everything` (Windows), `~/Library/Application Support/Everything` (macOS), `~/.config/everything` (Linux) | Favorites, app ports, window positions, launcher log |
| `PORT` | `4000` | Dashboard port for `npm start` |

## How updates work

The launcher runs `git fetch` in the Everything repo when it starts and every 15 minutes, then compares your branch with its upstream. Nothing changes on disk until you click **Update now**, which runs `git pull --ff-only`. If you have local commits or changes that would be overwritten, it stops and tells you instead of merging. After an update, apps whose dependencies changed are reinstalled the next time they start.

## Security notes

- The dashboard and every app dev server listen on `127.0.0.1` only.
- The launcher's API only answers requests addressed to `localhost`/`127.0.0.1`, and state-changing requests require a JSON content type and a matching origin, so other websites can't drive it.
- App windows are sandboxed web pages with no Node.js access. Links to other sites open in your default browser. Camera, microphone and similar permissions are granted only to the local apps and Puter.
- Apps are installed with `npm ci`, exactly as pinned by each app's lockfile.

## Project layout

```
server/index.mjs     launcher server: dashboard, app processes, API
server/catalog.mjs   reads the app list from the Everything repo
server/repo.mjs      git: update checks, fast-forward updates, first-time clone
public/              dashboard and launch pages
desktop/main.cjs     Electron app: dashboard window, app windows, shortcuts
lib/config.cjs       paths and settings shared by the server and the desktop app
```

## License

MIT. The Everything apps themselves are © Puter Technologies Inc. under their own license; this project is not affiliated with Puter.
