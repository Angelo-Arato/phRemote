import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalTranscript, createChallenge, createEphemeralKey, createPasswordProof,
  createSessionCipher, randomPassword, validatePayload, verifyPasswordProof,
} from '../desktop/core/crypto.mjs';
import { RelayClient } from '../desktop/core/relay-client.mjs';
import { createRelay } from '../server/relay.mjs';

function material(password = randomPassword()) {
  const { ephemeral: host, challenge } = createChallenge();
  const viewer = createEphemeralKey();
  const fields = { requestId: 'request-1', hostId: '123456789', viewerId: '987654321', challenge, viewerPublicKey: viewer.publicKey };
  const passwordKey = createHash('sha256').update(password).digest();
  const common = { ...fields, sessionId: 'session-1', passwordKey };
  return {
    password, host, viewer, fields, common,
    hostCipher: () => createSessionCipher({ ...common, role: 'host', privateKey: host.privateKey, peerPublicKey: viewer.publicKey }),
    viewerCipher: () => createSessionCipher({ ...common, role: 'viewer', privateKey: viewer.privateKey, peerPublicKey: host.publicKey }),
  };
}

test('password proof binds ephemeral keys, both identities, request, salt and nonce', () => {
  const fixture = material();
  assert.equal(fixture.password.length, 32);
  assert.equal(fixture.host.publicKey.length, 44);
  const mac = createPasswordProof(fixture.password, fixture.fields);
  assert.equal(verifyPasswordProof(fixture.password, fixture.fields, mac), true);
  assert.equal(verifyPasswordProof(randomPassword(), fixture.fields, mac), false);
  for (const [key, value] of [
    ['requestId', 'another-request'], ['hostId', '123456788'], ['viewerId', '987654322'],
    ['viewerPublicKey', createEphemeralKey().publicKey],
  ]) {
    assert.equal(verifyPasswordProof(fixture.password, { ...fixture.fields, [key]: value }, mac), false, key);
  }
  for (const key of ['salt', 'nonce', 'publicKey']) {
    const challenge = { ...fixture.fields.challenge, [key]: randomBytes(32).toString('base64') };
    assert.equal(verifyPasswordProof(fixture.password, { ...fixture.fields, challenge }, mac), false, key);
  }
  assert.equal(verifyPasswordProof(fixture.password, fixture.fields, 'malformed'), false);
  assert.throws(() => canonicalTranscript({ ...fixture.fields, viewerId: 'wrong' }));
});

test('authenticated encryption rejects tampering, replay, reflection and wrong session', () => {
  const fixture = material();
  const host = fixture.hostCipher();
  const viewer = fixture.viewerCipher();
  const frame = { kind: 'frame', mime: 'image/jpeg', data: Buffer.from('a frame').toString('base64'), width: 1920, height: 1080 };
  const envelope = host.seal(frame);
  assert.notEqual(envelope.data, frame.data);
  assert.throws(() => host.open(envelope), 'direction keys prevent reflection');
  const tampered = Buffer.from(envelope.data, 'base64');
  tampered[15] ^= 1;
  assert.throws(() => viewer.open({ ...envelope, data: tampered.toString('base64') }));
  assert.deepEqual(viewer.open(envelope), frame, 'failed authentication does not consume sequence');
  assert.throws(() => viewer.open(envelope), /sequence/);
  assert.deepEqual(host.open(viewer.seal({ kind: 'chat', text: 'hello' })), { kind: 'chat', text: 'hello' });
  const wrongSession = createSessionCipher({ ...fixture.common, sessionId: 'other-session', role: 'viewer', privateKey: fixture.viewer.privateKey, peerPublicKey: fixture.host.publicKey });
  assert.throws(() => wrongSession.open(envelope));
  host.destroy(); viewer.destroy(); wrongSession.destroy();
  assert.throws(() => host.seal({ kind: 'chat', text: 'after close' }));
});

test('a relay impersonating the host without the password cannot confirm the key', () => {
  const fixture = material();
  const viewer = fixture.viewerCipher();
  const impostor = createSessionCipher({
    ...fixture.common, role: 'host', privateKey: fixture.host.privateKey, peerPublicKey: fixture.viewer.publicKey,
    passwordKey: createHash('sha256').update(randomPassword()).digest(),
  });
  assert.throws(() => viewer.open(impostor.seal({ kind: 'ready' })));
  viewer.destroy(); impostor.destroy();
});

