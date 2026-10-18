import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { createRelay } from '../server/relay.mjs';

class Client {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) this.messages.push(message);
      else { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  next(type, timeout = 1500) {
    const predicate = typeof type === 'function' ? type : (message) => message.type === type;
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${String(type)}`)); }, timeout);
      this.waiters.push(waiter);
    });
  }
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'phremote-relay-'));
  const storePath = join(dir, 'devices.json');
  const relay = await createRelay({ storePath, ...options });
  await relay.listen({ port: 0 });
  const url = `ws://127.0.0.1:${relay.address().port}/ws`;
  const clients = [];
  async function connect() {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const client = new Client(socket); clients.push(client); return client;
  }
  async function device(name) {
    const client = await connect(); client.send({ type: 'register', name });
    client.identity = await client.next('registered'); return client;
  }
  t.after(async () => {
    for (const client of clients) client.socket.close();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { relay, url, connect, device, storePath, dir };
}

async function pendingPair(host, viewer) {
  viewer.send({ type: 'invite', hostId: host.identity.deviceId });
  const invitation = await viewer.next('invited');
  const incoming = await host.next('incoming');
  assert.equal(incoming.requestId, invitation.requestId);
  assert.equal(incoming.viewerId, viewer.identity.deviceId);
  assert.equal(incoming.hostId, host.identity.deviceId);
  return invitation.requestId;
}

async function approvePair(host, viewer) {
  const requestId = await pendingPair(host, viewer);
  host.send({ type: 'challenge', requestId, challenge: { salt: 'opaque-salt', nonce: 'opaque-nonce', publicKey: 'opaque-host-key' } });
  const challenge = await viewer.next('challenge');
  assert.equal(challenge.peerId, host.identity.deviceId);
  viewer.send({ type: 'proof', requestId, proof: { publicKey: 'opaque-viewer-key', mac: 'opaque-proof' } });
  const proof = await host.next('proof');
  assert.equal(proof.peerId, viewer.identity.deviceId);
  host.send({ type: 'accept', requestId });
  const [hostSession, viewerSession] = await Promise.all([host.next('session'), viewer.next('session')]);
  assert.equal(hostSession.sessionId, viewerSession.sessionId);
  assert.equal(hostSession.requestId, requestId);
  assert.equal(hostSession.role, 'host');
  assert.equal(viewerSession.role, 'viewer');
  return hostSession.sessionId;
}

test('HTTP health is minimal, private paths are not served, browser origins require explicit allowlist', async (t) => {
  const { url } = await fixture(t, { allowedOrigins: ['https://phremote.example'] });
  const httpUrl = url.replace('ws:', 'http:').replace('/ws', '');
  const health = await fetch(`${httpUrl}/health`);
  assert.deepEqual(await health.json(), { ok: true, protocolVersion: 1 });
  for (const path of ['/server/data/devices.json', '/../../etc/passwd', '/']) assert.equal((await fetch(httpUrl + path)).status, 404);
  const blocked = await rawConnect(url, { origin: 'https://untrusted.example' });
  assert.match(blocked.headers, /^HTTP\/1.1 403/); blocked.socket.destroy();
  const allowed = await rawConnect(url, { origin: 'https://phremote.example' });
  assert.match(allowed.headers, /^HTTP\/1.1 101/); allowed.socket.destroy();
});

test('approved pairing relays opaque data only to its authenticated session peer', async (t) => {
  const { device, storePath } = await fixture(t);
  const host = await device('Host'); const viewer = await device('Viewer'); const outsider = await device('Other');
  assert.match(host.identity.deviceId, /^\d{9}$/);
  assert.match(host.identity.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  const stored = await readFile(storePath, 'utf8');
  assert.ok(!stored.includes(host.identity.deviceToken));
  assert.equal(JSON.parse(stored).devices.find((record) => record.id === host.identity.deviceId).tokenHash, createHash('sha256').update(host.identity.deviceToken).digest('hex'));
  if (process.platform !== 'win32') assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  const requestId = await pendingPair(host, viewer);
  host.send({ type: 'accept', requestId });
  assert.equal((await host.next('error')).code, 'proof-required');
  viewer.send({ type: 'data', sessionId: requestId, payload: { data: 'unapproved' } });
  assert.equal((await viewer.next('error')).code, 'no-session');
  outsider.send({ type: 'accept', requestId });
  assert.equal((await outsider.next('error')).code, 'unknown-request');
  viewer.send({ type: 'challenge', requestId, challenge: {} });
  assert.equal((await viewer.next('error')).code, 'forbidden');
  host.send({ type: 'challenge', requestId, challenge: { salt: 'opaque', publicKey: 'key', nonce: 'nonce' } });
  assert.deepEqual((await viewer.next('challenge')).challenge, { salt: 'opaque', publicKey: 'key', nonce: 'nonce' });
  viewer.send({ type: 'proof', requestId, proof: { publicKey: 'key', mac: 'proof' } });
  assert.deepEqual((await host.next('proof')).proof, { publicKey: 'key', mac: 'proof' });
  host.send({ type: 'accept', requestId });
  const hostSession = await host.next('session'); const viewerSession = await viewer.next('session');
  assert.equal(hostSession.sessionId, viewerSession.sessionId);
  const sessionId = hostSession.sessionId;
  outsider.send({ type: 'data', sessionId, payload: { data: 'injected' } });
  assert.equal((await outsider.next('error')).code, 'no-session');
  const payload = { v: 1, seq: 1, data: 'ciphertext+tag' };
  viewer.send({ type: 'data', sessionId, payload });
  assert.deepEqual(await host.next('data'), { type: 'data', sessionId, peerId: viewer.identity.deviceId, payload });
  host.send({ type: 'data', sessionId, payload: { v: 1, seq: 1, data: 'return-ciphertext' } });
  assert.equal((await viewer.next('data')).peerId, host.identity.deviceId);
  viewer.send({ type: 'disconnect', sessionId });
  assert.equal((await host.next('disconnected')).reason, 'peer-requested');
  await viewer.next('disconnected');
  viewer.send({ type: 'data', sessionId, payload });
  assert.equal((await viewer.next('error')).code, 'no-session');
});

test('host rejection and viewer cancellation release devices for a fresh invitation', async (t) => {
  const { device } = await fixture(t);
  const host = await device('Host'); const viewer = await device('Viewer');
  let requestId = await pendingPair(host, viewer);
  host.send({ type: 'reject', requestId });
  assert.equal((await viewer.next('rejected')).reason, 'host-rejected'); await host.next('rejected');
  viewer.send({ type: 'proof', requestId, proof: {} });
  assert.equal((await viewer.next('error')).code, 'unknown-request');
  requestId = await pendingPair(host, viewer);
  viewer.send({ type: 'cancel', requestId });
  assert.equal((await host.next('canceled')).reason, 'viewer-canceled'); await viewer.next('canceled');
  await approvePair(host, viewer);
});

test('a device ID cannot be impersonated, and a valid token replaces its old connection', async (t) => {
  const { device, connect } = await fixture(t);
  const host = await device('Host'); const viewer = await device('Viewer'); const attacker = await connect();
  attacker.send({ type: 'register', name: 'Impostor', deviceId: host.identity.deviceId, deviceToken: randomBytes(32).toString('base64url') });
  assert.equal((await attacker.next('error')).code, 'auth-failed');
  attacker.send({ type: 'invite', hostId: viewer.identity.deviceId });
  assert.equal((await attacker.next('error')).code, 'not-registered');
  const sessionId = await approvePair(host, viewer);
  const replacement = await connect();
  replacement.send({ type: 'register', name: 'Host again', deviceId: host.identity.deviceId, deviceToken: host.identity.deviceToken });
  assert.equal((await replacement.next('registered')).deviceId, host.identity.deviceId);
  assert.equal((await host.closed).code, 4001);
  const disconnected = await viewer.next('disconnected');
  assert.equal(disconnected.sessionId, sessionId);
  assert.equal(disconnected.reason, 'peer-disconnected');
  replacement.identity = host.identity;
  await approvePair(replacement, viewer);
});

test('device credentials survive a complete relay restart', async (t) => {
  const { relay, device, storePath } = await fixture(t);
  const original = await device('Persistent');
  await relay.close();
  const restarted = await createRelay({ storePath });
  await restarted.listen({ port: 0 });
  t.after(() => restarted.close());
  const socket = new WebSocket(`ws://127.0.0.1:${restarted.address().port}/ws`);
  await once(socket, 'open');
  const replacement = new Client(socket);
  replacement.send({ type: 'register', name: 'Persistent', deviceId: original.identity.deviceId, deviceToken: original.identity.deviceToken });
  const registered = await replacement.next('registered');
  assert.equal(registered.deviceId, original.identity.deviceId);
  assert.equal(registered.deviceToken, undefined);
  socket.close();
});

test('pending requests expire and disconnected hosts are removed immediately', async (t) => {
  const { device } = await fixture(t, { pendingTimeoutMs: 90, sweepIntervalMs: 10 });
  const host = await device('Host'); const viewer = await device('Viewer');
  const requestId = await pendingPair(host, viewer);
  assert.equal((await viewer.next('expired')).requestId, requestId); await host.next('expired');
  await pendingPair(host, viewer);
  host.socket.close(); await host.closed;
  assert.equal((await viewer.next('canceled')).reason, 'peer-disconnected');
  viewer.send({ type: 'invite', hostId: host.identity.deviceId });
  assert.equal((await viewer.next('error')).code, 'host-unavailable');
});

test('invitation and registration attempts have enforceable rate limits', async (t) => {
  const { device, connect } = await fixture(t, { inviteLimit: 2, registerLimit: 3 });
  const host = await device('Host'); const viewer = await device('Viewer');
  for (let i = 0; i < 2; i++) {
    const requestId = await pendingPair(host, viewer);
    host.send({ type: 'reject', requestId }); await host.next('rejected'); await viewer.next('rejected');
  }
  viewer.send({ type: 'invite', hostId: host.identity.deviceId });
  assert.equal((await viewer.next('error')).code, 'rate-limited');
  const extra = await connect();
  extra.send({ type: 'register', name: 'Attempt', deviceId: host.identity.deviceId, deviceToken: randomBytes(32).toString('base64url') });
  assert.equal((await extra.next('error')).code, 'auth-failed');
  extra.send({ type: 'register', name: 'Attempt' });
  assert.equal((await extra.next('error')).code, 'rate-limited');
});

function clientFrame(opcode, value, { fin = true, masked = true } = {}) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const extra = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = (fin ? 128 : 0) | opcode;
  header[1] = (masked ? 128 : 0) | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(payload.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4); mask.copy(header, 2 + extra);
  const encoded = Buffer.from(payload);
  for (let i = 0; i < encoded.length; i++) encoded[i] ^= mask[i & 3];
  return Buffer.concat([header, encoded]);
}

async function rawConnect(url, { origin } = {}) {
  const address = new URL(url);
  const socket = net.connect({ host: address.hostname, port: Number(address.port) });
  const reader = new ByteReader(socket);
  await once(socket, 'connect');
  socket.write(`GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
  let headers = '';
  while (!headers.endsWith('\r\n\r\n')) headers += (await reader.read(1)).toString();
  return { socket, reader, headers };
}

class ByteReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0); this.waiters = []; this.ended = false;
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); for (const resolve of this.waiters.splice(0)) resolve(); });
    socket.on('error', () => {});
    socket.on('close', () => { this.ended = true; for (const resolve of this.waiters.splice(0)) resolve(); });
  }
  async read(size) {
    while (this.buffer.length < size) {
      if (this.ended) throw new Error('Socket ended before expected bytes');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { const i = this.waiters.indexOf(wake); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('Raw socket read timeout')); }, 1500);
        const wake = () => { clearTimeout(timer); resolve(); };
        this.waiters.push(wake);
      });
    }
    const value = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return value;
  }
  async frame() {
    const header = await this.read(2);
    let length = header[1] & 127;
    if (length === 126) length = (await this.read(2)).readUInt16BE();
    if (length === 127) length = Number((await this.read(8)).readBigUInt64BE());
    return { opcode: header[0] & 15, payload: await this.read(length) };
  }
}

test('WebSocket supports masked fragmentation and interleaved ping, and rejects protocol violations', async (t) => {
  const { url } = await fixture(t);
  const raw = await rawConnect(url); t.after(() => raw.socket.destroy());
  const message = JSON.stringify({ type: 'register', name: 'Fragmented' });
  raw.socket.write(clientFrame(1, message.slice(0, 11), { fin: false }));
  raw.socket.write(clientFrame(9, 'ping-data'));
  let response = await raw.reader.frame();
  assert.equal(response.opcode, 10); assert.equal(response.payload.toString(), 'ping-data');
  raw.socket.write(clientFrame(0, message.slice(11)));
  response = await raw.reader.frame();
  assert.equal(JSON.parse(response.payload).type, 'registered');
  raw.socket.write(clientFrame(1, '{}', { masked: false }));
  response = await raw.reader.frame();
  assert.equal(response.opcode, 8); assert.equal(response.payload.readUInt16BE(), 1002);

  const continuation = await rawConnect(url); t.after(() => continuation.socket.destroy());
  continuation.socket.write(clientFrame(0, '{}'));
  assert.equal((await continuation.reader.frame()).payload.readUInt16BE(), 1002);

  const badUtf8 = await rawConnect(url); t.after(() => badUtf8.socket.destroy());
  badUtf8.socket.write(clientFrame(1, Buffer.from([0xff])));
  assert.equal((await badUtf8.reader.frame()).payload.readUInt16BE(), 1007);
});

test('message limits and bounded fragment counts are enforced before dispatch', async (t) => {
  const { url } = await fixture(t, { maxMessageBytes: 1024 });
  const raw = await rawConnect(url); t.after(() => raw.socket.destroy());
  raw.socket.write(clientFrame(1, 'x'.repeat(1025)));
  assert.equal((await raw.reader.frame()).payload.readUInt16BE(), 1009);
  const fragments = await rawConnect(url); t.after(() => fragments.socket.destroy());
  fragments.socket.write(Buffer.concat(Array.from({ length: 129 }, (_, index) => clientFrame(index === 0 ? 1 : 0, '', { fin: false }))));
  assert.equal((await fragments.reader.frame()).payload.readUInt16BE(), 1009);
});

test('unresponsive sockets time out and relay backpressure closes the session cleanly', async (t) => {
  const fast = await fixture(t, { keepaliveMs: 40, sweepIntervalMs: 5, registerTimeoutMs: 1000 });
  const raw = await rawConnect(fast.url); t.after(() => raw.socket.destroy());
  assert.equal((await raw.reader.frame()).opcode, 9);
  const close = await raw.reader.frame();
  assert.equal(close.opcode, 8); assert.equal(close.payload.readUInt16BE(), 1001);

  const limited = await fixture(t, { maxBufferedBytes: 1024, maxMessageBytes: 4096 });
  const host = await limited.device('Host'); const viewer = await limited.device('Viewer');
  const sessionId = await approvePair(host, viewer);
  viewer.send({ type: 'data', sessionId, payload: { data: 'x'.repeat(2000) } });
  assert.equal((await host.closed).code, 1013);
  assert.equal((await viewer.next('disconnected')).reason, 'peer-disconnected');
});

async function within(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('TCP EOF after WebSocket registration closes the owned transport and relay promptly', { timeout: 5000 }, async (t) => {
  const { relay, url } = await fixture(t);
  let serverTransport;
  relay.server.once('connection', (socket) => { serverTransport = socket; });
  const raw = await rawConnect(url);
  try {
    raw.socket.write(clientFrame(1, JSON.stringify({ type: 'register', name: 'Abrupt client' })));
    assert.equal(JSON.parse((await raw.reader.frame()).payload).type, 'registered');
    const transportClosed = once(raw.socket, 'close');
    // A process can close TCP without sending a WebSocket close frame.
    raw.socket.end();
    await within(transportClosed, 1800, 'Relay kept a half-open transport after TCP EOF');
    await within(relay.close(), 1800, 'Relay shutdown did not complete after client EOF');
  } finally { raw.socket.destroy(); serverTransport?.destroy(); }
});

test('shutdown drains transports after logical WebSocket close and incomplete HTTP upgrade', { timeout: 5000 }, async (t) => {
  const { relay, url } = await fixture(t);
  const owned = new Set();
  relay.server.on('connection', (socket) => owned.add(socket));
  const raw = await rawConnect(url);
  const incomplete = net.connect({ host: '127.0.0.1', port: new URL(url).port });
  incomplete.on('error', () => {});
  try {
    await once(incomplete, 'connect');
    incomplete.write('GET /ws HTTP/1.1\r\nHost: localhost\r\n');
    raw.socket.write(clientFrame(1, JSON.stringify({ type: 'register', name: 'Closing client' })));
    assert.equal(JSON.parse((await raw.reader.frame()).payload).type, 'registered');
    const code = Buffer.alloc(2); code.writeUInt16BE(1000);
    raw.socket.write(clientFrame(8, code));
    assert.equal((await raw.reader.frame()).opcode, 8);
    await within(relay.close(), 1800, 'Shutdown retained a closing or incomplete transport');
    assert.equal(relay.server.listening, false);
    await within(relay.close(), 100, 'Relay close should be idempotent');
  } finally { raw.socket.destroy(); incomplete.destroy(); for (const socket of owned) socket.destroy(); }
});
