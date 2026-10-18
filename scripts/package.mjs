import { spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative } from './build-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const productName = 'phRemote';
const bundleId = 'it.phremote.desktop';
const platforms = new Set(['darwin', 'win32', 'linux']);
const architectures = new Set(['arm64', 'x64']);
const copyOptions = { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true };

function options(args) {
  const result = { platform: process.platform, arch: process.arch };
  for (let index = 0; index < args.length; index++) {
    const match = /^(--platform|--arch)(?:=(.+))?$/.exec(args[index]);
    if (!match) throw new Error(`Unknown argument: ${args[index]}. Usage: npm run package -- [--platform darwin|win32|linux] [--arch arm64|x64]`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${match[1]}`);
    result[match[1].slice(2)] = value;
  }
  if (!platforms.has(result.platform) || !architectures.has(result.arch)) throw new Error('Supported platforms: darwin, win32, linux; architectures: arm64, x64.');
  return result;
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

function setPlistString(document, key, value) {
  const matcher = new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`);
  const replacement = `<key>${key}</key>\n\t<string>${xml(value)}</string>`;
  if (matcher.test(document)) return document.replace(matcher, replacement);
  return document.replace(/<dict>/, `<dict>\n\t${replacement}`);
}

function removePlistKey(document, key) {
  const marker = `<key>${key}</key>`;
  const start = document.indexOf(marker);
  if (start < 0) return document;
  const valueStart = start + marker.length;
  const rest = document.slice(valueStart);
  const scalar = /^\s*(?:<(string|integer|real|data|date)>[\s\S]*?<\/\1>|<(?:true|false)\s*\/>)/.exec(rest);
  if (scalar) return document.slice(0, start) + document.slice(valueStart + scalar[0].length);
  const container = /^\s*<(dict|array)>/.exec(rest);
  if (!container) throw new Error(`Cannot update Info.plist key ${key}`);
  const tokens = /<\/?(?:dict|array)>/g;
  let depth = 0;
  for (const token of rest.matchAll(tokens)) {
    depth += token[0][1] === '/' ? -1 : 1;
    if (depth === 0) return document.slice(0, start) + document.slice(valueStart + token.index + token[0].length);
  }
  throw new Error(`Unterminated Info.plist key ${key}`);
}

async function updateMacBundle(bundle, version) {
  const info = path.join(bundle, 'Contents', 'Info.plist');
  let document = await readFile(info, 'utf8');
  for (const [key, value] of Object.entries({
    CFBundleName: productName, CFBundleDisplayName: productName, CFBundleExecutable: productName,
    CFBundleIdentifier: bundleId, CFBundleShortVersionString: version, CFBundleVersion: version,
    LSMinimumSystemVersion: '13.0', LSApplicationCategoryType: 'public.app-category.productivity',
    NSScreenCaptureUsageDescription: 'Condividi lo schermo solo nelle sessioni remote che approvi su questo computer.',
    NSAccessibilityUsageDescription: 'Consenti mouse e tastiera remoti solo nelle sessioni che approvi.',
  })) document = setPlistString(document, key, value);
  for (const key of ['ElectronAsarIntegrity', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription']) document = removePlistKey(document, key);
  await writeFile(info, document);
  await rename(path.join(bundle, 'Contents', 'MacOS', 'Electron'), path.join(bundle, 'Contents', 'MacOS', productName));
  const frameworks = path.join(bundle, 'Contents', 'Frameworks');
  for (const entry of await readdir(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^Electron Helper(?: \([A-Za-z]+\))?\.app$/.test(entry.name)) continue;
    const original = entry.name.slice(0, -4);
    const renamed = original.replace(/^Electron/, productName);
    const helper = path.join(frameworks, entry.name);
    const helperInfo = path.join(helper, 'Contents', 'Info.plist');
    let helperDocument = await readFile(helperInfo, 'utf8');
    const suffix = original.match(/\(([A-Za-z]+)\)/)?.[1].toLowerCase();
    for (const [key, value] of Object.entries({
      CFBundleName: renamed, CFBundleDisplayName: renamed, CFBundleExecutable: renamed,
      CFBundleIdentifier: `${bundleId}.helper${suffix ? '.' + suffix : ''}`,
      CFBundleShortVersionString: version, CFBundleVersion: version,
    })) helperDocument = setPlistString(helperDocument, key, value);
    await writeFile(helperInfo, helperDocument);
    await rename(path.join(helper, 'Contents', 'MacOS', original), path.join(helper, 'Contents', 'MacOS', renamed));
    await rename(helper, path.join(frameworks, `${renamed}.app`));
  }
}

async function runtime(target, electronVersion) {
  const installed = path.join(root, 'node_modules', 'electron', 'dist');
  if (target.platform === process.platform && target.arch === process.arch && await exists(installed)) {
    const version = (await readFile(path.join(installed, 'version'), 'utf8')).trim();
    if (version !== electronVersion) throw new Error(`Installed Electron runtime ${version} differs from dependency ${electronVersion}; run npm exec install-electron.`);
    return installed;
  }
  const { downloadArtifact } = await import('@electron/get');
  const { default: extract } = await import('@electron-internal/extract-zip');
  const checksums = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'checksums.json'), 'utf8'));
  console.log(`Downloading and verifying Electron ${electronVersion} for ${target.platform}/${target.arch}`);
  const archive = await downloadArtifact({
    version: electronVersion, artifactName: 'electron', platform: target.platform, arch: target.arch,
    cacheRoot: path.join(root, '.cache', 'electron-downloads'), checksums,
  });
  const extracted = path.join(root, '.cache', `electron-${electronVersion}-${target.platform}-${target.arch}`);
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await extract(archive, { dir: extracted });
  return extracted;
}

