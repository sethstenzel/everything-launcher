/**
 * Apps whose data is kept on this computer instead of in Puter's cloud.
 *
 * For these apps the launcher serves an adapter (shim.js) that gives the app a
 * local puter.fs, local file pickers and (with kv) a local puter.kv. Sign-in,
 * AI, workers, peer, hosting and email stay Puter's own.
 *
 *   cloudPaths    fs paths that stay in Puter, tested against the path as the app passes it.
 *                 Needed for anything Puter itself or someone else reads: files a deployed
 *                 worker runs or reads, identity files whose read URL goes to a worker,
 *                 published/hosted folders, share links and calendar feeds.
 *                 (Every app's mailbox, /<user>/.mail, always stays in Puter.)
 *   kv            keep puter.kv local too (default true)
 *   cloudKv       keys that stay in Puter's KV: worker configs and secrets, collaboration
 *                 credentials, team/workspace membership that must follow the account.
 *   localAccount  the app only loads or saves while signed in, so let it run signed out as a
 *                 local user. Signing in stays Puter's own, and Puter asks for it whenever
 *                 something (AI, sharing, teams) really needs the account.
 *
 * Not listed, and left exactly as they are:
 *   help-desk                   multi-user by design: even a "local" desk is copied to a Puter
 *                               worker that reads its attachments from Puter
 *   chess, checkers, backgammon nothing in Puter's cloud (games are in browser storage; Puter is
 *                               only for online play)
 *   3d                          uses Puter only for its AI assistant
 */
const local = (settings = {}) => ({ kv: true, localAccount: true, cloudPaths: [], cloudKv: [], ...settings });

export const LOCAL_CLOUD_APPS = {
  // ---- Office
  spreadsheet: local({ cloudPaths: [/(^|\/)spreadsheet\/(collab|identity)\//], cloudKv: [/^spreadsheet-collab-/] }),
  documents: local({ cloudPaths: [/(^|\/)documents-collab\//, /(^|\/)Documents\/\.published\//], cloudKv: [/^documents-collab-/] }),
  presentation: local(),
  pdf: local(),
  notes: local({ cloudPaths: [/(^|\/)notes\/published\//] }), // share links are opened by other people
  records: local(),
  whiteboard: local({
    cloudPaths: [/(^|\/)whiteboard\/whiteboard-worker\.js$/, /(^|\/)whiteboard\/identity\//, /(^|\/)whiteboard\/(shared|ai)\//],
    cloudKv: [/^whiteboard-collaboration-/, /^whiteboard-organization-v1$/],
  }),

  // ---- Collaboration
  meetings: local({ localAccount: false }), // only preferences; meetings themselves are peer-to-peer through Puter
  teamchat: local({ localAccount: false, cloudPaths: [/(^|\/)teamchat-worker\.js$/], cloudKv: [/^tcu:/] }), // chats live on Puter workers
  email: local({ localAccount: false }), // the mailbox is Puter's; local: read/star marks and attachment pickers
  contacts: local(),
  calendar: local({ cloudPaths: [/(^|\/)rsvp-worker\.js$/], cloudKv: [/^cal:(mail|rsvp|book|invite):/] }),
  signatures: local({ cloudPaths: [/(^|\/)signatures-data\/(?!templates(\/|$))/, /(^|\/)sign-worker\.js$/], cloudKv: [/^sig:worker:/, /^sig:doc:/] }),

  // ---- Creative tools
  'photo-studio': local({ kv: false, localAccount: false, cloudPaths: [/^photo-studio\/(identity|collab)\//] }),
  'video-studio': local({ cloudPaths: [/(^|\/)video-studio\/(worker|review-identity|reviews)\//], cloudKv: [/^video-studio-review-/] }),
  'vector-studio': local({ cloudPaths: [/^(?:\/[^/]+\/AppData\/[^/]+\/)?collab\//], cloudKv: [/^vector-studio-collab-/] }),
  'audio-studio': local(),
  'music-studio': local(),

  // ---- Engineering
  cad: local(),
  parametric: local(),
  circuits: local(),
  'building-design': local(),

  // ---- Productivity
  projects: local(),
  wiki: local({ cloudPaths: [/(^|\/)wiki\/identity\//, /(^|\/)wiki\/wiki-worker\.js$/], cloudKv: [/^wiki-collaboration-/] }),
  survey: local({ cloudPaths: [/(^|\/)collector-worker(-[0-9a-f]+)?\.js$/], cloudKv: [/^sv:worker$/] }), // responses go to a Puter worker
  tasks: local({ cloudPaths: [/(^|\/)tasks-data\/(shares|collab)\//, /(^|\/)tasks-data\/tasks\.ics$/] }),
  'time-tracking': local(),

  // ---- Finance
  accounting: local(),
  invoicing: local({ cloudPaths: [/(^|\/)invoicing-data\/public(\/|$)/] }), // shared invoices are hosted pages
  expense: local(),
  'cap-table': local(),

  // ---- Business
  crm: local(),
  contracts: local({ cloudPaths: [/(^|\/)contract-manager\/calendar(\/|$)/] }), // hosted calendar feed
  pos: local(),
  inventory: local(),
  assets: local(),
  hiring: local({ cloudPaths: [/(^|\/)hiring-public(\/|$)/] }), // hosted job pages
  shifts: local({ cloudPaths: [/(^|\/)schedule-share(\/|$)/] }), // hosted schedule
  // Team ("staff access") mode runs on a Puter worker: its bundle and the workspace list stay in Puter.
  childcare: local({ cloudPaths: [/(^|\/)childcare-team-worker\.js$/], cloudKv: [/^cc1:workspaces$/] }),
  'field-service': local({ cloudPaths: [/(^|\/)field-service-team-worker\.js$/], cloudKv: [/^fs1:workspaces$/] }),
  legal: local({ cloudPaths: [/(^|\/)legal-team-worker\.js$/], cloudKv: [/^lg1:workspaces$/] }),
  fleet: local({ cloudPaths: [/(^|\/)fleet-team-worker\.js$/], cloudKv: [/^fl1:workspaces$/] }),
  'property-management': local({ cloudPaths: [/(^|\/)property-management-team-worker\.js$/], cloudKv: [/^pm1:workspaces$/] }),

  // ---- Developer tools and games
  'api-client': local(), // collections shared with you (other people's paths) still come from Puter
  solitaire: local(),
  sudoku: local(),
};

/** The settings for an app, or null when it keeps using Puter's cloud. EVERYTHING_LOCAL_APPS overrides the list. */
export function localCloudSettings(appId) {
  const env = process.env.EVERYTHING_LOCAL_APPS;
  if (env === 'none') return null;
  if (env && env !== 'default') {
    // EVERYTHING_LOCAL_APPS=photo-studio,notes (or "all")
    const ids = env.split(',').map((s) => s.trim());
    if (!ids.includes('all') && !ids.includes(appId)) return null;
  }
  return LOCAL_CLOUD_APPS[appId] ?? (env && env !== 'default' ? local() : null);
}
