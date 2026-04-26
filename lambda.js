const crypto = require('crypto')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb')

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const USERS_TABLE = process.env.USERS_TABLE
const SAVINGS_TABLE = process.env.SAVINGS_TABLE
const LEDGER_TABLE = process.env.LEDGER_TABLE
const LEDGER_GSI_USER_UPDATED = process.env.LEDGER_GSI_USER_UPDATED || 'gsi_user_updated'

const JWT_SECRET = process.env.JWT_SECRET
const JWT_ISS = process.env.JWT_ISS || undefined
const JWT_AUD = process.env.JWT_AUD || undefined
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

if (!USERS_TABLE || !SAVINGS_TABLE || !LEDGER_TABLE || !JWT_SECRET) {
  throw new Error('Missing required env vars: USERS_TABLE, SAVINGS_TABLE, LEDGER_TABLE, JWT_SECRET')
}

function json(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': CORS_ORIGIN,
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  }
}

function noContent(statusCode = 204) {
  return {
    statusCode,
    headers: {
      'access-control-allow-origin': CORS_ORIGIN,
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store',
    },
    body: '',
  }
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return ''
  return email.trim().toLowerCase()
}

function normalizeName(name) {
  if (typeof name !== 'string') return ''
  return name.trim().replace(/\s+/g, ' ').slice(0, 120)
}

function readJsonBody(event) {
  if (!event || !event.body) return null
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : String(event.body)
  try {
    return JSON.parse(raw)
  } catch {
    const e = new Error('Invalid JSON body')
    e.code = 'BAD_JSON'
    throw e
  }
}

// ---- Password hashing (scrypt) ----
// Stored format: scrypt$N$r$p$saltB64url$hashB64url
function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}
function b64urlDecode(str) {
  const padLen = (4 - (str.length % 4)) % 4
  const padded = str + '='.repeat(padLen)
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64')
}

function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }
  const salt = crypto.randomBytes(16)
  const N = 16384, r = 8, p = 1
  const keyLen = 64
  const hash = crypto.scryptSync(password, salt, keyLen, {
    N, r, p,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt$${N}$${r}$${p}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6) return false
  const [algo, Nstr, rstr, pstr, saltB64u, hashB64u] = parts
  if (algo !== 'scrypt') return false

  const N = Number(Nstr), r = Number(rstr), p = Number(pstr)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false

  const salt = b64urlDecode(saltB64u)
  const expectedHash = b64urlDecode(hashB64u)

  const actualHash = crypto.scryptSync(password, salt, expectedHash.length, {
    N, r, p,
    maxmem: 64 * 1024 * 1024,
  })

  if (actualHash.length !== expectedHash.length) return false
  return crypto.timingSafeEqual(actualHash, expectedHash)
}

// ---- JWT (HS256) ----
function signJwt(payload, { secret, expiresInSec }) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const nowSec = Math.floor(Date.now() / 1000)

  const fullPayload = {
    ...payload,
    iat: nowSec,
    exp: nowSec + expiresInSec,
    ...(JWT_ISS ? { iss: JWT_ISS } : {}),
    ...(JWT_AUD ? { aud: JWT_AUD } : {}),
  }

  const encHeader = b64urlEncode(Buffer.from(JSON.stringify(header)))
  const encPayload = b64urlEncode(Buffer.from(JSON.stringify(fullPayload)))
  const toSign = `${encHeader}.${encPayload}`

  const sig = crypto.createHmac('sha256', secret).update(toSign).digest()
  return `${toSign}.${b64urlEncode(sig)}`
}

function verifyJwt(token, { secret }) {
  if (typeof token !== 'string' || !token.includes('.')) {
    const e = new Error('Invalid token'); e.code = 'INVALID_TOKEN'; throw e
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    const e = new Error('Invalid token'); e.code = 'INVALID_TOKEN'; throw e
  }

  const [encHeader, encPayload, encSig] = parts
  const header = JSON.parse(b64urlDecode(encHeader).toString('utf8'))
  if (!header || header.alg !== 'HS256') {
    const e = new Error('Unsupported token'); e.code = 'INVALID_TOKEN'; throw e
  }

  const toSign = `${encHeader}.${encPayload}`
  const expectedSig = crypto.createHmac('sha256', secret).update(toSign).digest()
  const actualSig = b64urlDecode(encSig)

  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    const e = new Error('Invalid token'); e.code = 'INVALID_TOKEN'; throw e
  }

  const payload = JSON.parse(b64urlDecode(encPayload).toString('utf8'))
  const nowSec = Math.floor(Date.now() / 1000)

  if (typeof payload.exp !== 'number' || nowSec >= payload.exp) {
    const e = new Error('Token expired'); e.code = 'TOKEN_EXPIRED'; throw e
  }
  if (JWT_ISS && payload.iss !== JWT_ISS) {
    const e = new Error('Invalid token issuer'); e.code = 'INVALID_TOKEN'; throw e
  }
  if (JWT_AUD && payload.aud !== JWT_AUD) {
    const e = new Error('Invalid token audience'); e.code = 'INVALID_TOKEN'; throw e
  }

  return payload
}

