const { contextBridge } = require('electron')

// Expose a tiny, safe API surface (optional).
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
})
