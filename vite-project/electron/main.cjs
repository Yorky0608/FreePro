const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const bcrypt = require('bcryptjs')
const db = require('./db.cjs')

const isDev = !app.isPackaged

const API_BASE_URL = process.env.FREEDOM_API_BASE_URL || 'https://1wos40ydh1.execute-api.us-east-2.amazonaws.com'
const SYNC_DEBUG = String(process.env.FREEDOM_SYNC_DEBUG || '').toLowerCase() === '1' || String(process.env.FREEDOM_SYNC_DEBUG || '').toLowerCase() === 'true'

function logSyncDebug(...args) {
  if (!SYNC_DEBUG) return
  try {
    console.log('[sync]', ...args)
  } catch {
    // ignore
  }
}

/** @type {Map<number, { id: number, email: string, cloudToken?: string, cloudUserId?: string, cloudPulled?: boolean, lastCloudPullMs?: number, cloudGoalPulled?: boolean, lastCloudGoalPullMs?: number }>} */
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

async function apiJson({ method, apiPath, token, body, query }) {
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this runtime')

  const url = new URL(apiPath, API_BASE_URL)
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, String(v))
    }
  }

  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`

  logSyncDebug('request', method, url.pathname)

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`
    logSyncDebug('response', res.status, method, url.pathname, msg)
    const err = new Error(msg)
    err.status = res.status
    throw err
  }

  logSyncDebug('response', res.status, method, url.pathname)
  return data
}

async function cloudRegister(email, password) {
  return apiJson({ method: 'POST', apiPath: '/auth/register', body: { email, password } })
}

async function cloudLogin(email, password) {
  return apiJson({ method: 'POST', apiPath: '/auth/login', body: { email, password } })
}

async function cloudSaveMonth({ token, monthMs, dollars }) {
  return apiJson({ method: 'POST', apiPath: '/sync/save', token, body: { monthMs, dollars } })
}

async function cloudPull({ token, sinceMs }) {
  return apiJson({ method: 'GET', apiPath: '/sync/pull', token, query: { sinceMs } })
}

async function cloudGetGoal({ token }) {
  return apiJson({ method: 'GET', apiPath: '/profile/goal', token })
}

async function cloudSetGoal({ token, goalDollars }) {
  return apiJson({ method: 'POST', apiPath: '/profile/goal', token, body: { goalDollars } })
}

function ensureLocalUser({ email, password }) {

  const existing = db.getUserByEmail(email)
  if (existing) {
    const ok = bcrypt.compareSync(password, existing.passwordHash)
    if (!ok) {
      const err = new Error('Invalid email or password')
      err.code = 'INVALID_CREDENTIALS'
      throw err
    }
    return existing
  }

  // For login, only create a local account if cloud auth succeeded.
  // (Local-only account creation should go through register.)
  const err = new Error('No local account found. Create an account first.')
  err.code = 'NO_LOCAL_ACCOUNT'
  throw err
}

function ensureLocalUserAfterCloudLogin({ email, password }) {
  const existing = db.getUserByEmail(email)
  const passwordHash = bcrypt.hashSync(password, 10)

  if (existing) {
    const ok = bcrypt.compareSync(password, existing.passwordHash)
    if (!ok) {
      // Cloud accepted the password, so keep local auth aligned.
      db.updateUserPasswordHash({ userId: existing.id, passwordHash })
      return { ...existing, passwordHash }
    }
    return existing
  }

  return db.createUser({ email, passwordHash })
}

async function cloudPullAndMerge({ token, localUserId, sinceMs }) {
  const out = await cloudPull({ token, sinceMs })
  const items = Array.isArray(out?.items) ? out.items : []

  let maxSeen = Number.isFinite(sinceMs) ? sinceMs : 0

  for (const item of items) {
    const monthMs = Number(item?.monthMs)
    const dollars = Number(item?.dollars)
    const updatedAtMs = Number(item?.updatedAtMs)
    const createdAtMs = Number(item?.createdAtMs)

    if (!Number.isFinite(monthMs) || monthMs <= 0) continue
    if (!Number.isFinite(dollars) || dollars < 0) continue
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) continue

    const local = db.getSavingsMonthMeta({ userId: localUserId, monthMs })
    const localUpdated = local ? Number(local.updatedAtMs) : 0

    if (!local || updatedAtMs > localUpdated) {
      db.upsertSavingsMonthFromCloud({
        userId: localUserId,
        monthMs,
        dollars,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : updatedAtMs,
        updatedAtMs,
      })
    }

    if (updatedAtMs > maxSeen) maxSeen = updatedAtMs
  }

  return maxSeen
}

async function cloudPullGoalAndMerge({ token, localUserId }) {
  const out = await cloudGetGoal({ token })

  const goalDollars = Number(out?.goalDollars)
  const updatedAtMs = Number(out?.updatedAtMs)
  const createdAtMs = Number(out?.createdAtMs)

  if (!Number.isFinite(goalDollars) || goalDollars < 0) return 0

  // If the API doesn't return timestamps, just treat it as a value.
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
    db.upsertUserGoal({ userId: localUserId, goalDollars })
    return 0
  }

  const local = db.getUserGoalMeta(localUserId)
  const localUpdated = local ? Number(local.updatedAtMs) : 0

  if (!local || updatedAtMs > localUpdated) {
    db.upsertUserGoalFromCloud({
      userId: localUserId,
      goalDollars,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : updatedAtMs,
      updatedAtMs,
    })
  }

  return updatedAtMs
}