function getBearerToken(event) {
  const h = event?.headers || {}
  const auth = h.authorization || h.Authorization || ''
  if (typeof auth !== 'string') return ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

function requireAuth(event) {
  const token = getBearerToken(event)
  if (!token) {
    const e = new Error('Missing Authorization: Bearer token')
    e.code = 'NOT_AUTHENTICATED'
    throw e
  }
  const payload = verifyJwt(token, { secret: JWT_SECRET })
  if (!payload?.sub || typeof payload.sub !== 'string') {
    const e = new Error('Invalid token subject')
    e.code = 'INVALID_TOKEN'
    throw e
  }
  return payload
}

async function handleRegister(event) {
  const body = readJsonBody(event) || {}
  const emailLower = normalizeEmail(body.email)
  const name = normalizeName(body.name)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!emailLower) return json(400, { error: 'Email is required' })

  const userId = crypto.randomUUID()
  const passwordHash = hashPassword(password)
  const createdAtMs = Date.now()

  try {
    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: { emailLower, userId, name, passwordHash, createdAtMs },
      ConditionExpression: 'attribute_not_exists(emailLower)',
    }))
  } catch (err) {
    // Duplicate email
    if (err?.name === 'ConditionalCheckFailedException') {
      return json(409, { error: 'Email already registered' })
    }
    throw err
  }

  const token = signJwt(
    { sub: userId, email: emailLower },
    { secret: JWT_SECRET, expiresInSec: 60 * 60 * 24 * 30 }
  )
  return json(200, { userId, email: emailLower, name, token })
}

async function handleLogin(event) {
  const body = readJsonBody(event) || {}
  const emailLower = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!emailLower) return json(400, { error: 'Email is required' })
  if (!password) return json(400, { error: 'Password is required' })

  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
  }))

  const user = res?.Item
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return json(401, { error: 'Invalid email or password' })
  }

  const token = signJwt(
    { sub: user.userId, email: emailLower },
    { secret: JWT_SECRET, expiresInSec: 60 * 60 * 24 * 30 }
  )
  return json(200, {
    userId: user.userId,
    email: emailLower,
    name: normalizeName(user.name),
    token,
  })
}

// Legacy monthly savings sync (still here)
async function handleSave(event) {
  const auth = requireAuth(event)
  const body = readJsonBody(event) || {}

  const monthMs = Number(body.monthMs)
  const dollars = Number(body.dollars)
  if (!Number.isFinite(monthMs) || monthMs <= 0) return json(400, { error: 'monthMs is required' })
  if (!Number.isFinite(dollars) || dollars < 0) return json(400, { error: 'dollars must be >= 0' })

  const userId = auth.sub
  const updatedAtMs = Date.now()

  const result = await ddb.send(new UpdateCommand({
    TableName: SAVINGS_TABLE,
    Key: { userId, monthMs: Math.round(monthMs) },
    UpdateExpression: 'SET dollars = :d, updatedAtMs = :u, createdAtMs = if_not_exists(createdAtMs, :u)',
    ExpressionAttributeValues: {
      ':d': Math.round(dollars),
      ':u': updatedAtMs,
    },
    ReturnValues: 'ALL_NEW',
  }))

  return json(200, { ok: true, item: result.Attributes })
}

async function handlePull(event) {
  const auth = requireAuth(event)
  const userId = auth.sub

  const sinceMs = Number(event?.queryStringParameters?.sinceMs || 0)
  const params = {
    TableName: SAVINGS_TABLE,
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }

  // NOTE: this is a filter (not efficient for large data). Kept as-is for legacy.
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    params.FilterExpression = 'updatedAtMs > :since'
    params.ExpressionAttributeValues[':since'] = sinceMs
  }

  const out = await ddb.send(new QueryCommand(params))
  return json(200, { items: out.Items || [] })
}

