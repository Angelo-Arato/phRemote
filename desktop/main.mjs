import { app, BrowserWindow, ipcMain, Menu, session, desktopCapturer, screen, systemPreferences, shell, clipboard, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RelayClient } from './core/relay-client.mjs';
import { InputController } from './input-controller.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smokeOutput = process.env.PHREMOTE_SMOKE_OUTPUT;
const trace = message => { if (smokeOutput) console.log('[phremote-smoke] ' + message); };
if (process.env.PHREMOTE_PROFILE) app.setPath('userData', path.resolve(process.env.PHREMOTE_PROFILE));
else if (smokeOutput) app.setPath('userData', path.join(os.tmpdir(), 'phremote-ui-smoke-' + process.pid));
app.setName('phRemote');
let window, client, input;
let inputStarting = false;
let inputAttemptedFor;
let inputStatus = { supported: process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY, permission: null };
let quitting = false;
let lastError = null;
let notices = [];
let chat = [];
let config = {
  relayUrl: 'ws://127.0.0.1:8787/ws',
  name: os.hostname().slice(0, 80),
  allowControl: true,
  contacts: []
};
let identities = {};
const profilePath = () => app.getPath('userData');
const uiUrl = new URL('./ui/index.html', import.meta.url).href;

async function atomicJson(name, value) {
  await mkdir(profilePath(), { recursive: true, mode: 0o700 });
  const dest = path.join(profilePath(), name);
  const tmp = dest + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, dest);
}

function validateRelay(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Indirizzo relay non valido.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Inserisci un indirizzo wss:// del relay.'); }
  if (url.username || url.password || url.hash || url.search) throw new Error('Il relay non può contenere credenziali, parametri o frammenti.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) throw new Error('Per un relay su Internet è richiesto wss:// con certificato valido.');
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return url.href;
}

async function loadConfig() {
  try {
    const data = JSON.parse(await readFile(path.join(profilePath(), 'settings.json'), 'utf8'));
    config = {
      relayUrl: validateRelay(data.relayUrl ?? config.relayUrl),
      name: String(data.name ?? config.name).trim().slice(0, 80) || config.name,
      allowControl: data.allowControl !== false,
      contacts: Array.isArray(data.contacts) ? data.contacts.slice(0, 200).filter(c => /^[0-9]{9}$/.test(c.id) && typeof c.name === 'string').map(c => ({ id: c.id, name: c.name.slice(0, 80) })) : []
    };
  } catch {}
  try {
    if (!smokeOutput && secureStorageAvailable()) {
      const encrypted = await readFile(path.join(profilePath(), 'identities.enc'));
      identities = JSON.parse(safeStorage.decryptString(encrypted));
    }
  } catch { identities = {}; }
}

async function saveIdentity(identity) {
  if (smokeOutput) { identities[config.relayUrl] = identity; return; }
  if (!secureStorageAvailable()) {
    addNotice('Il sistema non offre un archivio cifrato: l’identità resta solo in memoria e cambierà al riavvio.');
    return;
  }
  identities[config.relayUrl] = identity;
  await mkdir(profilePath(), { recursive: true, mode: 0o700 });
  const dest = path.join(profilePath(), 'identities.enc');
  const tmp = dest + '.tmp';
  await writeFile(tmp, safeStorage.encryptString(JSON.stringify(identities)), { mode: 0o600 });
  await rename(tmp, dest);
}

function secureStorageAvailable() {
  return safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');
}

function permissions() {
  const mac = process.platform === 'darwin';
  return {
    platform: process.platform,
    screen: mac ? systemPreferences.getMediaAccessStatus('screen') : 'available',
    accessibility: mac ? systemPreferences.isTrustedAccessibilityClient(false) : null,
    input: inputStatus,
    wayland: process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
  };
}

function publicState() {
  return {
    ...(client?.snapshot() ?? { relay: 'offline', deviceId: null, name: config.name, password: '', incoming: [], session: null }),
    config, permissions: permissions(), lastError, notices: notices.slice(-5), chat: chat.slice(-100),
    version: app.getVersion()
  };
}
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('phremote:state', publicState());
}
function addNotice(message) {
  if (notices.at(-1)?.message === message) return;
  notices.push({ message, time: Date.now() });
  notices = notices.slice(-5);
  publish();
}
function fail(error) {
  lastError = typeof error === 'string' ? error : error?.message || 'Operazione non riuscita.';
  publish();
}

