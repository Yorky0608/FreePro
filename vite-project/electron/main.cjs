const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const bcrypt = require('bcryptjs')
const db = require('./db.cjs')

const isDev = !app.isPackaged

/** @type {Map<number, { id: number, email: string }>} */
const sessionByWebContentsId = new Map()

function getSessionFromEvent(event) {
  const wcId = event?.sender?.id
  if (!Number.isFinite(wcId)) return null
  return sessionByWebContentsId.get(wcId) ?? null
}

function requireSession(event) {
  const session = getSessionFromEvent(event)
  if (!session) {
    const err = new Error('Not logged in')
    err.code = 'NOT_AUTHENTICATED'
    throw err
  }
  return session
}

function setupIpc() {
  ipcMain.handle('auth:getSession', async (event) => {
    return getSessionFromEvent(event)
  })

  ipcMain.handle('auth:logout', async (event) => {
    const wcId = event?.sender?.id
    if (Number.isFinite(wcId)) sessionByWebContentsId.delete(wcId)
    return true
  })

  ipcMain.handle('auth:register', async (event, payload) => {
    const email = db.normalizeEmail(payload?.email)
    const password = typeof payload?.password === 'string' ? payload.password : ''
    if (!email) throw new Error('Email is required')
    if (password.length < 6) throw new Error('Password must be at least 6 characters')

    const existing = db.getUserByEmail(email)
    if (existing) throw new Error('An account with that email already exists')

    const passwordHash = bcrypt.hashSync(password, 10)
    const user = db.createUser({ email, passwordHash })
    const wcId = event?.sender?.id
    if (Number.isFinite(wcId)) sessionByWebContentsId.set(wcId, { id: user.id, email: user.email })
    return { id: user.id, email: user.email }
  })

  ipcMain.handle('auth:login', async (event, payload) => {
    const email = db.normalizeEmail(payload?.email)
    const password = typeof payload?.password === 'string' ? payload.password : ''
    if (!email) throw new Error('Email is required')
    if (!password) throw new Error('Password is required')

    const user = db.getUserByEmail(email)
    if (!user) throw new Error('Invalid email or password')
    const ok = bcrypt.compareSync(password, user.passwordHash)
    if (!ok) throw new Error('Invalid email or password')

    const wcId = event?.sender?.id
    if (Number.isFinite(wcId)) sessionByWebContentsId.set(wcId, { id: user.id, email: user.email })
    return { id: user.id, email: user.email }
  })

  ipcMain.handle('savings:getLog', async (event) => {
    const session = requireSession(event)
    return db.listSavingsLog(session.id)
  })

  ipcMain.handle('savings:upsertMonth', async (event, payload) => {
    const session = requireSession(event)
    const month = Number(payload?.month)
    const dollars = Number(payload?.dollars)
    db.upsertSavingsMonth({ userId: session.id, monthMs: month, dollars })
    return true
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:5173/')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  win.webContents.on('destroyed', () => {
    try {
      sessionByWebContentsId.delete(win.webContents.id)
    } catch {
      // ignore
    }
  })
}

app.whenReady().then(async () => {
  await db.initDb({ userDataPath: app.getPath('userData') })
  setupIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
