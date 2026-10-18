/* The renderer has no Node access; all native operations cross the bounded preload API. */
const api = window.phremote;
const $ = id => document.getElementById(id);
let state;
let currentPage = 'connection';
let busy = false;
let toastTimer;
let previousSession;
let settingsInitialized = false;
let captureStream;
let captureFor;
let captureGeneration = 0;
let capturing = false;
let framesReceived = 0;
const pressedKeys = new Set();
const pressedButtons = new Set();
let lastPosition = { x: 0.5, y: 0.5 };
const sendInput = value => api.sendInput({ ...value, sessionId: state?.session?.sessionId }).catch(() => false);
const formatId = id => id ? id.match(/.{1,3}/g).join(' ') : '••• ••• •••';
const platformName = platform => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[platform] || 'Desktop';

function toast(message) {
  $('toast').textContent = message; $('toast').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500);
}
async function run(operation, success) {
  try { const result = await operation(); if (success) toast(success); return result; }
  catch (error) { toast(error.message); return undefined; }
}
function go(page) {
  if (currentPage === 'viewer' && page !== 'viewer') releaseInput();
  if (page === 'viewer' && state?.session?.role !== 'viewer') page = 'connection';
  currentPage = page;
  document.querySelectorAll('.page').forEach(element => element.classList.toggle('active', element.id === 'page-' + page));
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.page === page || page === 'viewer' && button.dataset.page === 'connection'));
}
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); go('connection'); });
document.querySelectorAll('[data-page],[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.page || button.dataset.go)));
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderIncoming() {
  $('incoming-list').replaceChildren();
  for (const incoming of state.incoming || []) {
    const card = el('div', 'incoming-card');
    const text = el('div', 'incoming-text');
    text.append(el('strong', '', incoming.viewerName || 'Richiesta di collegamento'));
    text.append(el('p', '', formatId(incoming.viewerId) + (incoming.verified ? ' · Password verificata. Vuoi condividere lo schermo?' : ' · Verifica della password in corso…')));
    const reject = el('button', 'button secondary', 'Rifiuta');
    reject.addEventListener('click', () => run(() => api.reject(incoming.requestId)));
    const approve = el('button', 'button primary', state.config.allowControl ? 'Consenti schermo e controllo' : 'Condividi solo lo schermo');
    approve.disabled = !incoming.verified;
    approve.addEventListener('click', () => run(() => api.approve(incoming.requestId)));
    card.append(text, reject, approve); $('incoming-list').append(card);
  }
}
function renderContacts() {
  $('contacts-list').replaceChildren();
  if (!state.config.contacts.length) {
    $('contacts-list').append(el('div', 'empty-state', 'La tua rubrica è pronta.\nAggiungi il primo computer per ritrovarlo qui.'));
    return;
  }
  for (const contact of state.config.contacts) {
    const card = el('article', 'card contact-item');
    const icon = el('div', 'contact-icon', '▱');
    const info = el('div', 'contact-info'); info.append(el('strong', '', contact.name), el('span', '', formatId(contact.id)));
    const connect = el('button', 'button primary', 'Connetti');
    connect.addEventListener('click', () => { $('remote-id').value = formatId(contact.id); $('remote-password').value = ''; go('connection'); $('remote-password').focus(); });
    const remove = el('button', 'button secondary', 'Rimuovi');
    remove.addEventListener('click', () => run(() => api.removeContact(contact.id)));
    card.append(icon, info, connect, remove); $('contacts-list').append(card);
  }
}
function permissionRow(title, help, status, good, action) {
  const row = el('div', 'permission-row');
  const details = el('div'); details.append(el('strong', '', title), el('small', '', help));
  row.append(details, el('span', 'permission-state' + (good ? ' good' : ''), status));
  if (action) {
    const button = el('button', 'button secondary', 'Apri impostazioni');
    button.addEventListener('click', () => run(action)); row.append(button);
  }
  return row;
}
function renderPermissions() {
  const permissions = state.permissions;
  const list = $('permissions-list'); list.replaceChildren();
  if (permissions.platform === 'darwin') {
    const granted = permissions.screen === 'granted';
    list.append(permissionRow('Registrazione schermo', 'Necessaria per condividere lo schermo di questo Mac.', granted ? 'Consentita' : 'Da consentire', granted, () => api.openPermissions('screen')));
    list.append(permissionRow('Accessibilità', 'Necessaria per ricevere mouse e tastiera remoti.', permissions.accessibility ? 'Consentita' : 'Da consentire', permissions.accessibility, () => api.openPermissions('accessibility')));
  } else if (permissions.wayland) {
    list.append(permissionRow('Schermo e input su Wayland', 'Seleziona lo schermo nel portale di sistema. Per il controllo di mouse e tastiera accedi a una sessione X11.', 'Sola visualizzazione', false));
  } else {
    list.append(permissionRow('Schermo e input', permissions.platform === 'win32' ? 'Il controllo di finestre elevate richiede privilegi coerenti. phRemote non richiede elevazione automatica.' : 'Sono richiesti Python 3 e le librerie libX11 / libXtst.', 'Verificati all’avvio della sessione', true));
  }
}
function renderChat() {
  for (const container of [$('host-messages'), $('viewer-messages')]) {
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    container.replaceChildren();
    for (const item of state.chat || []) {
      const message = el('div', 'message' + (item.mine ? ' mine' : ''));
      if (item.clipboard) message.append(el('small', '', item.mine ? 'APPUNTI INVIATI' : 'APPUNTI RICEVUTI'));
      message.append(document.createTextNode(item.text));
      if (item.clipboard && !item.mine) {
        const copy = el('button', 'text-button', 'Copia negli appunti');
        copy.addEventListener('click', () => run(() => api.copyClipboard(item.text), 'Testo copiato'));
        message.append(copy);
      }
      container.append(message);
    }
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }
}
function render(next) {
  state = next;
  const online = state.relay === 'online';
  const connecting = state.relay === 'connecting';
  $('device-name').textContent = state.name || state.config.name;
  $('platform-label').textContent = platformName(state.permissions.platform);
  $('local-id').textContent = formatId(state.deviceId);
  $('local-password').value = state.password || '';
  $('copy-access').disabled = !online;
  $('rotate-password').disabled = Boolean(state.session) || Boolean(state.incoming?.length);
  $('relay-badge').classList.toggle('online', online);
  $('relay-badge').lastElementChild.textContent = online ? 'Relay connesso' : connecting ? 'Connessione…' : 'Relay non connesso';
  $('receive-state').replaceChildren(el('i', 'status-dot' + (online ? ' online' : '')), document.createTextNode(online ? 'Pronto a ricevere' : connecting ? 'Connessione…' : 'Non disponibile'));
  $('toggle-receive').textContent = online ? 'Disattiva' : connecting ? 'Attendi…' : 'Attiva ricezione';
  $('toggle-receive').disabled = connecting;
  $('global-status-dot').classList.toggle('online', online);
  $('global-status').textContent = state.session ? state.session.role === 'host' ? 'Stai condividendo questo computer' : 'Sessione remota attiva' : online ? 'Pronto a ricevere richieste di collegamento' : connecting ? 'Connessione al relay in corso…' : 'Pronto per iniziare';
  const relay = new URL(state.config.relayUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname);
  $('status-relay').textContent = local ? 'Relay locale · da configurare per Internet' : relay.hostname + ' · TLS';
  $('relay-note').classList.toggle('hidden', !local && online);
  $('error-banner').textContent = state.lastError || '';
  $('error-banner').classList.toggle('hidden', !state.lastError);
  const notice = state.notices?.at(-1)?.message;
  $('notice-banner').textContent = notice || '';
  $('notice-banner').classList.toggle('hidden', !notice);
  $('app-version').textContent = state.version;
  $('about-version').textContent = state.version;
  const host = state.session?.role === 'host';
  $('host-session').classList.toggle('hidden', !host);
  $('host-chat').classList.toggle('hidden', !host || !state.session.authenticated);
  $('host-session-title').textContent = state.config.allowControl ? 'Stai condividendo schermo, mouse e tastiera' : 'Stai condividendo lo schermo';
  const viewer = state.session?.role === 'viewer';
  if (viewer && previousSession !== state.session.sessionId) {
    framesReceived = 0; $('remote-frame').removeAttribute('src'); $('remote-canvas').classList.remove('has-frame');
    $('viewer-title').textContent = 'Computer ' + formatId(state.session.peerId); go('viewer');
  }
  if (!state.session && previousSession) { go('connection'); releaseInput(); }
  previousSession = state.session?.sessionId;
  if (!settingsInitialized || !['setting-name', 'setting-relay', 'setting-control'].includes(document.activeElement?.id) && currentPage !== 'settings') {
    $('setting-name').value = state.config.name; $('setting-relay').value = state.config.relayUrl;
    $('setting-control').checked = state.config.allowControl; settingsInitialized = true;
  }
  renderIncoming(); renderContacts(); renderPermissions(); renderChat();
  void syncCapture();
}

$('toggle-receive').addEventListener('click', () => run(() => state.relay === 'online' ? api.disconnectRelay() : api.connectRelay()));
$('copy-access').addEventListener('click', () => run(() => api.copyAccess(), 'Dati di accesso copiati. Condividili solo con chi vuoi autorizzare.'));
$('toggle-password').addEventListener('click', () => { const field = $('local-password'); field.type = field.type === 'password' ? 'text' : 'password'; });
$('rotate-password').addEventListener('click', () => run(() => api.rotatePassword(), 'Nuova password generata'));
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; $('connect-button').disabled = true; $('connect-button').firstElementChild.textContent = 'Richiesta in corso…';
  try {
    await api.invite({ hostId: $('remote-id').value.replaceAll(' ', ''), password: $('remote-password').value });
    $('remote-password').value = ''; toast('Richiesta inviata. Attendi l’approvazione sul computer remoto.');
  } catch (error) { toast(error.message); }
  finally { busy = false; $('connect-button').disabled = false; $('connect-button').firstElementChild.textContent = 'Avvia connessione'; }
});
for (const id of ['remote-id', 'contact-id']) $(id).addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 9);
  event.target.value = digits.match(/.{1,3}/g)?.join(' ') || '';
});
$('contact-form').addEventListener('submit', async event => {
  event.preventDefault();
  await run(async () => { await api.saveContact({ name: $('contact-name').value, id: $('contact-id').value }); event.target.reset(); }, 'Computer aggiunto alla rubrica');
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  await run(async () => { await api.saveSettings({ name: $('setting-name').value, relayUrl: $('setting-relay').value, allowControl: $('setting-control').checked }); $('settings-saved').textContent = 'Impostazioni salvate'; }, 'Impostazioni salvate');
});
$('refresh-permissions').addEventListener('click', () => run(() => api.refreshPermissions()));
$('stop-host').addEventListener('click', () => run(() => api.disconnect(), 'Condivisione terminata'));
$('viewer-disconnect').addEventListener('click', () => run(() => api.disconnect()));
$('viewer-fullscreen').addEventListener('click', () => run(() => document.fullscreenElement ? document.exitFullscreen() : $('remote-canvas').requestFullscreen()));
document.querySelectorAll('.chat-form').forEach(form => form.addEventListener('submit', async event => {
  event.preventDefault(); const field = form.elements.message;
  if (!field.value.trim()) return;
  await run(async () => { await api.chat(field.value); field.value = ''; });
}));
document.querySelectorAll('.clipboard-send').forEach(button => button.addEventListener('click', () => run(() => api.sendClipboard(), 'Appunti inviati come testo da confermare sul computer remoto')));

