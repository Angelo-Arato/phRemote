import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['node_modules', 'dist', '.cache', '.git', '.agents', '.codex', '__pycache__']);
const sourceDirectories = ['desktop', 'server', 'scripts', 'tests'];

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(location));
    else if (entry.isFile() && /\.(?:mjs|cjs|js|py)$/.test(entry.name)) result.push(location);
  }
  return result;
}

const sources = (await Promise.all(sourceDirectories.map(name => files(path.join(root, name))))).flat().sort();
let checked = 0;
for (const filename of sources) {
  const python = filename.endsWith('.py');
  let executable = process.execPath;
  let args = ['--check', filename];
  if (python) {
    executable = process.platform === 'win32' ? 'python' : 'python3';
    args = ['-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), filename=sys.argv[1])', filename];
  }
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(`Syntax check failed: ${path.relative(root, filename)}`);
    console.error(result.error?.message || result.stderr || result.stdout);
    process.exitCode = 1;
  } else checked++;
}
if (!process.exitCode) console.log(`Syntax verified for ${checked} JavaScript and Python source files.`);
