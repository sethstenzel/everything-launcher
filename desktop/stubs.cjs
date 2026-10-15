/**
 * Windows icons and .exe stubs.
 *
 *   npm run stubs      builds apps\<App name>.exe for every app, plus apps\Everything.exe
 *
 * A stub is a few lines of C#, compiled with the C# compiler that ships with
 * Windows (.NET Framework 4), with the app's icon embedded. Double-clicking it
 * starts Everything with --open=<app>, which opens just that app (or hands it
 * to Everything when it is already running). Stubs find Everything next to
 * themselves (..\node_modules\electron) and fall back to the folder they were
 * built in, so a copy on the Desktop still works.
 */
const { nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, EVERYTHING_DIR, STUBS_DIR, stubPath } = require('../lib/config.cjs');

const LAUNCHER_ICON = path.join(__dirname, 'icon.png');
const execFileAsync = promisify(execFile);

/** A Windows .ico holding PNG images, which Windows Vista and later read directly. */
function writeIco(srcPng, file) {
  const src = nativeImage.createFromPath(srcPng);
  const { width } = src.getSize();
  const sizes = [256, 128, 64, 48, 32, 24, 16].filter((s) => s <= Math.max(width, 16));
  const images = sizes.map((s) => ({ size: s, png: src.resize({ width: s, height: s, quality: 'best' }).toPNG() }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));
}

function findCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const csc = path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

// JSON string literals are valid C# string literals for anything we embed (quotes, backslashes, \uXXXX).
const cs = (text) => JSON.stringify(text);

function stubSource({ name, description, args }) {
  return `using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle(${cs(name)})]
[assembly: AssemblyDescription(${cs(description)})]
[assembly: AssemblyProduct("Everything")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const string Name = ${cs(name)};
    const string Args = ${cs(args)};
    const string BuiltIn = ${cs(ROOT)};

    static string Electron(string root)
    {
        return Path.Combine(root, @"node_modules\\electron\\dist\\electron.exe");
    }

    [STAThread]
    static int Main()
    {
        // Normally this stub sits in <launcher>\\apps; a copy elsewhere falls back to where it was built.
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..")).TrimEnd('\\\\');
        if (!File.Exists(Electron(root))) root = BuiltIn;
        if (!File.Exists(Electron(root)))
        {
            MessageBox.Show("Everything could not be found at\\n" + root + "\\n\\nRun \\"npm install\\" and then \\"npm run stubs\\" in the everything-launcher folder.", Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        ProcessStartInfo start = new ProcessStartInfo(Electron(root), "\\"" + root + "\\"" + Args);
        start.UseShellExecute = false;
        start.WorkingDirectory = root;
        Process.Start(start);
        return 0;
    }
}
`;
}

async function buildStubs({ only = null, missing = false } = {}) {
  if (process.platform !== 'win32') {
    console.log('Executable stubs are Windows-only. Use `npm run desktop -- --open=<app>` elsewhere.');
    return;
  }
  const csc = findCsc();
  if (!csc) throw new Error('The .NET Framework C# compiler (csc.exe) was not found. It ships with Windows 10 and 11.');
  const { loadCatalog } = await import(pathToFileURL(path.join(ROOT, 'server', 'catalog.mjs')).href);
  const apps = loadCatalog(EVERYTHING_DIR).filter((a) => a.launchable);
  if (!apps.length) throw new Error(`No apps found in ${EVERYTHING_DIR}.`);

  const all = [
    { name: 'Everything', description: 'Everything: all the apps', args: '', icon: LAUNCHER_ICON },
    ...apps.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.alternativeTo ? `${a.name} (alternative to ${a.alternativeTo})` : a.name,
      args: ` --open=${a.id}`,
      icon: path.join(EVERYTHING_DIR, 'src', a.id, 'icon-128.png'),
    })),
  ];
  // only: one app's stub. missing: just the stubs that don't exist yet. Neither: rebuild all and prune.
  const stubs = only ? all.filter((s) => s.id === only) : missing ? all.filter((s) => !fs.existsSync(stubPath(s.name))) : all;
  if (only && !stubs.length) throw new Error(`No launchable app "${only}".`);

  fs.mkdirSync(STUBS_DIR, { recursive: true });
  if (!only && !missing) {
    // Drop stubs for apps that were renamed or removed upstream.
    const keep = new Set(all.map((s) => path.basename(stubPath(s.name)).toLowerCase()));
    for (const f of fs.readdirSync(STUBS_DIR)) {
      if (f.toLowerCase().endsWith('.exe') && !keep.has(f.toLowerCase())) {
        fs.rmSync(path.join(STUBS_DIR, f), { force: true });
        console.log(`Removed apps\\${f}`);
      }
    }
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'everything-stubs-'));
  let built = 0;
  try {
    for (const [i, stub] of stubs.entries()) {
      const source = path.join(work, `stub${i}.cs`);
      fs.writeFileSync(source, stubSource(stub));
      const args = ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/r:System.Windows.Forms.dll', `/out:${stubPath(stub.name)}`];
      if (fs.existsSync(stub.icon)) {
        const ico = path.join(work, `stub${i}.ico`);
        writeIco(stub.icon, ico);
        args.push(`/win32icon:${ico}`);
      }
      args.push(source);
      try {
        await execFileAsync(csc, args, { windowsHide: true });
        built++;
        console.log(`Built apps\\${path.basename(stubPath(stub.name))}`);
      } catch (e) {
        console.error(`Could not build ${stub.name}: ${String(e.stdout || e.message).trim()}`);
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`${built} of ${stubs.length} stubs built in ${STUBS_DIR}`);
  if (built < stubs.length) throw new Error('Some stubs could not be built.');
}

module.exports = { writeIco, buildStubs };