async function syncInput() {
  const current = client?.snapshot().session;
  const shouldRun = current?.role === 'host' && current.authenticated && config.allowControl;
  if (!shouldRun) {
    inputAttemptedFor = undefined;
    await input?.stop();
    return;
  }
  if (inputStarting || inputAttemptedFor === current.sessionId) return;
  inputStarting = true;
  inputAttemptedFor = current.sessionId;
  try { await input.start(); }
  catch (error) { addNotice('Sessione in sola visualizzazione: ' + error.message); }
  finally {
    inputStarting = false;
    const latest = client?.snapshot().session;
    if (!latest || latest.sessionId !== current.sessionId || !config.allowControl) {
      await input.stop();
      if (latest?.sessionId !== current.sessionId) void syncInput();
    }
  }
}

function createClient() {
  const previous = client;
  previous?.removeAllListeners();
  previous?.close();
  chat = [];
  client = new RelayClient({
    name: config.name, identity: identities[config.relayUrl], saveIdentity
  });
  client.on('state', () => { publish(); void syncInput(); });
  client.on('error', fail);
  client.on('payload', payload => {
    const current = client.snapshot().session;
    if (!current?.authenticated) return;
    if (payload.kind === 'frame' && current.role === 'viewer') {
      window?.webContents.send('phremote:frame', { ...payload, sessionId: current.sessionId });
    } else if (payload.kind === 'input' && current.role === 'host' && config.allowControl) {
      input.apply(payload);
    } else if (payload.kind === 'chat') {
      chat.push({ text: payload.text, mine: false, time: Date.now() }); chat = chat.slice(-100); publish();
    } else if (payload.kind === 'clipboard') {
      // Received clipboard text is previewed; it never overwrites the local clipboard automatically.
      chat.push({ text: payload.text.slice(0, 16384), mine: false, clipboard: true, time: Date.now() }); chat = chat.slice(-100); publish();
    }
  });
  publish();
}

async function connectRelay() {
  lastError = null;
  if (client.snapshot().relay === 'online') return;
  await client.connect(config.relayUrl);
  publish();
}

function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== uiUrl) throw new Error('Richiesta non autorizzata.');
}
function handle(name, callback) {
  ipcMain.handle('phremote:' + name, async (event, value) => {
    trusted(event);
    try { return { ok: true, value: await callback(value) }; }
    catch (error) { fail(error); return { ok: false, error: error.message || 'Operazione non riuscita.' }; }
  });
}

