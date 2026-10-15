/**
 * Apps whose files are saved on this computer instead of in Puter's cloud.
 *
 * For these apps the launcher serves an adapter that replaces puter.fs and
 * Puter's file pickers with local versions backed by the local cloud folder.
 * Sign-in, AI and everything else still go to Puter.
 *
 *   cloudPaths   paths that must stay in the real Puter cloud, matched against the
 *                path as the app passes it (e.g. files a Puter worker has to read)
 */
export const LOCAL_CLOUD_APPS = {
  'photo-studio': {
    // Collaboration: the identity file a room worker reads to verify you, and the worker's source.
    cloudPaths: [/^photo-studio\/(identity|collab)\//],
  },
};

export function localCloudSettings(appId) {
  const env = process.env.EVERYTHING_LOCAL_APPS;
  if (env === 'none') return null;
  if (env && env !== 'default') {
    // EVERYTHING_LOCAL_APPS=photo-studio,notes (or "all") overrides the list above.
    const ids = env.split(',').map((s) => s.trim());
    if (!ids.includes('all') && !ids.includes(appId)) return null;
  }
  return LOCAL_CLOUD_APPS[appId] ?? (env && env !== 'default' ? { cloudPaths: [] } : null);
}