async function handleGetGoal(event) {
  const auth = requireAuth(event)

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
  }))

  const user = res?.Item || {}
  const goalDollars = Number(user.goalDollars)
  const createdAtMs = Number(user.goalCreatedAtMs)
  const updatedAtMs = Number(user.goalUpdatedAtMs)

  return json(200, {
    goalDollars: Number.isFinite(goalDollars) && goalDollars >= 0 ? goalDollars : 0,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : 0,
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
  })
}

async function handleSetGoal(event) {
  const auth = requireAuth(event)
  const body = readJsonBody(event) || {}

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const goalDollars = Number(body.goalDollars)
  if (!Number.isFinite(goalDollars) || goalDollars < 0) {
    return json(400, { error: 'goalDollars must be >= 0' })
  }

  const now = Date.now()

  const result = await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
    ConditionExpression: 'userId = :uid',
    UpdateExpression:
      'SET goalDollars = :g, goalUpdatedAtMs = :u, goalCreatedAtMs = if_not_exists(goalCreatedAtMs, :u)',
    ExpressionAttributeValues: {
      ':g': Math.round(goalDollars),
      ':u': now,
      ':uid': auth.sub,
    },
    ReturnValues: 'ALL_NEW',
  }))

  const u = result.Attributes || {}
  return json(200, {
    goalDollars: Number(u.goalDollars) || 0,
    createdAtMs: Number(u.goalCreatedAtMs) || now,
    updatedAtMs: Number(u.goalUpdatedAtMs) || now,
  })
}

async function handleGetProfileName(event) {
  const auth = requireAuth(event)

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
  }))

  const user = res?.Item || {}
  return json(200, { name: normalizeName(user.name) })
}

async function handleSetProfileName(event) {
  const auth = requireAuth(event)
  const body = readJsonBody(event) || {}

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const name = normalizeName(body.name)

  const result = await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
    ConditionExpression: 'userId = :uid',
    UpdateExpression: 'SET #name = :name',
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':name': name,
      ':uid': auth.sub,
    },
    ReturnValues: 'ALL_NEW',
  }))

  return json(200, { name: normalizeName(result?.Attributes?.name) })
}

// ---- NEW: Ledger Sync ----
function normalizeClientId(clientId) {
  if (typeof clientId !== 'string') return ''
  const s = clientId.trim()
  // keep it simple; just prevent absurdly large keys
  if (!s || s.length > 200) return ''
  return s
}

async function handleLedgerUpsert(event) {
  const auth = requireAuth(event)
  const body = readJsonBody(event) || {}

  const userId = auth.sub
  const clientId = normalizeClientId(body.clientId)
  if (!clientId) return json(400, { error: 'clientId is required' })

  const dayMs = Number(body.dayMs)
  if (!Number.isFinite(dayMs) || dayMs <= 0) return json(400, { error: 'dayMs is required' })

  const incomeDollars = Number(body.incomeDollars || 0)
  const expensesDollars = Number(body.expensesDollars || 0)
  const savingsDollars = Number(body.savingsDollars || 0)

  if (!Number.isFinite(incomeDollars) || incomeDollars < 0) return json(400, { error: 'incomeDollars must be >= 0' })
  if (!Number.isFinite(expensesDollars) || expensesDollars < 0) return json(400, { error: 'expensesDollars must be >= 0' })
  if (!Number.isFinite(savingsDollars) || savingsDollars < 0) return json(400, { error: 'savingsDollars must be >= 0' })

  const now = Date.now()
  const createdAtCandidate = Number(body.createdAtMs)
  const createdAtMs = Number.isFinite(createdAtCandidate) && createdAtCandidate > 0 ? Math.round(createdAtCandidate) : now

  const result = await ddb.send(new UpdateCommand({
    TableName: LEDGER_TABLE,
    Key: { userId, clientId },
    UpdateExpression: [
      'SET dayMs = :day',
      'incomeDollars = :inc',
      'expensesDollars = :exp',
      'savingsDollars = :sav',
      'updatedAtMs = :u',
      'createdAtMs = if_not_exists(createdAtMs, :c)',
    ].join(', '),
    ExpressionAttributeValues: {
      ':day': Math.round(dayMs),
      ':inc': Math.max(0, Math.round(incomeDollars)),
      ':exp': Math.max(0, Math.round(expensesDollars)),
      ':sav': Math.max(0, Math.round(savingsDollars)),
      ':u': now,
      ':c': createdAtMs,
    },
    ReturnValues: 'ALL_NEW',
  }))

  return json(200, { ok: true, item: result.Attributes })
}

