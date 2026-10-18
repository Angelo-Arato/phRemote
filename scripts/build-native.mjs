import { spawnSync } from 'node:child_process';
import { chmod, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

export async function buildNative() {
  if (process.platform !== 'darwin') {
    console.log('Native input: Windows uses the bundled PowerShell helper; Linux uses the bundled Python helper. No compilation on this platform.');
    return null;
  }
  const cache = path.join(root, '.cache', 'native');
  const modules = path.join(root, '.cache', 'swift-module-cache');
  await mkdir(cache, { recursive: true });
  await mkdir(modules, { recursive: true });
  const sdkResult = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' });
  if (sdkResult.error || sdkResult.status !== 0) throw new Error('Xcode Command Line Tools and the macOS SDK are required to build the input helper.');
  const sdk = sdkResult.stdout.trim();
  const source = path.join(root, 'desktop', 'native', 'phremote-input-macos.swift');
  const slices = [];
  for (const arch of ['arm64', 'x86_64']) {
    const slice = path.join(cache, `phremote-input-macos-${arch}`);
    console.log(`Compiling macOS input helper: ${arch}, minimum macOS 13.0`);
    run('xcrun', ['swiftc', '-O', '-sdk', sdk, '-target', `${arch}-apple-macosx13.0`, '-module-cache-path', modules, source, '-o', slice]);
    slices.push(slice);
  }
  const universal = path.join(cache, 'phremote-input-macos-universal');
  run('xcrun', ['lipo', '-create', ...slices, '-output', universal]);
  const architectures = spawnSync('xcrun', ['lipo', universal, '-archs'], { encoding: 'utf8' });
  if (architectures.status !== 0 || !['arm64', 'x86_64'].every(arch => architectures.stdout.trim().split(/\s+/).includes(arch))) {
    throw new Error('The compiled input helper must contain both arm64 and x86_64 slices.');
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', universal]);
  await chmod(universal, 0o755);
  const destination = path.join(root, 'desktop', 'native', 'phremote-input-macos');
  await rename(universal, destination);
  console.log(`Universal input helper ready: ${path.relative(root, destination)}`);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNative().catch(error => { console.error(error.message); process.exitCode = 1; });
}
