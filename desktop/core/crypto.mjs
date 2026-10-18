import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
  randomBytes, timingSafeEqual,
} from 'node:crypto';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
export const MAX_FRAME_BASE64 = 128 * 1024;
export const MAX_PLAINTEXT_BYTES = 150 * 1024;
export const MAX_WIRE_BYTES = 256 * 1024;

export function randomPassword() {
  return randomBytes(24).toString('base64url');
}

export function decodeBase64(value, length, maxLength = length) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxLength / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid binary field');
  }
  const bytes = Buffer.from(value, 'base64');
  if ((length !== undefined && bytes.length !== length) || bytes.length > maxLength || bytes.toString('base64') !== value) {
    throw new Error('Invalid binary field');
  }
  return bytes;
}

export function createEphemeralKey() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey: der.subarray(-32).toString('base64') };
}

export function createChallenge(ephemeral = createEphemeralKey()) {
  return {
    ephemeral,
    challenge: {
      publicKey: ephemeral.publicKey,
      salt: randomBytes(32).toString('base64'),
      nonce: randomBytes(32).toString('base64'),
    },
  };
}

export function validateChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) throw new Error('Invalid challenge');
  decodeBase64(challenge.publicKey, 32);
  decodeBase64(challenge.salt, 32);
  decodeBase64(challenge.nonce, 32);
  return { publicKey: challenge.publicKey, salt: challenge.salt, nonce: challenge.nonce };
}

export function canonicalTranscript({ requestId, hostId, viewerId, challenge, viewerPublicKey }) {
  validateChallenge(challenge);
  decodeBase64(viewerPublicKey, 32);
  if (typeof requestId !== 'string' || !requestId.length || requestId.length > 128 ||
      !/^\d{9}$/.test(hostId) || !/^\d{9}$/.test(viewerId)) throw new Error('Invalid transcript');
  return JSON.stringify([
    'phremote-proof-v1', requestId, hostId, viewerId,
    challenge.publicKey, viewerPublicKey, challenge.salt, challenge.nonce,
  ]);
}

export function createPasswordProof(password, transcriptFields) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256) throw new Error('Invalid session password');
  const passwordKey = createHash('sha256').update(password, 'utf8').digest();
  try {
    return createHmac('sha256', passwordKey).update(canonicalTranscript(transcriptFields)).digest('base64');
  } finally {
    passwordKey.fill(0);
  }
}

export function verifyPasswordProof(password, transcriptFields, mac) {
  try {
    return timingSafeEqual(decodeBase64(mac, 32), Buffer.from(createPasswordProof(password, transcriptFields), 'base64'));
  } catch {
    return false;
  }
}

function deriveKeys({ privateKey, peerPublicKey, requestId, hostId, viewerId, challenge, viewerPublicKey, passwordKey }) {
  validateChallenge(challenge);
  if (!Buffer.isBuffer(passwordKey) || passwordKey.length !== 32) throw new Error('Session authentication required');
  const transcript = canonicalTranscript({ requestId, hostId, viewerId, challenge, viewerPublicKey });
  const rawPublicKey = decodeBase64(peerPublicKey, 32);
  const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, rawPublicKey]), type: 'spki', format: 'der' });
  const shared = diffieHellman({ privateKey, publicKey });
  const authenticatedSecret = Buffer.concat([shared, passwordKey]);
  const salt = decodeBase64(challenge.salt, 32);
  const derive = direction => Buffer.from(hkdfSync('sha256', authenticatedSecret, salt,
    Buffer.from(JSON.stringify(['phremote-session-v1', transcript, direction])), 32));
  try {
    return { hostToViewer: derive('host-to-viewer'), viewerToHost: derive('viewer-to-host') };
  } finally {
    shared.fill(0);
    authenticatedSecret.fill(0);
  }
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid payload');
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
  if (payload.kind === 'frame') {
    if (!['image/jpeg', 'image/png'].includes(payload.mime) ||
        !Number.isInteger(payload.width) || payload.width < 1 || payload.width > 16384 ||
        !Number.isInteger(payload.height) || payload.height < 1 || payload.height > 16384 ||
        typeof payload.data !== 'string' || payload.data.length < 4 || payload.data.length > MAX_FRAME_BASE64) throw new Error('Invalid frame');
    decodeBase64(payload.data, undefined, 96 * 1024);
    return { kind: 'frame', data: payload.data, mime: payload.mime, width: payload.width, height: payload.height };
  }
  if (payload.kind === 'input') {
    if (!['move', 'down', 'up', 'scroll', 'keyDown', 'keyUp', 'text'].includes(payload.event)) throw new Error('Invalid input');
    const clean = { kind: 'input', event: payload.event };
    if (['move', 'down', 'up'].includes(payload.event)) {
      if (![payload.x, payload.y].every(n => finite(n) && n >= 0 && n <= 1)) throw new Error('Invalid input position');
      clean.x = payload.x; clean.y = payload.y;
    }
    if (['down', 'up'].includes(payload.event)) {
      if (![0, 1, 2].includes(payload.button)) throw new Error('Invalid input button');
      clean.button = payload.button;
    }
    if (payload.event === 'scroll') {
      if (![payload.deltaX, payload.deltaY].every(n => finite(n) && Math.abs(n) <= 10000)) throw new Error('Invalid input scroll');
      clean.deltaX = payload.deltaX; clean.deltaY = payload.deltaY;
    }
    if (['keyDown', 'keyUp'].includes(payload.event)) {
      if (!text(payload.code, 64) || !text(payload.key, 64)) throw new Error('Invalid input key');
      clean.code = payload.code; clean.key = payload.key;
    }
    if (payload.event === 'text') {
      if (!text(payload.text, 4096)) throw new Error('Invalid input text');
      clean.text = payload.text;
    }
    if (payload.modifiers !== undefined) {
      if (!payload.modifiers || typeof payload.modifiers !== 'object' || Array.isArray(payload.modifiers)) throw new Error('Invalid input modifiers');
      clean.modifiers = {};
      for (const key of ['shift', 'ctrl', 'alt', 'meta']) {
        if (payload.modifiers[key] !== undefined && typeof payload.modifiers[key] !== 'boolean') throw new Error('Invalid input modifiers');
        clean.modifiers[key] = payload.modifiers[key] === true;
      }
    }
    return clean;
  }
  if (payload.kind === 'chat' || payload.kind === 'clipboard') {
    if (!text(payload.text, payload.kind === 'chat' ? 4096 : 65536)) throw new Error('Invalid text payload');
    return { kind: payload.kind, text: payload.text };
  }
  throw new Error('Unknown payload kind');
}

