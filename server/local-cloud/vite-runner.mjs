#!/usr/bin/env node
/**
 * Starts an app's Vite dev server with the local-cloud plugin added. Run by
 * the launcher with the app's folder as the working directory:
 *
 *   EVERYTHING_APP_ID, EVERYTHING_APP_NAME, EVERYTHING_PORT, EVERYTHING_HOST, EVERYTHING_CLOUD_DIR
 *
 * Uses the app's own Vite and its own vite.config (unchanged); the plugin is
 * merged in through Vite's inline config. Prints the same "Local:" line as the
 * Vite CLI, which the launcher waits for.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localCloudPlugin } from './plugin.mjs';
import { localCloudSettings } from './apps.mjs';

const appDir = process.cwd();
const { EVERYTHING_APP_ID: appId, EVERYTHING_APP_NAME: appName, EVERYTHING_PORT: port, EVERYTHING_HOST: host, EVERYTHING_CLOUD_DIR: cloudDir } = process.env;

/** The ESM entry of the app's own copy of Vite. */
function viteEntry() {
  const dir = path.join(appDir, 'node_modules', 'vite');
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let entry = pkg.exports?.['.'] ?? pkg.module ?? pkg.main;
  while (entry && typeof entry === 'object') entry = entry.import ?? entry.default;
  if (!entry) throw new Error(`Can't find Vite's entry point in ${dir}`);
  return pathToFileURL(path.join(dir, entry)).href;
}

const { createServer } = await import(viteEntry());
const settings = localCloudSettings(appId) ?? { cloudPaths: [] };
const server = await createServer({
  root: appDir,
  server: { port: Number(port), host, strictPort: true, open: false },
  plugins: [localCloudPlugin({ appId, appName, root: cloudDir, cloudPaths: settings.cloudPaths })],
});
await server.listen();
server.printUrls();
console.log(`  Local cloud: ${cloudDir}`);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close().finally(() => process.exit(0)));
