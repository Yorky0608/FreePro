const { contextBridge, ipcRenderer } = require('electron')

// Expose a tiny, safe API surface (optional).
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  auth: {
    getSession: () => ipcRenderer.invoke('auth:getSession'),
    register: (email, password, name) => ipcRenderer.invoke('auth:register', { email, password, name }),
    login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  savings: {
    getLog: () => ipcRenderer.invoke('savings:getLog'),
    upsertMonth: (month, dollars) => ipcRenderer.invoke('savings:upsertMonth', { month, dollars }),
  },
  profile: {
    getGoal: () => ipcRenderer.invoke('profile:getGoal'),
    getName: () => ipcRenderer.invoke('profile:getName'),
    setGoal: (goalDollars) => ipcRenderer.invoke('profile:setGoal', { goalDollars }),
    setName: (name) => ipcRenderer.invoke('profile:setName', { name }),
  },
  ledger: {
    listEntries: () => ipcRenderer.invoke('ledger:listEntries'),
    addEntry: ({ clientId, dayMs, incomeDollars, expensesDollars, savingsDollars, createdAtMs, updatedAtMs }) => ipcRenderer.invoke('ledger:addEntry', { clientId, dayMs, incomeDollars, expensesDollars, savingsDollars, createdAtMs, updatedAtMs }),
  },
})
