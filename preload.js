const { contextBridge, ipcRenderer } = require('electron');

// 受控的进程间通信桥
contextBridge.exposeInMainWorld('app', {
  dragWindow: () => ipcRenderer.send('win:drag'),
  closeWindow: () => ipcRenderer.send('win:close'),
  toggleTop: () => ipcRenderer.send('win:toggle-top')
});