test('payload schema bounds frames, text and normalized input coordinates', () => {
  assert.deepEqual(validatePayload({ kind: 'input', event: 'move', x: 0.2, y: 0.8, ignored: true }), { kind: 'input', event: 'move', x: 0.2, y: 0.8 });
  assert.throws(() => validatePayload({ kind: 'input', event: 'move', x: 2, y: 0 }));
  assert.throws(() => validatePayload({ kind: 'input', event: 'keyDown', code: 'KeyA', key: 'a', modifiers: { ctrl: 'true' } }));
  assert.throws(() => validatePayload({ kind: 'chat', text: 'a'.repeat(4097) }));
  assert.throws(() => validatePayload({ kind: 'frame', mime: 'image/svg+xml', data: 'AAAA', width: 10, height: 10 }));
  assert.throws(() => validatePayload({ kind: 'frame', mime: 'image/jpeg', data: 'AAAA'.repeat(32769), width: 10, height: 10 }));
  assert.throws(() => validatePayload({ kind: 'ready' }));
});

async function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for client state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'phremote-core-'));
  const relay = await createRelay({ storePath: join(directory, 'devices.json') });
  await relay.listen({ port: 0 });
  const url = `ws://127.0.0.1:${relay.address().port}/ws`;
  const clients = [];
  const wire = [];
  const sockets = [];
  class ObservedWebSocket extends WebSocket {
    constructor(...args) { super(...args); sockets.push(this); }
    send(message) { wire.push(JSON.parse(message)); return super.send(message); }
  }
  function client(name, options = {}) {
    const value = new RelayClient({ name, WebSocketImpl: ObservedWebSocket, ...options });
    value.on('error', () => {});
    clients.push(value);
    return value;
  }
  t.after(async () => {
    for (const value of clients) value.close();
    await relay.close();
    await rm(directory, { force: true, recursive: true });
  });
  return { relay, url, client, wire, sockets };
}

test('real relay requires host approval and key confirmation before bidirectional traffic', async t => {
  const { url, client, wire } = await fixture(t);
  let saved;
  const host = client('Host', { saveIdentity: async identity => { saved = identity; } });
  const viewer = client('Viewer');
  await Promise.all([host.connect(url), viewer.connect(url)]);
  assert.equal(saved.deviceId, host.snapshot().deviceId);
  assert.equal(typeof saved.deviceToken, 'string');
  assert.equal(JSON.stringify(host.snapshot()).includes(saved.deviceToken), false);
  let gated = false;
  host.on('state', state => {
    if (state.incoming[0] && !state.incoming[0].verified) {
      assert.throws(() => host.approve(state.incoming[0].requestId), /Verify/);
      gated = true;
    }
  });
  const requestId = await viewer.invite(host.snapshot().deviceId, host.snapshot().password);
  await waitFor(() => host.snapshot().incoming[0]?.verified);
  assert.equal(gated, true);
  assert.equal(host.snapshot().session, null);
  assert.equal(viewer.snapshot().session, null);
  assert.throws(() => viewer.send({ kind: 'chat', text: 'too early' }));
  host.approve(requestId);
  await waitFor(() => host.snapshot().session?.authenticated && viewer.snapshot().session?.authenticated);
  const hostMessages = [], viewerMessages = [];
  host.on('payload', payload => hostMessages.push(payload));
  viewer.on('payload', payload => viewerMessages.push(payload));
  const chat = { kind: 'chat', text: 'encrypted integration message' };
  const input = { kind: 'input', event: 'move', x: 0.25, y: 0.75 };
  const frame = { kind: 'frame', mime: 'image/jpeg', width: 1280, height: 720, data: randomBytes(90 * 1024).toString('base64') };
  assert.equal(host.send(chat), true);
  assert.equal(host.send(frame), true);
  assert.equal(viewer.send(input), true);
  assert.throws(() => host.send(input));
  assert.throws(() => viewer.send(frame));
  await waitFor(() => hostMessages.length === 1 && viewerMessages.length === 2);
  assert.deepEqual(hostMessages, [input]);
  assert.deepEqual(viewerMessages, [chat, frame]);
  assert.equal(wire.some(message => message.type === 'data' && JSON.stringify(message).includes(chat.text)), false);
  assert.equal(JSON.stringify(wire).includes(host.snapshot().password), false);
  viewer.disconnect();
  await waitFor(() => host.snapshot().session === null && viewer.snapshot().session === null);
});

