import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, chmod, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export class DeviceStore {
  constructor(path) { this.path = path; this.devices = new Map(); this.writes = Promise.resolve(); }

  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let source;
    try { source = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const data = JSON.parse(source);
    if (data.version !== 1 || !Array.isArray(data.devices)) throw new Error('Invalid device store');
    for (const record of data.devices) {
      if (!/^\d{9}$/.test(record.id) || !/^[0-9a-f]{64}$/.test(record.tokenHash) || typeof record.name !== 'string' || this.devices.has(record.id)) {
        throw new Error('Invalid device record');
      }
      this.devices.set(record.id, record);
    }
    await chmod(this.path, 0o600);
  }

  persist() {
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = join(dirname(this.path), `.${basename(this.path)}.${randomBytes(12).toString('hex')}.tmp`);
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(JSON.stringify({ version: 1, devices: [...this.devices.values()] }));
        await file.sync();
        await file.close(); file = null;
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally {
        if (file) await file.close();
        await rm(temporary, { force: true });
      }
    });
    return this.writes;
  }

  async create(name) {
    let id;
    do { id = String(randomInt(100000000, 1000000000)); } while (this.devices.has(id));
    const token = randomBytes(32).toString('base64url');
    const record = { id, name, tokenHash: tokenHash(token) };
    this.devices.set(id, record);
    try { await this.persist(); }
    catch (error) { this.devices.delete(id); throw error; }
    return { record, token };
  }

  authenticate(id, token) {
    const record = this.devices.get(id);
    const actual = Buffer.from(tokenHash(token), 'hex');
    const expected = Buffer.from(record?.tokenHash ?? '0'.repeat(64), 'hex');
    return timingSafeEqual(actual, expected) && record ? record : null;
  }

  async updateName(record, name) {
    if (record.name === name) return;
    const previous = record.name;
    record.name = name;
    try { await this.persist(); }
    catch (error) { record.name = previous; throw error; }
  }
}
