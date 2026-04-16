const { contextBridge, ipcRenderer } = require('electron')

// Expose a tiny, safe API surface (optional).
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  auth: {
    getSession: () => ipcRenderer.invoke('auth:getSession'),
    register: (email, password) => ipcRenderer.invoke('auth:register', { email, password }),
    login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  savings: {
    getLog: () => ipcRenderer.invoke('savings:getLog'),
    upsertMonth: (month, dollars) => ipcRenderer.invoke('savings:upsertMonth', { month, dollars }),
  },
  profile: {
    getGoal: () => ipcRenderer.invoke('profile:getGoal'),
    setGoal: (goalDollars) => ipcRenderer.invoke('profile:setGoal', { goalDollars }),
  },
})
