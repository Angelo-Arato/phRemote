import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRelay } from '../server/relay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'phremote-smoke-'));
const outputDir = path.join(root, 'research', 'verification');
await mkdir(outputDir, { recursive: true });
const packaged = process.argv.includes('--packaged');
const output = path.join(outputDir, packaged ? 'desktop-packaged' : 'desktop-development');
const relay = await createRelay({ storePath: path.join(temp, 'devices.json') });
await relay.listen({ host: '127.0.0.1', port: 0 });
const address = relay.address();
const require = createRequire(import.meta.url);
let executable = require('electron');
let args = [root];
if (packaged) {
  const distribution = path.join(root, 'dist', 'phRemote-' + process.platform + '-' + process.arch);
  executable = process.platform === 'darwin' ? path.join(distribution, 'phRemote.app', 'Contents', 'MacOS', 'phRemote') :
    path.join(distribution, process.platform === 'win32' ? 'phRemote.exe' : 'phremote');
  args = [];
}
const env = {
  ...process.env,
  PHREMOTE_PROFILE: path.join(temp, 'profile'),
  PHREMOTE_SMOKE_OUTPUT: output,
  PHREMOTE_SMOKE_RELAY: 'ws://127.0.0.1:' + address.port + '/ws'
};
delete env.ELECTRON_RUN_AS_NODE;
let child;
try {
  child = spawn(executable, args, { cwd: root, env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Desktop smoke test timed out')); }, 45000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.equal(result.code, 0, 'Electron must exit successfully: ' + (result.signal || result.code));
  const report = JSON.parse(await readFile(output + '.json', 'utf8'));
  assert.equal(report.online, true);
  assert.equal(report.hasId, true);
  assert.equal(report.contacts, 1);
  assert.equal(report.bridge, 'object');
  assert.ok(report.buttons > 10);
  const png = await readFile(output + '.png');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  console.log('Desktop smoke passed: preload, renderer, real relay registration, address book and preview.');
  console.log(path.relative(root, output + '.png'));
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await relay.close();
}
