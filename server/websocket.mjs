import { createHash, randomBytes } from 'node:crypto';

const decoder = new TextDecoder('utf-8', { fatal: true });
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload = Buffer.alloc(0)) {
  const size = payload.length;
  const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (size < 126) header[1] = size;
  else if (size <= 65535) { header[1] = 126; header.writeUInt16BE(size, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(size), 2); }
  return Buffer.concat([header, payload]);
}

export function validateUpgrade(request) {
  const key = request.headers['sec-websocket-key'];
  return request.method === 'GET'
    && request.headers.upgrade?.toLowerCase() === 'websocket'
    && request.headers.connection?.toLowerCase().split(',').some((x) => x.trim() === 'upgrade')
    && request.headers['sec-websocket-version'] === '13'
    && typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key)
    && Buffer.from(key, 'base64').length === 16;
}

export function upgrade(request, socket, head, options = {}) {
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketPeer(socket, head, options);
}

class WebSocketPeer {
  constructor(socket, head, { maxMessageBytes = 256 * 1024, maxBufferedBytes = 1024 * 1024 } = {}) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentCount = 0;
    this.fragmented = false;
    this.closed = false;
    this.awaitingPong = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => this.terminate());
    // HTTP upgraded sockets can allow a half-open TCP connection. EOF means
    // there can be no more WebSocket frames: release the writable half too.
    socket.on('end', () => this.terminate());
    socket.on('close', () => this.finish());
    // The relay installs handlers synchronously after upgrade returns.
    if (head.length) queueMicrotask(() => this.receive(head));
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onClose?.();
  }

  terminate() {
    this.finish();
    this.socket.destroy();
  }

  write(opcode, payload) {
    if (this.closed || !this.socket.writable) return false;
    const encoded = frame(opcode, payload);
    if (this.socket.writableLength + encoded.length > this.maxBufferedBytes) {
      this.close(1013, 'Slow receiver');
      return false;
    }
    this.socket.write(encoded);
    return true;
  }

  send(message) {
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > this.maxMessageBytes) { this.close(1009, 'Message too large'); return false; }
    return this.write(1, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code);
    payload.write(reason, 2);
    this.finish();
    this.socket.end(frame(8, payload));
    const timer = setTimeout(() => this.socket.destroy(), 1000);
    timer.unref();
    this.socket.once('close', () => clearTimeout(timer));
  }

  heartbeat() {
    if (this.awaitingPong) { this.close(1001, 'Heartbeat timeout'); return; }
    this.awaitingPong = randomBytes(8);
    this.write(9, this.awaitingPong);
  }

  receive(chunk) {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > this.maxMessageBytes + 65536 + 14) {
      this.close(1009, 'Input buffer too large'); return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 15;
      const control = opcode >= 8;
      let length = second & 127;
      let offset = 2;
      if ((first & 0x70) || !(second & 0x80) || ![0, 1, 2, 8, 9, 10].includes(opcode)) {
        this.close(1002, 'Invalid frame'); return;
      }
      if (control && (!fin || length > 125)) { this.close(1002, 'Invalid control frame'); return; }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
        if (length < 126) { this.close(1002, 'Invalid length'); return; }
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const bigLength = this.buffer.readBigUInt64BE(2); offset = 10;
        if (bigLength < 65536n || bigLength > BigInt(this.maxMessageBytes)) {
          this.close(bigLength < 65536n ? 1002 : 1009, 'Invalid length'); return;
        }
        length = Number(bigLength);
      }
      if (length > this.maxMessageBytes) { this.close(1009, 'Message too large'); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 8) {
        if (length === 1) { this.close(1002, 'Invalid close'); return; }
        if (length >= 2) {
          const code = payload.readUInt16BE();
          if (!((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))) {
            this.close(1002, 'Invalid close code'); return;
          }
          try { decoder.decode(payload.subarray(2)); } catch { this.close(1007, 'Invalid UTF-8'); return; }
        }
        this.finish(); this.socket.end(frame(8, payload));
        const timer = setTimeout(() => this.socket.destroy(), 1000); timer.unref();
        this.socket.once('close', () => clearTimeout(timer));
        return;
      }
      if (opcode === 9) { this.write(10, payload); continue; }
      if (opcode === 10) {
        if (this.awaitingPong?.equals(payload)) this.awaitingPong = null;
        continue;
      }
      if (opcode === 2) { this.close(1003, 'Text messages required'); return; }
      if ((opcode === 0 && !this.fragmented) || (opcode === 1 && this.fragmented)) {
        this.close(1002, 'Invalid fragmentation'); return;
      }
      this.fragmentBytes += length;
      this.fragmentCount += 1;
      if (this.fragmentBytes > this.maxMessageBytes || this.fragmentCount > 128) {
        this.close(1009, 'Message too large'); return;
      }
      this.fragments.push(payload);
      if (!fin) { this.fragmented = true; continue; }
      const message = this.fragments.length === 1 ? payload : Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = []; this.fragmentBytes = 0; this.fragmentCount = 0; this.fragmented = false;
      let text;
      try { text = decoder.decode(message); }
      catch { this.close(1007, 'Invalid UTF-8'); return; }
      this.onMessage?.(text);
    }
  }
}
