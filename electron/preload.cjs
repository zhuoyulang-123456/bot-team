const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  version: process.versions.electron,
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  mimoLogin: () => ipcRenderer.invoke('mimo-login'),
  getLoginItem: () => ipcRenderer.invoke('login-item-get'),
  setLoginItem: (enabled) => ipcRenderer.invoke('login-item-set', enabled),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
});
