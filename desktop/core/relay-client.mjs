import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  createChallenge, createEphemeralKey, createPasswordProof, createSessionCipher,
  MAX_WIRE_BYTES, randomPassword, validateChallenge, validatePayload, verifyPasswordProof,
} from './crypto.mjs';

const REQUEST_LIFETIME = 120000;
const AUTHENTICATION_TIMEOUT = 15000;
const MAX_BUFFERED_BYTES = 512 * 1024;
const PUBLIC_CODES = new Set([
  'offline', 'timeout', 'unavailable', 'invalid-message', 'invalid-request', 'busy',
  'rate-limited', 'auth-failed', 'rejected', 'expired', 'connection-failed',
  'storage-failed', 'invalid-payload', 'protocol-error', 'identity-invalid',
]);

function publicError(code, message) {
  code = ({ 'host-unavailable': 'unavailable', 'invalid-host': 'invalid-request', 'unknown-request': 'expired',
    'payload-too-large': 'invalid-payload', 'no-session': 'offline', 'storage-unavailable': 'unavailable',
    'invalid-name': 'invalid-request' })[code] ?? code;
  const err = new Error(message);
  err.code = PUBLIC_CODES.has(code) ? code : 'protocol-error';
  return err;
}

function validIdentity(identity) {
  return identity && /^\d{9}$/.test(identity.deviceId) &&
    typeof identity.deviceToken === 'string' && identity.deviceToken.length >= 16 && identity.deviceToken.length <= 256;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** The only owner of device credentials and session cryptographic material. */
export class RelayClient extends EventEmitter {
  #name; #identity; #saveIdentity; #WebSocket; #socket = null;
  #relay = 'offline'; #password = randomPassword(); #incoming = new Map();
  #outgoing = null; #session = null; #cipher = null; #connection = null;
  #url = null; #closed = true; #retry = null; #retryCount = 0;
  #lastError = null; #failures = new Map(); #connectionTimer = null;
  #authenticationTimer = null;

  constructor({ name = 'phRemote', identity = null, saveIdentity = async () => {}, WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket implementation required');
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid device name');
    if (typeof saveIdentity !== 'function') throw new Error('Invalid identity storage');
    this.#name = name.trim();
    this.#identity = validIdentity(identity) ? { deviceId: identity.deviceId, deviceToken: identity.deviceToken } : null;
    this.#saveIdentity = saveIdentity;
    this.#WebSocket = WebSocketImpl;
  }

  get bufferedAmount() { return this.#socket?.bufferedAmount ?? 0; }

  snapshot() {
    return {
      relay: this.#relay,
      deviceId: this.#identity?.deviceId ?? null,
      name: this.#name,
      password: this.#password,
      incoming: [...this.#incoming.values()].map(({ requestId, viewerId, viewerName, verified }) => ({ requestId, viewerId, viewerName, verified })),
      session: this.#session ? { ...this.#session } : null,
      lastError: this.#lastError ? { ...this.#lastError } : null,
    };
  }

  #state() { this.emit('state', this.snapshot()); }

  #report(code, message) {
    const error = publicError(code, message);
    this.#lastError = { code: error.code, message: error.message };
    if (this.listenerCount('error')) this.emit('error', error);
    this.#state();
    return error;
  }

  connect(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.reject(publicError('connection-failed', 'Invalid relay address')); }
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      return Promise.reject(publicError('connection-failed', 'Invalid relay address'));
    }
    if (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      return Promise.reject(publicError('connection-failed', 'Internet relays require a secure wss:// address'));
    }
    if (this.#relay === 'online' && this.#url === parsed.href) return Promise.resolve(this.snapshot());
    if (this.#relay === 'connecting' && this.#url === parsed.href && this.#connection) return this.#connection.promise;
    this.close();
    this.#closed = false;
    this.#url = parsed.href;
    return this.#open();
  }

  #open() {
    this.#relay = 'connecting';
    this.#lastError = null;
    this.#connection = deferred();
    const currentConnection = this.#connection;
    let socket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch {
      this.#relay = 'offline';
      this.#connection = null;
      currentConnection.reject(this.#report('connection-failed', 'Could not connect to relay'));
      this.#scheduleRetry();
      return currentConnection.promise;
    }
    this.#socket = socket;
    const active = () => this.#socket === socket;
    socket.onopen = () => {
      if (!active()) return;
      this.#write({ type: 'register', name: this.#name, ...(this.#identity ?? {}) }, true);
    };
    socket.onmessage = event => {
      if (!active()) return;
      this.#receive(event.data).catch(() => {
        if (active()) this.#report('protocol-error', 'The relay sent an invalid message');
      });
    };
    socket.onerror = () => {
      if (active()) this.#report('connection-failed', 'Relay connection failed');
    };
    socket.onclose = () => {
      if (!active()) return;
      this.#socket = null;
      clearTimeout(this.#connectionTimer);
      this.#connectionTimer = null;
      this.#relay = 'offline';
      this.#connection?.reject(publicError('offline', 'Relay disconnected'));
      this.#connection = null;
      this.#clearRequests(publicError('offline', 'Relay disconnected'));
      this.#endSession();
      this.#state();
      this.#scheduleRetry();
    };
    this.#connectionTimer = setTimeout(() => {
      if (!active() || this.#relay === 'online') return;
      this.#connection?.reject(publicError('timeout', 'Relay registration timed out'));
      this.#connection = null;
      socket.close();
    }, 15000);
    this.#connectionTimer.unref?.();
    this.#state();
    return currentConnection.promise;
  }

  #scheduleRetry() {
    if (this.#closed || this.#retry) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.#retryCount++, 5)) + Math.floor(Math.random() * 250);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (!this.#closed) this.#open().catch(() => {});
    }, delay);
    this.#retry.unref?.();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#retry); this.#retry = null;
    clearTimeout(this.#connectionTimer); this.#connectionTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#connection?.reject(publicError('offline', 'Relay disconnected'));
    this.#connection = null;
    this.#clearRequests(publicError('offline', 'Relay disconnected'));
    this.#endSession();
    this.#relay = 'offline';
    socket?.close();
    this.#state();
  }

  #write(message, registering = false) {
    if (!this.#socket || this.#socket.readyState !== 1 || (!registering && this.#relay !== 'online')) {
      throw publicError('offline', 'Relay is offline');
    }
    const wire = JSON.stringify(message);
    if (Buffer.byteLength(wire) > MAX_WIRE_BYTES) throw publicError('invalid-payload', 'Message is too large');
    this.#socket.send(wire);
  }

  invite(hostId, password) {
    hostId = String(hostId).replace(/\s/g, '');
    if (!/^\d{9}$/.test(hostId) || hostId === this.#identity?.deviceId) return Promise.reject(publicError('invalid-request', 'Invalid remote device ID'));
    if (typeof password !== 'string' || password.length < 16 || password.length > 256) return Promise.reject(publicError('auth-failed', 'A valid session password is required'));
    if (this.#session || this.#outgoing) return Promise.reject(publicError('busy', 'Another session request is active'));
    const completion = deferred();
    const outgoing = { hostId, password, completion, requestId: null, ephemeral: null, challenge: null, timer: null };
    outgoing.timer = setTimeout(() => {
      if (outgoing.requestId) {
        try { this.#write({ type: 'cancel', requestId: outgoing.requestId }); } catch {}
      }
      this.#dropOutgoing(this.#report('expired', 'Session request expired'));
    }, REQUEST_LIFETIME);
    outgoing.timer.unref?.();
    this.#outgoing = outgoing;
    try { this.#write({ type: 'invite', hostId }); }
    catch (error) { this.#dropOutgoing(error); }
    this.#state();
    return completion.promise;
  }

  approve(requestId) {
    const pending = this.#incoming.get(requestId);
    if (!pending?.verified) throw publicError('auth-failed', 'Verify the session password before approval');
    if (this.#session) throw publicError('busy', 'A session is already active');
    if (pending.approved) return;
    this.#write({ type: 'accept', requestId });
    pending.approved = true;
    this.#state();
  }

  reject(requestId) {
    if (!this.#incoming.has(requestId)) return;
    this.#write({ type: 'reject', requestId, reason: 'rejected' });
    this.#dropIncoming(requestId);
    this.#state();
  }

  disconnect() {
    if (this.#session) {
      try { this.#write({ type: 'disconnect', sessionId: this.#session.sessionId }); } catch {}
    }
    if (this.#outgoing?.requestId) {
      try { this.#write({ type: 'cancel', requestId: this.#outgoing.requestId }); } catch {}
    }
    for (const requestId of this.#incoming.keys()) {
      try { this.#write({ type: 'reject', requestId, reason: 'rejected' }); } catch {}
    }
    this.#endSession();
    this.#clearRequests(publicError('rejected', 'Session request canceled'));
    this.#state();
  }

  rotatePassword() {
    for (const requestId of this.#incoming.keys()) {
      try { this.#write({ type: 'reject', requestId, reason: 'rejected' }); } catch {}
      this.#dropIncoming(requestId);
    }
    this.#password = randomPassword();
    this.#state();
    return this.#password;
  }

  send(payload) {
    if (!this.#session || !this.#cipher || !this.#session.authenticated) throw publicError('offline', 'No authenticated session');
    if (this.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    const clean = validatePayload(payload);
    if ((clean.kind === 'frame' && this.#session.role !== 'host') || (clean.kind === 'input' && this.#session.role !== 'viewer')) {
      throw publicError('invalid-payload', 'This session role cannot send that payload');
    }
    const encrypted = this.#cipher.seal(clean);
    this.#write({ type: 'data', sessionId: this.#session.sessionId, payload: encrypted });
    return true;
  }

  async #receive(data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_WIRE_BYTES) throw new Error('Invalid relay packet');
    const message = JSON.parse(data);
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') throw new Error('Invalid relay packet');
    if (message.type === 'registered') return this.#registered(message);
    if (message.type === 'error' && this.#relay === 'connecting') {
      const error = this.#report(typeof message.code === 'string' ? message.code : 'protocol-error', 'The relay rejected device registration');
      this.#connection?.reject(error);
      this.#connection = null;
      this.close();
      return;
    }
    if (this.#relay !== 'online') return;
    switch (message.type) {
      case 'invited': {
        const pending = this.#outgoing;
        if (!pending || pending.requestId || message.hostId !== pending.hostId || typeof message.requestId !== 'string' || message.requestId.length > 128) return;
        pending.requestId = message.requestId;
        pending.completion.resolve(message.requestId);
        this.#state();
        break;
      }
      case 'incoming': this.#handleIncoming(message); break;
      case 'challenge': this.#handleChallenge(message); break;
      case 'proof': this.#handleProof(message); break;
      case 'session': this.#handleSession(message); break;
      case 'data': this.#handleData(message); break;
      case 'rejected':
      case 'canceled':
      case 'expired': {
        if (message.requestId === this.#outgoing?.requestId || (!message.requestId && this.#outgoing)) {
          this.#dropOutgoing(this.#report(message.type === 'expired' ? 'expired' : 'rejected', message.type === 'expired' ? 'Session request expired' : 'Session request rejected'));
        }
        this.#dropIncoming(message.requestId);
        this.#state();
        break;
      }
      case 'session-ended':
      case 'disconnected':
        if (this.#session?.sessionId === message.sessionId) { this.#endSession(); this.#state(); }
        break;
      case 'error': {
        const error = this.#report(typeof message.code === 'string' ? message.code : 'protocol-error', 'The relay could not complete the request');
        if (this.#outgoing && (!message.requestId || message.requestId === this.#outgoing.requestId)) this.#dropOutgoing(error);
        this.#state();
        break;
      }
    }
  }

  async #registered(message) {
    if (this.#relay !== 'connecting' || !/^\d{9}$/.test(message.deviceId)) throw new Error('Invalid registration');
    const identity = { deviceId: message.deviceId, deviceToken: message.deviceToken ?? this.#identity?.deviceToken };
    if (!validIdentity(identity) || (this.#identity && this.#identity.deviceId !== identity.deviceId)) throw new Error('Invalid registration');
    const connection = this.#connection;
    try {
      await this.#saveIdentity({ ...identity });
    } catch {
      if (this.#connection !== connection) return;
      const error = this.#report('storage-failed', 'Could not securely save the device identity');
      this.#connection?.reject(error);
      this.#connection = null;
      this.close();
      return;
    }
    if (this.#closed || this.#relay !== 'connecting' || this.#connection !== connection) return;
    this.#identity = identity;
    this.#relay = 'online';
    this.#retryCount = 0;
    this.#lastError = null;
    clearTimeout(this.#connectionTimer); this.#connectionTimer = null;
    this.#connection?.resolve(this.snapshot());
    this.#connection = null;
    this.#state();
  }

  #handleIncoming(message) {
    const { requestId, viewerId } = message;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128 || !/^\d{9}$/.test(viewerId) ||
        typeof message.viewerName !== 'string' || message.viewerName.length > 80 || this.#incoming.has(requestId)) return;
    const failed = this.#failures.get(viewerId);
    if (this.#session || this.#incoming.size >= 8 || (failed?.count >= 5 && Date.now() - failed.at < 60000)) {
      this.#write({ type: 'reject', requestId, reason: 'busy' });
      return;
    }
    const { ephemeral, challenge } = createChallenge();
    const pending = { requestId, viewerId, viewerName: message.viewerName, ephemeral, challenge, verified: false, approved: false, viewerPublicKey: null, timer: null };
    pending.timer = setTimeout(() => {
      if (!this.#incoming.has(requestId)) return;
      try { this.#write({ type: 'reject', requestId, reason: 'expired' }); } catch {}
      this.#dropIncoming(requestId);
      this.#state();
    }, REQUEST_LIFETIME);
    pending.timer.unref?.();
    this.#incoming.set(requestId, pending);
    this.#write({ type: 'challenge', requestId, challenge });
    this.#state();
  }

  #handleChallenge(message) {
    const pending = this.#outgoing;
    if (!pending || pending.requestId !== message.requestId || pending.ephemeral) return;
    try {
      const challenge = validateChallenge(message.challenge);
      const ephemeral = createEphemeralKey();
      const fields = { requestId: pending.requestId, hostId: pending.hostId, viewerId: this.#identity.deviceId, challenge, viewerPublicKey: ephemeral.publicKey };
      const mac = createPasswordProof(pending.password, fields);
      pending.passwordKey = createHash('sha256').update(pending.password, 'utf8').digest();
      pending.password = null;
      pending.challenge = challenge;
      pending.ephemeral = ephemeral;
      this.#write({ type: 'proof', requestId: pending.requestId, proof: { publicKey: ephemeral.publicKey, mac } });
    } catch {
      this.#dropOutgoing(this.#report('auth-failed', 'Could not verify the remote session challenge'));
    }
  }

  #handleProof(message) {
    const pending = this.#incoming.get(message.requestId);
    if (!pending || pending.verified) return;
    const fields = { requestId: pending.requestId, hostId: this.#identity.deviceId, viewerId: pending.viewerId,
      challenge: pending.challenge, viewerPublicKey: message.proof?.publicKey };
    if (!verifyPasswordProof(this.#password, fields, message.proof?.mac)) {
      const failed = this.#failures.get(pending.viewerId);
      this.#failures.set(pending.viewerId, { count: failed && Date.now() - failed.at < 60000 ? failed.count + 1 : 1, at: Date.now() });
      while (this.#failures.size > 128) this.#failures.delete(this.#failures.keys().next().value);
      this.#write({ type: 'reject', requestId: pending.requestId, reason: 'auth-failed' });
      this.#dropIncoming(pending.requestId);
    } else {
      pending.verified = true;
      pending.viewerPublicKey = message.proof.publicKey;
    }
    this.#state();
  }

  #handleSession(message) {
    if (this.#session || typeof message.sessionId !== 'string' || !message.sessionId || message.sessionId.length > 128 || !/^\d{9}$/.test(message.peerId)) return;
    let material;
    let passwordKey;
    if (message.role === 'host') {
      const pending = this.#incoming.get(message.requestId);
      if (!pending?.verified || !pending.approved || pending.viewerId !== message.peerId) return;
      passwordKey = createHash('sha256').update(this.#password, 'utf8').digest();
      material = { privateKey: pending.ephemeral.privateKey, peerPublicKey: pending.viewerPublicKey, challenge: pending.challenge,
        hostId: this.#identity.deviceId, viewerId: pending.viewerId, viewerPublicKey: pending.viewerPublicKey };
    } else if (message.role === 'viewer') {
      const pending = this.#outgoing;
      if (!pending?.ephemeral || pending.requestId !== message.requestId || pending.hostId !== message.peerId) return;
      passwordKey = pending.passwordKey;
      material = { privateKey: pending.ephemeral.privateKey, peerPublicKey: pending.challenge.publicKey, challenge: pending.challenge,
        hostId: pending.hostId, viewerId: this.#identity.deviceId, viewerPublicKey: pending.ephemeral.publicKey };
    } else return;
    try {
      this.#cipher = createSessionCipher({ ...material, role: message.role, sessionId: message.sessionId, requestId: message.requestId, passwordKey });
    } catch {
      try { this.#write({ type: 'disconnect', sessionId: message.sessionId }); } catch {}
      this.#clearRequests(publicError('auth-failed', 'Session authentication failed'));
      this.#report('auth-failed', 'Could not establish the encrypted session');
      return;
    } finally {
      passwordKey?.fill(0);
    }
    this.#session = { sessionId: message.sessionId, requestId: message.requestId, peerId: message.peerId, role: message.role, authenticated: false };
    this.#clearRequests(publicError('rejected', 'Another session was accepted'));
    this.#authenticationTimer = setTimeout(() => {
      this.#report('auth-failed', 'Encrypted session authentication timed out');
      this.disconnect();
    }, AUTHENTICATION_TIMEOUT);
    this.#authenticationTimer.unref?.();
    try {
      this.#write({ type: 'data', sessionId: message.sessionId, payload: this.#cipher.seal({ kind: 'ready' }) });
    } catch {
      this.#report('connection-failed', 'Could not confirm the encrypted session');
      this.disconnect();
      return;
    }
    this.#state();
  }

  #handleData(message) {
    if (!this.#session || !this.#cipher || message.sessionId !== this.#session.sessionId) return;
    try {
      const payload = this.#cipher.open(message.payload);
      if (payload.kind === 'ready') {
        if (this.#session.authenticated) throw new Error('Duplicate key confirmation');
        clearTimeout(this.#authenticationTimer); this.#authenticationTimer = null;
        this.#session.authenticated = true;
        this.#state();
        return;
      }
      if (!this.#session.authenticated) throw new Error('Session authentication required');
      if ((payload.kind === 'frame' && this.#session.role !== 'viewer') || (payload.kind === 'input' && this.#session.role !== 'host')) {
        throw new Error('Invalid session role');
      }
      this.emit('payload', payload);
    } catch {
      this.#report('invalid-payload', 'An encrypted session message could not be verified');
      this.disconnect();
    }
  }

  #dropIncoming(requestId) {
    const pending = this.#incoming.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#incoming.delete(requestId);
  }

  #dropOutgoing(error) {
    const pending = this.#outgoing;
    if (!pending) return;
    this.#outgoing = null;
    clearTimeout(pending.timer);
    pending.password = null;
    pending.passwordKey?.fill(0);
    pending.completion.reject(error);
  }

  #clearRequests(error) {
    for (const requestId of this.#incoming.keys()) this.#dropIncoming(requestId);
    this.#dropOutgoing(error);
  }

  #endSession() {
    clearTimeout(this.#authenticationTimer); this.#authenticationTimer = null;
    this.#cipher?.destroy();
    this.#cipher = null;
    this.#session = null;
  }
}

export default RelayClient;