function setupIpc() {
  ipcMain.handle('auth:getSession', async (event) => {
    const s = getSessionFromEvent(event)
    return s
      ? {
          id: s.id,
          email: s.email,
          token: s.cloudToken,
          cloudUserId: s.cloudUserId,
        }
      : null
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

    /** @type {null | { userId?: string, token?: string }} */
    let cloud = null
    try {
      cloud = await cloudRegister(email, password)
      logSyncDebug('cloud register ok')
    } catch (err) {
      logSyncDebug('cloud register failed', err?.status || '', err?.message || String(err))
      // If the cloud says the account exists or the request is invalid, surface that.
      if (err?.status === 409 || err?.status === 400) throw err
      // Otherwise allow local-only registration (no sync) for now.
      cloud = null
    }

    const passwordHash = bcrypt.hashSync(password, 10)
    const user = db.createUser({ email, passwordHash })

    const wcId = event?.sender?.id
    if (Number.isFinite(wcId)) {
      sessionByWebContentsId.set(wcId, {
        id: user.id,
        email: user.email,
        cloudToken: typeof cloud?.token === 'string' ? cloud.token : undefined,
        cloudUserId: typeof cloud?.userId === 'string' ? cloud.userId : undefined,
        cloudPulled: false,
        lastCloudPullMs: 0,
        cloudGoalPulled: false,
        lastCloudGoalPullMs: 0,
      })

      const s = sessionByWebContentsId.get(wcId)
      if (s?.cloudToken) {
        try {
          s.lastCloudPullMs = await cloudPullAndMerge({ token: s.cloudToken, localUserId: s.id, sinceMs: 0 })
          s.cloudPulled = true
          logSyncDebug('cloud pull ok (register)', s.lastCloudPullMs)
        } catch (err) {
          logSyncDebug('cloud pull failed (register)', err?.status || '', err?.message || String(err))
          // ignore
        }

        try {
          s.lastCloudGoalPullMs = await cloudPullGoalAndMerge({ token: s.cloudToken, localUserId: s.id })
          s.cloudGoalPulled = true
          logSyncDebug('cloud goal pull ok (register)', s.lastCloudGoalPullMs)
        } catch (err) {
          logSyncDebug('cloud goal pull failed (register)', err?.status || '', err?.message || String(err))
          // ignore
        }
      }
    }

    const sessionRecord = Number.isFinite(wcId) ? sessionByWebContentsId.get(wcId) : null
    return {
      id: user.id,
      email: user.email,
      token: sessionRecord?.cloudToken,
      cloudUserId: sessionRecord?.cloudUserId,
    }
  })

  ipcMain.handle('auth:login', async (event, payload) => {
    const email = db.normalizeEmail(payload?.email)
    const password = typeof payload?.password === 'string' ? payload.password : ''
    if (!email) throw new Error('Email is required')
    if (!password) throw new Error('Password is required')

    /** @type {null | { userId?: string, token?: string }} */
    let cloud = null
    try {
      cloud = await cloudLogin(email, password)
      logSyncDebug('cloud login ok')
    } catch (err) {
      logSyncDebug('cloud login failed', err?.status || '', err?.message || String(err))
      // If the cloud rejects credentials, do not fall back.
      if (err?.status === 401) throw err
      cloud = null
    }

    // If cloud login succeeds, make sure local auth exists and is consistent.
    // Otherwise, require an existing local account and validate the password.
    const localUser = cloud?.token
      ? ensureLocalUserAfterCloudLogin({ email, password })
      : ensureLocalUser({ email, password })

    const wcId = event?.sender?.id
    if (Number.isFinite(wcId)) {
      sessionByWebContentsId.set(wcId, {
        id: localUser.id,
        email: localUser.email,
        cloudToken: typeof cloud?.token === 'string' ? cloud.token : undefined,
        cloudUserId: typeof cloud?.userId === 'string' ? cloud.userId : undefined,
        cloudPulled: false,
        lastCloudPullMs: 0,
        cloudGoalPulled: false,
        lastCloudGoalPullMs: 0,
      })

      const s = sessionByWebContentsId.get(wcId)
      if (s?.cloudToken) {
        try {
          s.lastCloudPullMs = await cloudPullAndMerge({ token: s.cloudToken, localUserId: s.id, sinceMs: 0 })
          s.cloudPulled = true
          logSyncDebug('cloud pull ok (login)', s.lastCloudPullMs)
        } catch (err) {
          logSyncDebug('cloud pull failed (login)', err?.status || '', err?.message || String(err))
          // ignore
        }

        try {
          s.lastCloudGoalPullMs = await cloudPullGoalAndMerge({ token: s.cloudToken, localUserId: s.id })
          s.cloudGoalPulled = true
          logSyncDebug('cloud goal pull ok (login)', s.lastCloudGoalPullMs)
        } catch (err) {
          logSyncDebug('cloud goal pull failed (login)', err?.status || '', err?.message || String(err))
          // ignore
        }
      }
    }

    const sessionRecord = Number.isFinite(wcId) ? sessionByWebContentsId.get(wcId) : null
    return {
      id: localUser.id,
      email: localUser.email,
      token: sessionRecord?.cloudToken,
      cloudUserId: sessionRecord?.cloudUserId,
    }
  })

  ipcMain.handle('savings:getLog', async (event) => {
    const session = requireSession(event)

    if (session.cloudToken && !session.cloudPulled) {
      try {
        session.lastCloudPullMs = await cloudPullAndMerge({
          token: session.cloudToken,
          localUserId: session.id,
          sinceMs: 0,
        })
        session.cloudPulled = true
        logSyncDebug('cloud pull ok (getLog)', session.lastCloudPullMs)
      } catch (err) {
        logSyncDebug('cloud pull failed (getLog)', err?.status || '', err?.message || String(err))
        // ignore
      }
    }

    if (session.cloudToken && !session.cloudGoalPulled) {
      try {
        session.lastCloudGoalPullMs = await cloudPullGoalAndMerge({ token: session.cloudToken, localUserId: session.id })
        session.cloudGoalPulled = true
        logSyncDebug('cloud goal pull ok (getLog)', session.lastCloudGoalPullMs)
      } catch (err) {
        logSyncDebug('cloud goal pull failed (getLog)', err?.status || '', err?.message || String(err))
        // ignore
      }
    }

    return db.listSavingsLog(session.id)
  })

  ipcMain.handle('savings:upsertMonth', async (event, payload) => {
    const session = requireSession(event)
    const month = Number(payload?.month)
    const dollars = Number(payload?.dollars)

    db.upsertSavingsMonth({ userId: session.id, monthMs: month, dollars })

    if (session.cloudToken) {
      try {
        await cloudSaveMonth({ token: session.cloudToken, monthMs: month, dollars })
        logSyncDebug('cloud save ok', month)
      } catch (err) {
        logSyncDebug('cloud save failed', err?.status || '', err?.message || String(err))
        // ignore (local save still succeeded)
      }
    }

    return true
  })

  ipcMain.handle('profile:getGoal', async (event) => {
    const session = requireSession(event)

    if (session.cloudToken && !session.cloudGoalPulled) {
      try {
        session.lastCloudGoalPullMs = await cloudPullGoalAndMerge({ token: session.cloudToken, localUserId: session.id })
        session.cloudGoalPulled = true
        logSyncDebug('cloud goal pull ok (getGoal)', session.lastCloudGoalPullMs)
      } catch (err) {
        logSyncDebug('cloud goal pull failed (getGoal)', err?.status || '', err?.message || String(err))
        // ignore
      }
    }

    const meta = db.getUserGoalMeta(session.id)
    return { goalDollars: meta ? meta.goalDollars : 0 }
  })

  ipcMain.handle('profile:setGoal', async (event, payload) => {
    const session = requireSession(event)
    const goalDollars = Number(payload?.goalDollars)
    if (!Number.isFinite(goalDollars) || goalDollars < 0) throw new Error('Invalid goal amount')

    db.upsertUserGoal({ userId: session.id, goalDollars })

    if (session.cloudToken) {
      try {
        const out = await cloudSetGoal({ token: session.cloudToken, goalDollars })

        const updatedAtMs = Number(out?.updatedAtMs)
        const createdAtMs = Number(out?.createdAtMs)
        const serverGoal = Number(out?.goalDollars)

        if (Number.isFinite(serverGoal) && serverGoal >= 0 && Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
          db.upsertUserGoalFromCloud({
            userId: session.id,
            goalDollars: serverGoal,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : updatedAtMs,
            updatedAtMs,
          })
        }

        logSyncDebug('cloud goal save ok')
      } catch (err) {
        logSyncDebug('cloud goal save failed', err?.status || '', err?.message || String(err))
        // ignore (local save still succeeded)
      }
    }

    return true
  })

  ipcMain.handle('ledger:listEntries', async (event) => {
    const session = requireSession(event)
    return db.listLedgerEntries(session.id)
  })

  ipcMain.handle('ledger:addEntry', async (event, payload) => {
    const session = requireSession(event)
    const clientId = typeof payload?.clientId === 'string' ? payload.clientId : undefined
    const dayMs = Number(payload?.dayMs)
    const incomeDollars = Number(payload?.incomeDollars)
    const expensesDollars = Number(payload?.expensesDollars)
    const savingsDollars = Number(payload?.savingsDollars)
    const createdAtMs = Number(payload?.createdAtMs)
    const updatedAtMs = Number(payload?.updatedAtMs)
    return db.addLedgerEntry({ userId: session.id, clientId, dayMs, incomeDollars, expensesDollars, savingsDollars, createdAtMs, updatedAtMs })
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