function registerIpc() {
  handle('state', () => publicState());
  handle('connect-relay', connectRelay);
  handle('disconnect-relay', async () => { client.close(); await input.stop(); publish(); });
  handle('invite', async value => {
    if (!value || typeof value.hostId !== 'string' || typeof value.password !== 'string') throw new Error('Inserisci ID e password del computer remoto.');
    await connectRelay();
    return client.invite(value.hostId.replaceAll(' ', ''), value.password);
  });
  handle('approve', requestId => client.approve(requestId));
  handle('reject', requestId => client.reject(requestId));
  handle('disconnect', async () => { client.disconnect(); await input.stop(); publish(); });
  handle('rotate-password', () => { client.rotatePassword(); publish(); });
  handle('copy-access', () => {
    const s = client.snapshot();
    if (!s.deviceId) throw new Error('Connetti prima questo computer al relay.');
    clipboard.writeText('phRemote\nID: ' + s.deviceId + '\nPassword: ' + s.password + '\nRelay: ' + config.relayUrl);
  });
  handle('clipboard-send', () => {
    const text = clipboard.readText().slice(0, 16384);
    if (!text) throw new Error('Gli appunti non contengono testo.');
    if (!client.send({ kind: 'clipboard', text })) throw new Error('La sessione non è pronta.');
    chat.push({ text, mine: true, clipboard: true, time: Date.now() }); chat = chat.slice(-100); publish();
  });
  handle('clipboard-copy', text => {
    if (typeof text !== 'string' || text.length > 16384) throw new Error('Testo non valido.');
    clipboard.writeText(text);
  });
  handle('chat', text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Messaggio non valido.');
    if (!client.send({ kind: 'chat', text: text.trim() })) throw new Error('La sessione non è pronta.');
    chat.push({ text: text.trim(), mine: true, time: Date.now() }); chat = chat.slice(-100); publish();
  });
  handle('frame', value => {
    if (client.snapshot().session?.role !== 'host' || value?.sessionId !== client.snapshot().session?.sessionId || !value || typeof value.data !== 'string' || value.data.length > 131072 || value.mime !== 'image/jpeg' || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.width > 3840 || value.height < 1 || value.height > 2160) return false;
    return client.send({ kind: 'frame', data: value.data, mime: value.mime, width: value.width, height: value.height });
  });
  handle('input', value => {
    if (client.snapshot().session?.role !== 'viewer' || value?.sessionId !== client.snapshot().session?.sessionId || !value || typeof value !== 'object') return false;
    return client.send({ ...value, kind: 'input' });
  });
  handle('capture-error', async value => {
    if (value?.sessionId !== client.snapshot().session?.sessionId || client.snapshot().session?.role !== 'host') return;
    addNotice('Condivisione schermo interrotta: ' + String(value?.message).slice(0, 300));
    client.disconnect(); await input.stop(); publish();
  });
  handle('save-settings', async value => {
    if (!value || typeof value !== 'object') throw new Error('Impostazioni non valide.');
    const relayUrl = validateRelay(value.relayUrl);
    const name = String(value.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Inserisci un nome per questo computer.');
    const changed = relayUrl !== config.relayUrl || name !== config.name;
    if (changed && (client.snapshot().session || client.snapshot().incoming.length)) throw new Error('Termina le sessioni e le richieste prima di cambiare relay.');
    const nextConfig = { ...config, relayUrl, name, allowControl: value.allowControl === true };
    await atomicJson('settings.json', nextConfig);
    config = nextConfig;
    if (changed) createClient();
    await syncInput(); publish();
  });
  handle('save-contact', async value => {
    const id = String(value?.id || '').replaceAll(' ', '');
    const name = String(value?.name || '').trim().slice(0, 80);
    if (!/^[0-9]{9}$/.test(id) || !name) throw new Error('Inserisci un nome e un ID di 9 cifre.');
    config.contacts = [...config.contacts.filter(c => c.id !== id), { id, name }].slice(-200);
    await atomicJson('settings.json', config); publish();
  });
  handle('remove-contact', async id => {
    config.contacts = config.contacts.filter(c => c.id !== id);
    await atomicJson('settings.json', config); publish();
  });
  handle('permissions', async kind => {
    if (process.platform !== 'darwin') return;
    const targets = { screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility' };
    if (!targets[kind]) throw new Error('Permesso non valido.');
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + targets[kind]);
  });
  handle('refresh-permissions', async () => { inputStatus = await input.check(); inputAttemptedFor = undefined; await syncInput(); publish(); });
}