async function packageApp() {
  const target = options(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const electronManifest = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
  const electronVersion = electronManifest.version;
  if (electronVersion !== '44.9.0') throw new Error(`Expected Electron 44.9.0, received ${electronVersion}`);
  if (target.platform === 'darwin') {
    if (process.platform === 'darwin') await buildNative();
    await access(path.join(root, 'desktop', 'native', 'phremote-input-macos'), constants.R_OK);
  }
  const runtimeDirectory = await runtime(target, electronVersion);
  const distribution = path.join(root, 'dist', `${productName}-${target.platform}-${target.arch}`);
  const stage = path.join(root, 'dist', `.${productName}-${target.platform}-${target.arch}-${process.pid}`);
  await mkdir(path.dirname(stage), { recursive: true });
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage);
  try {
    await cp(runtimeDirectory, stage, copyOptions);
    let resources;
    let executable;
    if (target.platform === 'darwin') {
      const bundle = path.join(stage, `${productName}.app`);
      await rename(path.join(stage, 'Electron.app'), bundle);
      await updateMacBundle(bundle, manifest.version);
      resources = path.join(bundle, 'Contents', 'Resources');
      executable = path.join(bundle, 'Contents', 'MacOS', productName);
    } else {
      resources = path.join(stage, 'resources');
      executable = path.join(stage, target.platform === 'win32' ? `${productName}.exe` : 'phremote');
      await rename(path.join(stage, target.platform === 'win32' ? 'electron.exe' : 'electron'), executable);
    }
    await rm(path.join(resources, 'default_app.asar'), { force: true });
    await rm(path.join(resources, 'default_app'), { recursive: true, force: true });
    const appDirectory = path.join(resources, 'app');
    await mkdir(appDirectory, { recursive: true });
    await cp(path.join(root, 'desktop'), path.join(appDirectory, 'desktop'), copyOptions);
    await cp(path.join(root, 'desktop', 'native'), path.join(resources, 'native'), copyOptions);
    await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({
      name: manifest.name, productName, version: manifest.version, description: manifest.description,
      private: true, type: 'module', main: 'desktop/main.mjs',
    }, null, 2) + '\n');
    if (target.platform !== 'win32') await chmod(executable, 0o755);
    let signature = 'unsigned';
    if (target.platform === 'darwin' && process.platform === 'darwin') {
      for (const native of [path.join(resources, 'native', 'phremote-input-macos'), path.join(appDirectory, 'desktop', 'native', 'phremote-input-macos')]) run('/usr/bin/codesign', ['--force', '--sign', '-', native]);
      const bundle = path.join(stage, `${productName}.app`);
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundle]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
      signature = 'ad-hoc';
    }
    if (target.platform === 'linux') {
      await writeFile(path.join(stage, 'phremote.desktop'), '[Desktop Entry]\nType=Application\nName=phRemote\nComment=Remote desktop with local approval\nExec=phremote\nTerminal=false\nCategories=Network;RemoteAccess;\n');
    }
    await writeFile(path.join(stage, 'distribution.json'), JSON.stringify({
      productName, version: manifest.version, electronVersion, ...target, signature,
      notarized: false, installer: false,
    }, null, 2) + '\n');
    await writeFile(path.join(stage, 'READ-ME.txt'), [
      `phRemote ${manifest.version} — ${target.platform}/${target.arch}`,
      'Portable development build. This folder is the application, not an installer.',
      `Signature: ${signature}. No Developer ID, Microsoft signing certificate, or notarization is included.`,
      'Keep the entire folder together. Configure the same secure WSS relay on both computers.',
      'Connections require the generated session password and explicit approval on the sharing computer.',
      target.platform === 'darwin' ? 'macOS 13+: grant Screen Recording and Accessibility to phRemote when needed.' :
        target.platform === 'linux' ? 'Linux: Python 3 and X11/XTest are required for remote input; Wayland is view-only. Run as your normal desktop user.' :
          'Windows: the bundled PowerShell helper runs as your current user; elevated windows and the secure desktop cannot be controlled.',
      '',
    ].join('\n'));
    await rm(distribution, { recursive: true, force: true });
    await rename(stage, distribution);
    const archive = distribution + '.tar.gz';
    const temporaryArchive = archive + `.${process.pid}.tmp`;
    const packed = spawnSync('tar', ['-czf', temporaryArchive, '-C', path.dirname(distribution), path.basename(distribution)], {
      cwd: root, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    if (packed.error || packed.status !== 0) {
      await rm(temporaryArchive, { force: true });
      throw new Error('The application folder is ready, but creating its archive requires the system tar command.');
    }
    await rm(archive, { force: true });
    await rename(temporaryArchive, archive);
    console.log(`Packaged ${path.relative(root, distribution)} (${signature}, not notarized)`);
    console.log(`Archive preserving executable permissions and symbolic links: ${path.relative(root, archive)}`);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

packageApp().catch(error => { console.error(error.message); process.exitCode = 1; });
