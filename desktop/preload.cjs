const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => async value => {
  const result = await ipcRenderer.invoke('phremote:' + name, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const subscribe = channel => callback => {
  if (typeof callback !== 'function') throw new TypeError('Callback required');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('phremote:' + channel, listener);
  return () => ipcRenderer.removeListener('phremote:' + channel, listener);
};
contextBridge.exposeInMainWorld('phremote', {
  state: invoke('state'), connectRelay: invoke('connect-relay'), disconnectRelay: invoke('disconnect-relay'),
  invite: invoke('invite'), approve: invoke('approve'), reject: invoke('reject'), disconnect: invoke('disconnect'),
  rotatePassword: invoke('rotate-password'), copyAccess: invoke('copy-access'),
  sendClipboard: invoke('clipboard-send'), copyClipboard: invoke('clipboard-copy'), chat: invoke('chat'),
  sendFrame: invoke('frame'), sendInput: invoke('input'), captureError: invoke('capture-error'),
  saveSettings: invoke('save-settings'), saveContact: invoke('save-contact'), removeContact: invoke('remove-contact'),
  openPermissions: invoke('permissions'), refreshPermissions: invoke('refresh-permissions'),
  onState: subscribe('state'), onFrame: subscribe('frame')
});
