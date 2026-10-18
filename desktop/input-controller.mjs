import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = new Set(['move', 'down', 'up', 'scroll', 'keyDown', 'keyUp', 'text']);
const KEY_CODES = new Set([
  ...Array.from({ length: 26 }, (_, n) => `Key${String.fromCharCode(65 + n)}`),
  ...Array.from({ length: 10 }, (_, n) => `Digit${n}`),
  ...Array.from({ length: 10 }, (_, n) => `Numpad${n}`),
  ...Array.from({ length: 20 }, (_, n) => `F${n + 1}`),
  'Enter', 'Escape', 'Backspace', 'Tab', 'Space', 'Minus', 'Equal', 'BracketLeft',
  'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period',
  'Slash', 'CapsLock', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'NumpadDecimal', 'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDivide',
  'NumpadEnter', 'NumpadEqual', 'NumLock', 'ScrollLock', 'PrintScreen', 'Pause',
  'ContextMenu',
]);
const nativeDirectory = fileURLToPath(new URL('./native/', import.meta.url));

function validNumber(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== 'input' || !EVENTS.has(input.event)) return null;
  const result = { kind: 'input', event: input.event, modifiers: {} };
  if (input.modifiers !== undefined && (!input.modifiers || typeof input.modifiers !== 'object' || Array.isArray(input.modifiers))) return null;
  for (const flag of ['shift', 'ctrl', 'alt', 'meta']) {
    const value = input.modifiers?.[flag];
    if (value !== undefined && typeof value !== 'boolean') return null;
    result.modifiers[flag] = value === true;
  }
  for (const coordinate of ['x', 'y']) {
    if (input[coordinate] !== undefined) {
      if (!validNumber(input[coordinate], 0, 1)) return null;
      result[coordinate] = input[coordinate];
    }
  }
  if (['move', 'down', 'up'].includes(input.event) && (result.x === undefined || result.y === undefined)) return null;
  if (['down', 'up'].includes(input.event)) {
    if (!Number.isInteger(input.button) || input.button < 0 || input.button > 2) return null;
    result.button = input.button;
  }
  if (input.event === 'scroll') {
    if (!validNumber(input.deltaX ?? 0, -2000, 2000) || !validNumber(input.deltaY ?? 0, -2000, 2000)) return null;
    result.deltaX = input.deltaX ?? 0;
    result.deltaY = input.deltaY ?? 0;
  }
  if (input.event === 'keyDown' || input.event === 'keyUp') {
    if (typeof input.code !== 'string' || !KEY_CODES.has(input.code)) return null;
    if (input.key !== undefined && (typeof input.key !== 'string' || input.key.length > 64)) return null;
    result.code = input.code;
    result.key = input.key ?? '';
  }
  if (input.event === 'text') {
    if (typeof input.text !== 'string' || !input.text.length || input.text.length > 512 || Buffer.byteLength(input.text, 'utf8') > 4096 || input.text.includes('\0')) return null;
    result.text = input.text;
  }
  return result;
}

/** Starts only when main calls start() after approving the remote session. */
export class InputController {
  constructor({ resourcesPath, onStatus = () => {} } = {}) {
    this.nativePath = resourcesPath ? path.resolve(resourcesPath, 'native') : nativeDirectory;
    this.onStatus = onStatus;
    this.child = null;
    this.state = { supported: ['darwin', 'win32', 'linux'].includes(process.platform), permission: null, status: 'not-started' };
    this.lastMove = 0;
    this.lastScroll = 0;
    this.pendingMove = null;
    this.pendingScroll = null;
    this.moveTimer = null;
    this.scrollTimer = null;
    this.tokens = 240;
    this.tokenTime = performance.now();
    this.starting = null;
    this.stopping = null;
    this.recovering = null;
    this.tracking = new WeakMap();
    this.releaseFailure = false;
    this.generation = 0;
  }

  _update(update) {
    this.state = { ...this.state, ...update };
    try { this.onStatus({ ...this.state }); } catch { /* A UI callback must not keep keys held. */ }
    return { ...this.state };
  }

