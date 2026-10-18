import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DeviceStore } from './store.mjs';
import { upgrade, validateUpgrade } from './websocket.mjs';

const id = () => randomBytes(18).toString('base64url');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && /^\d{9}$/.test(value);
const validRequestId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{24}$/.test(value);
const opaque = (value) => isObject(value) && Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024;

class RateLimit {
  constructor(limit, periodMs) { this.limit = limit; this.periodMs = periodMs; this.entries = new Map(); }
  allow(key, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry || now >= entry.reset) { entry = { count: 0, reset: now + this.periodMs }; this.entries.set(key, entry); }
    entry.count += 1;
    return entry.count <= this.limit;
  }
  prune(now) { for (const [key, entry] of this.entries) if (entry.reset <= now) this.entries.delete(key); }
}

export async function createRelay(options = {}) {
  const store = new DeviceStore(options.storePath ?? resolve('server/data/devices.json'));
  await store.load();
  const sockets = new Set();
  // Logical WebSocket peers leave `sockets` as soon as a close starts. Keep
  // transports separately until their actual close event, including HTTP
  // connections whose upgrade or close handshake has not completed.
  const transports = new Set();
  let shuttingDown = false;
  let closePromise;
  const online = new Map();
  const pending = new Map();
  const sessions = new Map();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const pendingTimeoutMs = options.pendingTimeoutMs ?? 60_000;
  const registerTimeoutMs = options.registerTimeoutMs ?? 15_000;
  const keepaliveMs = options.keepaliveMs ?? 25_000;
  const maximumConnections = options.maxConnections ?? 256;
  const maximumConnectionsPerIp = options.maxConnectionsPerIp ?? 32;
  const registerRate = new RateLimit(options.registerLimit ?? 30, options.ratePeriodMs ?? 60_000);
  const inviteRate = new RateLimit(options.inviteLimit ?? 10, options.ratePeriodMs ?? 60_000);
  const connectRate = new RateLimit(options.connectLimit ?? 60, options.ratePeriodMs ?? 60_000);

  const handler = (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
    } else { response.writeHead(404); response.end('Not found\n'); }
  };
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', (socket) => {
    transports.add(socket);
    socket.once('close', () => transports.delete(socket));
  });

  function fail(peer, code, message, requestId) {
    peer.send({ type: 'error', code, message, ...(requestId ? { requestId } : {}) });
    if (++peer.invalidMessages > 20) peer.close(1008, 'Too many invalid messages');
  }

  function endPending(request, type, reason) {
    pending.delete(request.id);
    if (request.host.pendingId === request.id) request.host.pendingId = null;
    if (request.viewer.pendingId === request.id) request.viewer.pendingId = null;
    const message = { type, requestId: request.id, hostId: request.host.deviceId, reason };
    request.viewer.send(message);
    request.host.send(message);
  }

  function endSession(session, reason) {
    sessions.delete(session.id);
    for (const peer of [session.host, session.viewer]) {
      if (peer.sessionId === session.id) peer.sessionId = null;
      peer.send({ type: 'disconnected', sessionId: session.id, reason });
    }
  }

  function cleanup(peer) {
    sockets.delete(peer);
    if (online.get(peer.deviceId) === peer) online.delete(peer.deviceId);
    if (peer.pendingId && pending.has(peer.pendingId)) endPending(pending.get(peer.pendingId), 'canceled', 'peer-disconnected');
    if (peer.sessionId && sessions.has(peer.sessionId)) endSession(sessions.get(peer.sessionId), 'peer-disconnected');
  }

  async function register(peer, message) {
    if (peer.deviceId || peer.registering) { fail(peer, 'already-registered', 'Socket already registered'); return; }
    if (!registerRate.allow(peer.ip)) { fail(peer, 'rate-limited', 'Too many registration attempts'); return; }
    if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 80 || /[\u0000-\u001f\u007f]/.test(message.name)) {
      fail(peer, 'invalid-name', 'Name must contain 1–80 printable characters'); return;
    }
    const reconnect = message.deviceId !== undefined || message.deviceToken !== undefined;
    if (reconnect && (!validId(message.deviceId) || typeof message.deviceToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.deviceToken))) {
      fail(peer, 'auth-failed', 'Invalid device credentials'); return;
    }
    peer.registering = true;
    try {
      let record; let token;
      if (reconnect) {
        record = store.authenticate(message.deviceId, message.deviceToken);
        if (!record) { fail(peer, 'auth-failed', 'Invalid device credentials'); return; }
        await store.updateName(record, message.name.trim());
      } else {
        ({ record, token } = await store.create(message.name.trim()));
      }
      if (peer.closed) return;
      // A valid device token replaces its previous socket, including its sessions.
      online.get(record.id)?.close(4001, 'Device reconnected');
      peer.deviceId = record.id;
      peer.name = message.name.trim();
      online.set(record.id, peer);
      peer.send({ type: 'registered', deviceId: record.id, ...(token ? { deviceToken: token } : {}), name: peer.name, protocolVersion: 1 });
    } catch {
      fail(peer, 'storage-unavailable', 'Cannot persist device credentials');
    } finally { peer.registering = false; }
  }

  function handle(peer, raw) {
    let message;
    try { message = JSON.parse(raw); }
    catch { fail(peer, 'invalid-json', 'Expected JSON object'); return; }
    if (!isObject(message) || typeof message.type !== 'string') { fail(peer, 'invalid-message', 'Expected message type'); return; }
    if (message.type === 'register') { void register(peer, message); return; }
    if (!peer.deviceId) { fail(peer, 'not-registered', 'Register this socket first'); return; }
    if (message.type === 'invite') {
      if (!inviteRate.allow(peer.deviceId) || !inviteRate.allow(`ip:${peer.ip}`)) { fail(peer, 'rate-limited', 'Too many invitations'); return; }
      if (!validId(message.hostId) || message.hostId === peer.deviceId) { fail(peer, 'invalid-host', 'Invalid host ID'); return; }
      if (peer.pendingId || peer.sessionId) { fail(peer, 'busy', 'Device is already busy'); return; }
      const host = online.get(message.hostId);
      if (!host) { fail(peer, 'host-unavailable', 'Host is offline'); return; }
      if (host.pendingId || host.sessionId) { fail(peer, 'busy', 'Host is already busy'); return; }
      const requestId = id();
      pending.set(requestId, { id: requestId, host, viewer: peer, stage: 'invited', expires: Date.now() + pendingTimeoutMs });
      peer.pendingId = requestId; host.pendingId = requestId;
      peer.send({ type: 'invited', requestId, hostId: host.deviceId });
      host.send({ type: 'incoming', requestId, hostId: host.deviceId, viewerId: peer.deviceId, viewerName: peer.name });
      return;
    }
    if (['challenge', 'proof', 'accept', 'reject', 'cancel'].includes(message.type)) {
      if (!validRequestId(message.requestId)) { fail(peer, 'invalid-request', 'Invalid request ID'); return; }
      const request = pending.get(message.requestId);
      if (!request || (request.host !== peer && request.viewer !== peer)) { fail(peer, 'unknown-request', 'Request is unavailable', message.requestId); return; }
      if (Date.now() >= request.expires) { endPending(request, 'expired', 'timeout'); return; }
      const hostAction = ['challenge', 'accept', 'reject'].includes(message.type);
      if ((hostAction && request.host !== peer) || (!hostAction && request.viewer !== peer)) { fail(peer, 'forbidden', 'Wrong request role', request.id); return; }
      if (message.type === 'reject' || message.type === 'cancel') {
        endPending(request, message.type === 'reject' ? 'rejected' : 'canceled', message.type === 'reject' ? 'host-rejected' : 'viewer-canceled'); return;
      }
      if (message.type === 'challenge') {
        if (request.stage !== 'invited' || !opaque(message.challenge)) { fail(peer, 'invalid-challenge', 'Challenge is unavailable or invalid', request.id); return; }
        request.stage = 'challenged';
        request.viewer.send({ type: 'challenge', requestId: request.id, peerId: peer.deviceId, challenge: message.challenge }); return;
      }
      if (message.type === 'proof') {
        if (request.stage !== 'challenged' || !opaque(message.proof)) { fail(peer, 'invalid-proof', 'Proof is unavailable or invalid', request.id); return; }
        request.stage = 'proved';
        request.host.send({ type: 'proof', requestId: request.id, peerId: peer.deviceId, proof: message.proof }); return;
      }
      if (request.stage !== 'proved') { fail(peer, 'proof-required', 'Host challenge and viewer proof are required', request.id); return; }
      pending.delete(request.id);
      request.host.pendingId = null; request.viewer.pendingId = null;
      const sessionId = id();
      const session = { id: sessionId, host: request.host, viewer: request.viewer };
      sessions.set(sessionId, session);
      request.host.sessionId = sessionId; request.viewer.sessionId = sessionId;
      for (const [member, other, role] of [[request.host, request.viewer, 'host'], [request.viewer, request.host, 'viewer']]) {
        if (!sessions.has(sessionId)) break;
        member.send({ type: 'session', requestId: request.id, sessionId, peerId: other.deviceId, role });
      }
      return;
    }
    if (message.type === 'data' || message.type === 'disconnect') {
      const session = sessions.get(message.sessionId);
      if (!session || peer.sessionId !== session.id || (session.host !== peer && session.viewer !== peer)) {
        fail(peer, 'no-session', 'No approved session with this ID'); return;
      }
      if (message.type === 'disconnect') { endSession(session, 'peer-requested'); return; }
      if (!isObject(message.payload)) { fail(peer, 'invalid-payload', 'Expected encrypted JSON envelope'); return; }
      const other = session.host === peer ? session.viewer : session.host;
      const forwarded = { type: 'data', sessionId: session.id, peerId: peer.deviceId, payload: message.payload };
      if (Buffer.byteLength(JSON.stringify(forwarded)) > other.maxMessageBytes) { fail(peer, 'payload-too-large', 'Encrypted envelope exceeds relay limit'); return; }
      other.send(forwarded);
      return;
    }
    fail(peer, 'unknown-type', 'Unknown message type');
  }

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const reject = (status, phrase) => socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (shuttingDown) { reject(503, 'Service Unavailable'); return; }
    if (request.url !== '/ws' || !validateUpgrade(request)) { reject(400, 'Bad Request'); return; }
    const origin = request.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || !allowedOrigins.has(origin))) { reject(403, 'Forbidden'); return; }
    const ip = socket.remoteAddress ?? 'unknown';
    if (sockets.size >= maximumConnections || [...sockets].filter((peer) => peer.ip === ip).length >= maximumConnectionsPerIp || !connectRate.allow(ip)) {
      reject(429, 'Too Many Requests'); return;
    }
    const peer = upgrade(request, socket, head, options);
    peer.ip = ip; peer.invalidMessages = 0; peer.connectedAt = Date.now();
    sockets.add(peer);
    peer.onMessage = (raw) => {
      try { handle(peer, raw); }
      catch { fail(peer, 'invalid-message', 'Cannot process message'); }
    };
    peer.onClose = () => cleanup(peer);
  });

  let lastHeartbeat = Date.now();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const request of [...pending.values()]) if (request.expires <= now) endPending(request, 'expired', 'timeout');
    for (const peer of sockets) {
      if (!peer.deviceId && now - peer.connectedAt >= registerTimeoutMs) peer.close(1008, 'Registration timeout');
      else if (now - lastHeartbeat >= keepaliveMs) peer.heartbeat();
    }
    if (now - lastHeartbeat >= keepaliveMs) lastHeartbeat = now;
    registerRate.prune(now); inviteRate.prune(now); connectRate.prune(now);
  }, options.sweepIntervalMs ?? Math.min(1000, pendingTimeoutMs, keepaliveMs, registerTimeoutMs));
  sweep.unref();

  return {
    server,
    address: () => server.address(),
    async listen({ port = 8787, host = '127.0.0.1' } = {}) {
      if (shuttingDown) throw new Error('Relay is closed');
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => { server.off('error', rejectListen); resolveListen(); });
      });
      return server.address();
    },
    close() {
      if (closePromise) return closePromise;
      shuttingDown = true;
      clearInterval(sweep);
      closePromise = (async () => {
        const drained = Promise.all([...transports].map((socket) => socket.destroyed ? undefined : new Promise((resolveSocket) => socket.once('close', resolveSocket))));
        const stopped = server.listening
          ? new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
          : Promise.resolve();
        for (const peer of [...sockets]) peer.close(1001, 'Server shutdown');
        for (const socket of transports) if (socket.readableEnded) socket.destroy();
        // A peer may ignore the close handshake or leave an HTTP request
        // incomplete. End its owned transport after the grace period, and
        // still await actual close events rather than resolving on a timeout.
        const deadline = setTimeout(() => {
          for (const socket of transports) socket.destroy();
        }, 1000);
        try { await Promise.all([stopped, drained, store.writes.catch(() => {})]); }
        finally { clearTimeout(deadline); }
      })();
      return closePromise;
    },
  };
}