function stopCapture() {
  captureGeneration++;
  captureStream?.getTracks().forEach(track => track.stop());
  captureStream = undefined; captureFor = undefined;
  $('capture-video').srcObject = null;
}
async function syncCapture() {
  const desired = state.session?.role === 'host' && state.session.authenticated ? state.session.sessionId : undefined;
  if (!desired) { if (captureFor || captureStream) stopCapture(); return; }
  if (capturing || captureFor === desired) return;
  stopCapture();
  capturing = true; captureFor = desired;
  const generation = captureGeneration;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 8, max: 10 }, width: { ideal: 1280, max: 1600 }, height: { ideal: 900, max: 1200 } }, audio: false });
    if (generation !== captureGeneration || state.session?.sessionId !== desired) { stream.getTracks().forEach(track => track.stop()); return; }
    captureStream = stream;
    const video = $('capture-video'); video.srcObject = stream; await video.play();
    const canvas = $('capture-canvas'); const context = canvas.getContext('2d', { alpha: false });
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (captureFor === desired) { stopCapture(); void api.captureError({ sessionId: desired, message: 'La condivisione è stata terminata dal sistema.' }); }
    });
    while (generation === captureGeneration && state.session?.sessionId === desired) {
      const started = performance.now();
      const scale = Math.min(1, 1280 / video.videoWidth, 900 / video.videoHeight);
      if (Number.isFinite(scale) && video.videoWidth && video.videoHeight) {
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        let data;
        for (const quality of [0.58, 0.42, 0.28, 0.15]) {
          data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
          if (data.length <= 131072) break;
        }
        if (data.length <= 131072) await api.sendFrame({ sessionId: desired, data, mime: 'image/jpeg', width: canvas.width, height: canvas.height });
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(5, 125 - (performance.now() - started))));
    }
  } catch (error) {
    if (generation === captureGeneration && state.session?.sessionId === desired) {
      stopCapture();
      await api.captureError({ sessionId: desired, message: error.name === 'NotAllowedError' ? 'Consenti la registrazione schermo nelle impostazioni di sistema e riavvia phRemote.' : error.message });
    }
  } finally {
    capturing = false;
    if (state.session?.role === 'host' && state.session.authenticated && captureFor !== state.session.sessionId) void syncCapture();
  }
}