  _command() {
    if (process.platform === 'darwin') return { executable: path.join(this.nativePath, 'phremote-input-macos'), args: [] };
    if (process.platform === 'win32') {
      return { executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.nativePath, 'phremote-input-windows.ps1')] };
    }
    if (process.platform === 'linux') return { executable: 'python3', args: ['-u', path.join(this.nativePath, 'phremote-input-linux.py')] };
    return null;
  }

  async check() {
    if (this.child || this.starting) return { ...this.state };
    const generation = this.generation;
    const command = this._command();
    if (!command) return this._update({ supported: false, permission: false, status: 'unsupported', message: 'Remote input is unavailable on this operating system.' });
    if (process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)) {
      return this._update({ supported: false, permission: false, status: 'view-only', message: 'Wayland is view-only. Remote input requires an X11 session.' });
    }
    if (process.platform === 'linux' && !process.env.DISPLAY) return this._update({ supported: false, permission: false, status: 'view-only', message: 'No X11 DISPLAY is available.' });
    const helper = process.platform === 'darwin' ? command.executable : command.args.at(-1);
    try {
      await access(helper, process.platform === 'darwin' ? constants.X_OK : constants.R_OK);
      if (generation !== this.generation) return { ...this.state };
      return this._update({ supported: true, permission: null, status: 'not-started', message: 'Input helper found. Permissions are checked when an approved session starts.' });
    } catch {
      if (generation !== this.generation) return { ...this.state };
      return this._update({ supported: false, permission: false, status: 'helper-missing', message: `Input helper is missing or inaccessible: ${path.basename(helper)}` });
    }
  }

  async start() {
    const requestedGeneration = this.generation;
    if (this.stopping) await this.stopping;
    if (this.recovering) await this.recovering;
    if (requestedGeneration !== this.generation) return { ...this.state };
    if (this.starting) return this.starting;
    if (this.child) return { ...this.state };
    const generation = this.generation;
    this.starting = (async () => {
      const availability = await this.check();
      if (generation !== this.generation) return { ...this.state };
      if (!availability.supported) return availability;
      this._update({ permission: null, status: 'starting', message: 'Checking local input permissions.' });
      return new Promise((resolve) => {
        const { executable, args } = this._command();
        const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
        this.child = child;
        const held = { keys: new Set(), buttons: new Set(), modifiers: {}, point: { x: 0.5, y: 0.5 } };
        this.tracking.set(child, held);
        let stdout = '';
        let finished = false;
        const finish = () => { if (!finished) { finished = true; clearTimeout(timeout); resolve({ ...this.state }); } };
        const timeout = setTimeout(() => {
          this._update({ permission: false, status: 'helper-error', message: 'Input helper did not become ready.' });
          finish();
          void this.stop();
        }, 15000);
        timeout.unref?.();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.length > 65536) { stdout = ''; this._update({ status: 'helper-error', message: 'Invalid input helper output.' }); finish(); void this.stop(); return; }
          let end;
          while ((end = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (!message || typeof message !== 'object') continue;
            if (message.type === 'ready') {
              if (generation !== this.generation) { finish(); continue; }
              if (message.supported === true && message.permission === true) this.releaseFailure = false;
              this._update({ supported: message.supported === true, permission: message.permission === true, status: message.permission === true && message.supported === true ? 'ready' : (message.status || 'view-only'), message: typeof message.message === 'string' ? message.message.slice(0, 512) : '' });
              finish();
            } else if (message.type === 'error') {
              if (message.releaseAttempted !== true) this._requestRelease(child);
              this._update({ status: 'input-error', message: typeof message.message === 'string' ? message.message.slice(0, 512) : 'Native input failed.' });
            }
          }
        });
        // PowerShell/compiler diagnostics are intentionally kept off the renderer.
        child.stderr.resume();
        child.stdin.on('error', () => {
          if (this.child !== child || this.stopping) return;
          this._update({ permission: false, status: 'helper-error', message: 'The native input channel failed. Releasing input.' });
          finish();
          void this.stop();
        });
        child.on('error', (error) => {
          if (this.child !== child) return;
          this._update({ supported: false, permission: false, status: 'helper-error', message: error.code === 'ENOENT' ? 'The native input helper runtime is unavailable.' : 'The native input helper could not start.' });
          finish();
        });
        child.on('close', (code, signal) => {
          const current = this.child === child;
          if (current) { this.child = null; this._clearPending(); }
          const abnormal = code !== 0 || Boolean(signal) || !child.stdin.writableEnded;
          if (abnormal) this._scheduleRecovery(held);
          else this._clearHeld(held);
          if (current && !['stopping', 'stopped', 'view-only', 'permission-required', 'helper-error', 'unsupported'].includes(this.state.status)) {
            this._update({ permission: false, status: 'helper-error', message: 'The native input helper stopped.' });
          }
          finish();
        });
      });
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  _write(event) {
    if (!this.child || !this.child.stdin.writable || !['ready', 'input-error'].includes(this.state.status)) return false;
    if (this.child.stdin.writableLength > 65536) {
      this._update({ status: 'helper-error', message: 'Input helper cannot keep up. Input has been stopped.' });
      void this.stop();
      return false;
    }
    const child = this.child;
    child.stdin.write(`${JSON.stringify(event)}\n`);
    const held = this.tracking.get(child);
    if (held) {
      if (event.event === 'keyDown') held.keys.add(event.code);
      if (event.event === 'down') held.buttons.add(event.button);
      if (event.x !== undefined && event.y !== undefined) held.point = { x: event.x, y: event.y };
      for (const [flag, pressed] of Object.entries(event.modifiers)) if (pressed) held.modifiers[flag] = true;
    }
    return true;
  }

  _clearHeld(held) {
    held.keys.clear(); held.buttons.clear(); held.modifiers = {};
  }

  _requestRelease(child) {
    if (child.stdin.writable && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify({ kind: 'control', event: 'releaseAll' })}\n`);
  }

  _scheduleRecovery(held) {
    const keys = new Set(held.keys);
    // Windows/X11 synthesize modifier key presses for pointer shortcuts.
    if (process.platform !== 'darwin') {
      for (const [flag, left, right] of [['shift', 'ShiftLeft', 'ShiftRight'], ['ctrl', 'ControlLeft', 'ControlRight'], ['alt', 'AltLeft', 'AltRight'], ['meta', 'MetaLeft', 'MetaRight']]) {
        if (held.modifiers[flag] && !keys.has(left) && !keys.has(right)) keys.add(left);
      }
    }
    const modifiers = { shift: false, ctrl: false, alt: false, meta: false };
    const releases = [
      ...[...keys].map((code) => ({ kind: 'input', event: 'keyUp', code, modifiers })),
      ...[...held.buttons].map((button) => ({ kind: 'input', event: 'up', button, ...held.point, modifiers })),
    ];
    this._clearHeld(held);
    if (!releases.length || this.recovering) return;
    // Retain presses until a graceful helper exit: a queued keyUp might not
    // have reached a crashing process. This replacement only releases inputs
    // touched by this session and never resumes remote control.
    const recovery = this._recoverReleases(releases);
    this.recovering = recovery;
    void recovery.finally(() => { if (this.recovering === recovery) this.recovering = null; });
  }

  _recoverReleases(releases) {
    return new Promise((resolve) => {
      const { executable, args } = this._command();
      let child;
      try { child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
      catch { resolve(false); return; }
      let output = '';
      let sent = false;
      let released = false;
      let hadError = false;
      let done = false;
      const finish = (success) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.releaseFailure = !success;
        if (!success) this._update({ permission: false, status: 'helper-error', message: 'The input helper crashed and could not confirm key release. Press and release any affected modifier locally.' });
        resolve(success);
      };
      const timeout = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, 6000);
      timeout.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (done) return;
        output += chunk;
        if (output.length > 65536) { child.kill('SIGKILL'); finish(false); return; }
        let end;
        while ((end = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (!message || typeof message !== 'object') continue;
          if (message.type === 'error') hadError = true;
          if (message.type === 'released') released = true;
          if (message.type !== 'ready' || sent) continue;
          if (!message.supported || !message.permission) { hadError = true; child.stdin.end(); continue; }
          sent = true;
          child.stdin.end(`${[...releases, { kind: 'control', event: 'releaseAll' }].map((event) => JSON.stringify(event)).join('\n')}\n`);
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => { hadError = true; child.kill(); });
      child.on('error', () => { hadError = true; });
      child.on('close', (code, signal) => finish(sent && released && !hadError && code === 0 && !signal));
    });
  }

  _clearPending() {
    clearTimeout(this.moveTimer); clearTimeout(this.scrollTimer);
    this.moveTimer = null; this.scrollTimer = null;
    this.pendingMove = null; this.pendingScroll = null;
  }

  _flushMove() {
    clearTimeout(this.moveTimer); this.moveTimer = null;
    if (this.pendingMove) { this._write(this.pendingMove); this.pendingMove = null; this.lastMove = performance.now(); }
  }

  _flushScroll() {
    clearTimeout(this.scrollTimer); this.scrollTimer = null;
    if (this.pendingScroll) { this._write(this.pendingScroll); this.pendingScroll = null; this.lastScroll = performance.now(); }
  }

  apply(input) {
    if (!this.child || !['ready', 'input-error'].includes(this.state.status)) return false;
    const event = normalizeInput(input);
    if (!event) return false;
    const now = performance.now();
    this.tokens = Math.min(240, this.tokens + (now - this.tokenTime) * 0.24);
    this.tokenTime = now;
    const release = event.event === 'up' || event.event === 'keyUp';
    if (!release && event.event !== 'move' && event.event !== 'scroll') {
      const cost = event.event === 'text' ? 24 : 1;
      if (this.tokens < cost) return false;
      this.tokens -= cost;
    }
    if (event.event === 'move') {
      this.pendingMove = event;
      const remaining = 1000 / 120 - (now - this.lastMove);
      if (remaining <= 0) this._flushMove();
      else if (!this.moveTimer) { this.moveTimer = setTimeout(() => this._flushMove(), remaining); this.moveTimer.unref?.(); }
      return true;
    }
    this._flushMove();
    if (event.event === 'scroll') {
      if (this.pendingScroll) {
        event.deltaX = Math.max(-2000, Math.min(2000, event.deltaX + this.pendingScroll.deltaX));
        event.deltaY = Math.max(-2000, Math.min(2000, event.deltaY + this.pendingScroll.deltaY));
      }
      this.pendingScroll = event;
      const remaining = 1000 / 60 - (now - this.lastScroll);
      if (remaining <= 0) this._flushScroll();
      else if (!this.scrollTimer) { this.scrollTimer = setTimeout(() => this._flushScroll(), remaining); this.scrollTimer.unref?.(); }
      return true;
    }
    this._flushScroll();
    return this._write(event);
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.generation += 1;
    this._clearPending();
    const child = this.child;
    this._update({ status: 'stopping', message: 'Releasing remote input.' });
    const closing = new Promise((resolve) => {
      if (!child) { resolve(); return; }
      let failsafe;
      const timer = setTimeout(() => {
        child.kill();
        failsafe = setTimeout(() => {
          child.kill('SIGKILL');
          const held = this.tracking.get(child);
          if (held) this._scheduleRecovery(held);
          resolve();
        }, 600);
        failsafe.unref?.();
      }, 1200);
      timer.unref?.();
      child.once('close', () => { clearTimeout(timer); clearTimeout(failsafe); resolve(); });
      if (child.stdin.writable) child.stdin.end(`${JSON.stringify({ kind: 'control', event: 'releaseAll' })}\n`);
      else child.kill();
    });
    this.stopping = (async () => {
      try { await closing; if (this.recovering) await this.recovering; } finally {
        if (this.child === child) this.child = null;
        this.stopping = null;
        this._update(this.releaseFailure
          ? { permission: false, status: 'helper-error', message: 'Remote input stopped. Key release could not be confirmed; press and release any affected modifier locally.' }
          : { permission: null, status: 'stopped', message: 'Remote input stopped.' });
      }
      return { ...this.state };
    })();
    return this.stopping;
  }
}

export default InputController;