async function handleLedgerPull(event) {
  const auth = requireAuth(event)
  const userId = auth.sub

  const sinceMs = Number(event?.queryStringParameters?.sinceMs || 0)
  const hasSince = Number.isFinite(sinceMs) && sinceMs > 0

  const params = {
    TableName: LEDGER_TABLE,
    IndexName: LEDGER_GSI_USER_UPDATED,
    KeyConditionExpression: hasSince
      ? 'userId = :uid AND updatedAtMs > :since'
      : 'userId = :uid',
    ExpressionAttributeValues: hasSince
      ? { ':uid': userId, ':since': sinceMs }
      : { ':uid': userId },
  }

  const out = await ddb.send(new QueryCommand(params))
  return json(200, { items: out.Items || [] })
}

function getRoute(event) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || ''
  const stage = event?.requestContext?.stage || ''
  let path = event?.rawPath || event?.path || '/'
  if (typeof path !== 'string') path = '/'
  path = path.replace(/\/+$/, '') || '/'

  if (stage && stage !== '$default') {
    const prefix = `/${stage}`
    if (path === prefix) path = '/'
    else if (path.startsWith(prefix + '/')) path = path.slice(prefix.length)
  }

  return { method, path, routeKey: typeof event?.routeKey === 'string' ? event.routeKey : '' }
}

exports.handler = async (event) => {
  try {
    const { method, path, routeKey } = getRoute(event)
    if (method === 'OPTIONS') return noContent(204)

    // Prefer HTTP API routeKey when present
    if (routeKey && routeKey !== '$default') {
      if (routeKey === 'POST /auth/register') return await handleRegister(event)
      if (routeKey === 'POST /auth/login') return await handleLogin(event)
      if (routeKey === 'POST /register') return await handleRegister(event)
      if (routeKey === 'POST /login') return await handleLogin(event)

      if (routeKey === 'POST /sync/save') return await handleSave(event)
      if (routeKey === 'GET /sync/pull') return await handlePull(event)

      if (routeKey === 'GET /profile/goal') return await handleGetGoal(event)
      if (routeKey === 'POST /profile/goal') return await handleSetGoal(event)
      if (routeKey === 'GET /profile/name') return await handleGetProfileName(event)
      if (routeKey === 'POST /profile/name') return await handleSetProfileName(event)

      if (routeKey === 'GET /ledger/pull') return await handleLedgerPull(event)
      if (routeKey === 'POST /ledger/upsert') return await handleLedgerUpsert(event)
    }

    // Fallback for REST API / non-routeKey setups
    if (method === 'POST' && (path.endsWith('/auth/register') || path.endsWith('/register'))) return await handleRegister(event)
    if (method === 'POST' && (path.endsWith('/auth/login') || path.endsWith('/login'))) return await handleLogin(event)

    if (method === 'POST' && path.endsWith('/sync/save')) return await handleSave(event)
    if (method === 'GET' && path.endsWith('/sync/pull')) return await handlePull(event)

    if (method === 'GET' && path.endsWith('/profile/goal')) return await handleGetGoal(event)
    if (method === 'POST' && path.endsWith('/profile/goal')) return await handleSetGoal(event)
    if (method === 'GET' && path.endsWith('/profile/name')) return await handleGetProfileName(event)
    if (method === 'POST' && path.endsWith('/profile/name')) return await handleSetProfileName(event)

    if (method === 'GET' && path.endsWith('/ledger/pull')) return await handleLedgerPull(event)
    if (method === 'POST' && path.endsWith('/ledger/upsert')) return await handleLedgerUpsert(event)

    return json(404, { error: 'Not found' })
  } catch (err) {
    if (err?.code === 'BAD_JSON') return json(400, { error: 'Invalid JSON body' })
    if (err?.code === 'NOT_AUTHENTICATED') return json(401, { error: err.message || 'Not authenticated' })
    if (err?.code === 'TOKEN_EXPIRED' || err?.code === 'INVALID_TOKEN') return json(401, { error: err.message || 'Invalid token' })

    console.error('Unhandled error', {
      name: err?.name,
      code: err?.code,
      message: err?.message,
      stack: err?.stack,
    })
    return json(500, { error: 'Server error' })
  }
}

exports._test = {
  normalizeEmail,
  normalizeName,
  readJsonBody,
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  getRoute,
}