api.onFrame(frame => {
  if (state?.session?.role !== 'viewer' || !state.session.authenticated || frame.sessionId !== state.session.sessionId) return;
  $('remote-frame').src = 'data:' + frame.mime + ';base64,' + frame.data;
  $('remote-canvas').classList.add('has-frame');
  framesReceived++; $('frame-status').textContent = frame.width + ' × ' + frame.height + ' · ' + framesReceived + ' fotogrammi';
});
function canInput() { return state?.session?.role === 'viewer' && state.session.authenticated && framesReceived > 0; }
function coordinates(event) {
  const rect = $('remote-frame').getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  lastPosition = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  return lastPosition;
}
let lastMove = 0;
$('remote-frame').addEventListener('mousemove', event => {
  if (!canInput() || performance.now() - lastMove < 16) return;
  lastMove = performance.now(); void sendInput({ event: 'move', ...coordinates(event) });
});
$('remote-frame').addEventListener('mousedown', event => {
  if (!canInput() || event.button > 2) return; event.preventDefault(); $('remote-canvas').focus();
  pressedButtons.add(event.button); void sendInput({ event: 'down', button: event.button, ...coordinates(event) });
});
window.addEventListener('mouseup', event => {
  if (!pressedButtons.has(event.button)) return; pressedButtons.delete(event.button);
  if (canInput()) void sendInput({ event: 'up', button: event.button, ...coordinates(event) });
});
$('remote-canvas').addEventListener('contextmenu', event => event.preventDefault());
$('remote-canvas').addEventListener('wheel', event => {
  if (!canInput()) return; event.preventDefault();
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1;
  void sendInput({ event: 'scroll', deltaX: Math.max(-2000, Math.min(2000, event.deltaX * multiplier)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY * multiplier)) });
}, { passive: false });
function modifiers(event) { return { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey }; }
$('remote-canvas').addEventListener('keydown', event => {
  if (!canInput()) return; event.preventDefault();
  pressedKeys.add(event.code); void sendInput({ event: 'keyDown', code: event.code, key: event.key, modifiers: modifiers(event) });
});
$('remote-canvas').addEventListener('keyup', event => {
  if (!canInput()) return; event.preventDefault();
  pressedKeys.delete(event.code); void sendInput({ event: 'keyUp', code: event.code, key: event.key, modifiers: modifiers(event) });
});
function releaseInput() {
  for (const code of pressedKeys) void sendInput({ event: 'keyUp', code, key: '', modifiers: {} });
  for (const button of pressedButtons) void sendInput({ event: 'up', button, ...lastPosition });
  pressedKeys.clear(); pressedButtons.clear();
}
window.addEventListener('blur', releaseInput);
$('remote-canvas').addEventListener('blur', releaseInput);
window.addEventListener('beforeunload', stopCapture);
api.onState(render);
api.state().then(render).catch(error => { $('error-banner').textContent = error.message; $('error-banner').classList.remove('hidden'); });