async function main() {
trace('waiting for app ready');
await app.whenReady();
trace('app ready');
await loadConfig();
trace('config loaded');
input = new InputController({
  resourcesPath: app.isPackaged ? process.resourcesPath : here,
  onStatus: status => {
    inputStatus = status;
    const messages = {
      'view-only': 'Questo ambiente permette la sola visualizzazione dello schermo. Su Linux il controllo richiede una sessione X11.',
      'permission-required': 'Per ricevere mouse e tastiera, consenti Accessibilità nelle impostazioni di sistema.',
      'helper-missing': 'Il controllo remoto non è disponibile su questo computer.',
      'helper-error': 'Il controllo remoto non è disponibile. Puoi continuare in sola visualizzazione.',
      'input-error': 'Il sistema non ha potuto eseguire un comando remoto.'
    };
    if (messages[status?.status]) addNotice(messages[status.status]);
  }
});
inputStatus = await input.check();
trace('input checked');
createClient();
trace('client created');
registerIpc();
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ label: 'phRemote', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
  { label: 'Modifica', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: 'Finestra', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }, { role: 'close' }] }
]));
session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
  const trusted = webContents === window?.webContents && details?.requestingUrl?.split('#')[0] === uiUrl;
  if (!trusted || !client.snapshot().session?.authenticated) return false;
  return permission === 'fullscreen' || permission === 'display-capture' && client.snapshot().session.role === 'host';
});
session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
  const trusted = webContents === window?.webContents && webContents.getURL().split('#')[0] === uiUrl && client.snapshot().session?.authenticated === true;
  callback(trusted && (permission === 'fullscreen' || permission === 'display-capture' && client.snapshot().session.role === 'host'));
});
session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
  try {
    const active = client.snapshot().session;
    if (request.frame !== window?.webContents.mainFrame || active?.role !== 'host' || !active.authenticated) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (client.snapshot().session?.sessionId !== active.sessionId) return callback({});
    const primary = String(screen.getPrimaryDisplay().id);
    const source = sources.find(s => s.display_id === primary) || sources[0];
    if (!source) return callback({});
    callback({ video: source, audio: undefined });
  } catch { callback({}); }
}, { useSystemPicker: false });

window = new BrowserWindow({
  width: 1120, height: 790, minWidth: 880, minHeight: 650, show: !smokeOutput,
  title: 'phRemote', backgroundColor: '#f6f8fc',
  titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  trafficLightPosition: { x: 18, y: 20 },
  webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
});
trace('window created');
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
window.webContents.on('will-attach-webview', event => event.preventDefault());
window.webContents.on('render-process-gone', () => { client.disconnect(); void input.stop(); });
window.on('close', () => { client.close(); void input.stop(); });
window.on('focus', publish);
await window.loadFile(path.join(here, 'ui', 'index.html'));
trace('UI loaded');
if (smokeOutput) {
  try {
    const result = await window.webContents.executeJavaScript('({title:document.title,heading:document.querySelector("h1").textContent,buttons:document.querySelectorAll("button").length,bridge:typeof window.phremote})');
    trace('bridge checked');
    if (process.env.PHREMOTE_SMOKE_RELAY) {
      const relayUrl = validateRelay(process.env.PHREMOTE_SMOKE_RELAY);
      if (new URL(relayUrl).protocol !== 'ws:') throw new Error('UI smoke requires local relay');
      await window.webContents.executeJavaScript('window.phremote.saveSettings(' + JSON.stringify({ name: 'Mac di verifica', relayUrl, allowControl: true }) + ')');
      await window.webContents.executeJavaScript('window.phremote.connectRelay()');
      const online = await window.webContents.executeJavaScript('window.phremote.state().then(s=>({online:s.relay==="online",hasId:/^[0-9]{9}$/.test(s.deviceId)}))');
      if (!online.online || !online.hasId) throw new Error('UI could not register with local relay');
      await window.webContents.executeJavaScript('window.phremote.saveContact({id:"123456789",name:"Computer di verifica"})');
      const contacts = await window.webContents.executeJavaScript('window.phremote.state().then(s=>s.config.contacts.length)');
      if (contacts !== 1) throw new Error('UI address book failed');
      await window.webContents.executeJavaScript('document.querySelector("[data-page=contacts]").click()');
      const rendered = await window.webContents.executeJavaScript('document.querySelectorAll(".contact-item").length');
      if (rendered !== 1) throw new Error('Address book was not rendered');
      await window.webContents.executeJavaScript('document.querySelector("[data-page=connection]").click()');
      Object.assign(result, online, { contacts });
    }
    await new Promise(resolve => setTimeout(resolve, 350));
    const image = await window.webContents.capturePage();
    trace('preview captured');
    await writeFile(smokeOutput + '.png', image.toPNG());
    await writeFile(smokeOutput + '.json', JSON.stringify(result, null, 2));
    app.exit(result.bridge === 'object' && result.buttons > 5 ? 0 : 1);
  } catch (error) { console.error('UI smoke failed:', error.message); app.exit(1); }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  client?.close();
  Promise.resolve(input?.stop()).finally(() => app.quit());
});
}
void main().catch(error => {
  console.error('phRemote could not start:', error.message);
  app.exit(1);
});