export function createSessionCipher({ role, sessionId, requestId, hostId, viewerId, privateKey, peerPublicKey, challenge, viewerPublicKey, passwordKey }) {
  if (!['host', 'viewer'].includes(role) || typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 128) throw new Error('Invalid session');
  const keys = deriveKeys({ privateKey, peerPublicKey, requestId, hostId, viewerId, challenge, viewerPublicKey, passwordKey });
  const sendDirection = role === 'host' ? 'host-to-viewer' : 'viewer-to-host';
  const receiveDirection = role === 'host' ? 'viewer-to-host' : 'host-to-viewer';
  const sendKey = role === 'host' ? keys.hostToViewer : keys.viewerToHost;
  const receiveKey = role === 'host' ? keys.viewerToHost : keys.hostToViewer;
  let sent = 0, received = 0, destroyed = false;
  const aad = (direction, seq) => Buffer.from(JSON.stringify(['phremote-data-v1', sessionId, requestId, direction, seq]));
  return {
    seal(payload) {
      if (destroyed) throw new Error('Session ended');
      const plain = Buffer.from(JSON.stringify(payload?.kind === 'ready' ? { kind: 'ready' } : validatePayload(payload)));
      if (plain.length > MAX_PLAINTEXT_BYTES || sent >= Number.MAX_SAFE_INTEGER) throw new Error('Payload limit exceeded');
      const seq = sent + 1;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', sendKey, nonce);
      cipher.setAAD(aad(sendDirection, seq));
      const encrypted = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
      sent = seq;
      return { v: 1, seq, data: encrypted.toString('base64') };
    },
    open(envelope) {
      if (destroyed) throw new Error('Session ended');
      if (!envelope || envelope.v !== 1 || !Number.isSafeInteger(envelope.seq) || envelope.seq !== received + 1) throw new Error('Invalid message sequence');
      const encrypted = decodeBase64(envelope.data, undefined, MAX_PLAINTEXT_BYTES + 28);
      if (encrypted.length < 30) throw new Error('Invalid encrypted payload');
      const decipher = createDecipheriv('aes-256-gcm', receiveKey, encrypted.subarray(0, 12));
      decipher.setAAD(aad(receiveDirection, envelope.seq));
      decipher.setAuthTag(encrypted.subarray(-16));
      const plain = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
      const decoded = JSON.parse(plain.toString('utf8'));
      const payload = decoded?.kind === 'ready' ? { kind: 'ready' } : validatePayload(decoded);
      received = envelope.seq;
      return payload;
    },
    destroy() {
      destroyed = true;
      keys.hostToViewer.fill(0);
      keys.viewerToHost.fill(0);
    },
  };
}