test('wrong password never opens a session and pending requests can be rejected', async t => {
  const { url, client } = await fixture(t);
  const host = client('Host'), viewer = client('Viewer');
  await Promise.all([host.connect(url), viewer.connect(url)]);
  let error;
  viewer.on('error', value => { error = value; });
  await viewer.invite(host.snapshot().deviceId, randomPassword());
  await waitFor(() => !!error);
  assert.equal(host.snapshot().session, null);
  assert.equal(viewer.snapshot().session, null);
  assert.equal(host.snapshot().incoming.length, 0);
  const requestId = await viewer.invite(host.snapshot().deviceId, host.snapshot().password);
  await waitFor(() => host.snapshot().incoming[0]?.verified);
  host.reject(requestId);
  await waitFor(() => host.snapshot().incoming.length === 0);
  assert.equal(viewer.snapshot().session, null);
});

test('device identity survives reconnect without leaking the device token in state', async t => {
  const { url, client } = await fixture(t);
  let identity;
  const first = client('Persistent', { saveIdentity: value => { identity = value; } });
  await first.connect(url);
  const firstId = first.snapshot().deviceId;
  first.close();
  const reconnected = client('Persistent renamed', { identity, saveIdentity: async value => { identity = value; } });
  await reconnected.connect(url);
  assert.equal(reconnected.snapshot().deviceId, firstId);
  assert.equal(reconnected.snapshot().name, 'Persistent renamed');
  assert.equal(JSON.stringify(reconnected.snapshot()).includes(identity.deviceToken), false);
});

test('replayed relay traffic terminates the session before delivering a duplicate', async t => {
  const { url, client, wire, sockets } = await fixture(t);
  const host = client('Host'), viewer = client('Viewer');
  await Promise.all([host.connect(url), viewer.connect(url)]);
  const requestId = await viewer.invite(host.snapshot().deviceId, host.snapshot().password);
  await waitFor(() => host.snapshot().incoming[0]?.verified);
  host.approve(requestId);
  await waitFor(() => host.snapshot().session?.authenticated && viewer.snapshot().session?.authenticated);
  const received = [];
  viewer.on('payload', value => received.push(value));
  host.send({ kind: 'chat', text: 'deliver only once' });
  await waitFor(() => received.length === 1);
  const envelope = wire.findLast(value => value.type === 'data');
  sockets[0].send(JSON.stringify(envelope));
  await waitFor(() => host.snapshot().session === null && viewer.snapshot().session === null);
  assert.equal(received.length, 1);
  assert.equal(viewer.snapshot().lastError.code, 'invalid-payload');
});

test('an interrupted pending invitation is cleared before automatic reconnect', async t => {
  const { url, client, sockets } = await fixture(t);
  const host = client('Host'), viewer = client('Viewer');
  await Promise.all([host.connect(url), viewer.connect(url)]);
  const hostId = host.snapshot().deviceId, viewerId = viewer.snapshot().deviceId;
  await viewer.invite(hostId, host.snapshot().password);
  await waitFor(() => host.snapshot().incoming[0]?.verified);
  for (const socket of sockets) socket.close();
  await waitFor(() => host.snapshot().relay === 'offline' && viewer.snapshot().relay === 'offline');
  assert.equal(host.snapshot().incoming.length, 0);
  assert.equal(host.snapshot().session, null);
  await waitFor(() => host.snapshot().relay === 'online' && viewer.snapshot().relay === 'online', 4000);
  assert.equal(host.snapshot().deviceId, hostId);
  assert.equal(viewer.snapshot().deviceId, viewerId);
  const requestId = await viewer.invite(hostId, host.snapshot().password);
  await waitFor(() => host.snapshot().incoming[0]?.verified);
  host.approve(requestId);
  await waitFor(() => host.snapshot().session?.authenticated && viewer.snapshot().session?.authenticated);
});

test('Internet relays require TLS before any device credentials are sent', async () => {
  let constructed = false;
  const client = new RelayClient({ WebSocketImpl: class { constructor() { constructed = true; } } });
  await assert.rejects(client.connect('ws://192.168.1.20:8787/ws'), /secure wss/);
  await assert.rejects(client.connect('ws://relay.example/ws'), /secure wss/);
  assert.equal(constructed, false);
  client.close();
});
