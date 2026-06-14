const crypto = require('crypto')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
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
const INSTRUCTOR_EMAILS = parseEmailList(process.env.INSTRUCTOR_EMAILS)
const SUPER_INSTRUCTOR_EMAILS = parseEmailList(process.env.SUPER_INSTRUCTOR_EMAILS)

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

function parseEmailList(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => normalizeEmail(entry))
      .filter(Boolean)
  )
}

function getDefaultRoleForEmail(emailLower) {
  if (SUPER_INSTRUCTOR_EMAILS.has(emailLower)) return 'super-instructor'
  if (INSTRUCTOR_EMAILS.has(emailLower)) return 'instructor'
  return 'student'
}

function normalizeRole(role, emailLower = '') {
  const defaultRole = getDefaultRoleForEmail(emailLower)
  if (defaultRole !== 'student') return defaultRole
  if (role === 'super-instructor' || role === 'instructor') return role
  return 'student'
}

function normalizeIsoDate(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ''

  const [year, month, day] = trimmed.split('-').map((part) => Number(part))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return ''
  }

  return trimmed
}

function normalizeEmailArray(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((entry) => normalizeEmail(entry)).filter(Boolean))]
}

function parseJsonObject(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
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
  const role = getDefaultRoleForEmail(emailLower)

  try {
    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        emailLower,
        userId,
        name,
        passwordHash,
        createdAtMs,
        role,
        assignedInstructorEmail: '',
        studentEmails: [],
        notificationsJson: '[]',
      },
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
  return json(200, { userId, email: emailLower, name, token, role })
}

async function handleInstructorCreateAccount(event) {
  const auth = requireAuth(event)
  const { emailLower, user } = await getCurrentUserRecord(auth)
  if (!user) return json(404, { error: 'User account not found' })

  const actorRole = normalizeRole(user.role, emailLower)
  ensureSuperInstructorRole(actorRole)

  const body = readJsonBody(event) || {}
  const instructorEmail = normalizeEmail(body.email)
  const name = normalizeName(body.name)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!instructorEmail) return json(400, { error: 'email is required' })
  if (!password) return json(400, { error: 'password is required' })

  const existing = await getUserByEmailLower(instructorEmail)
  if (existing) return json(409, { error: 'Email already registered' })

  const userId = crypto.randomUUID()
  const passwordHash = hashPassword(password)
  const createdAtMs = Date.now()

  await ddb.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      emailLower: instructorEmail,
      userId,
      name,
      passwordHash,
      createdAtMs,
      role: 'instructor',
      assignedInstructorEmail: '',
      studentEmails: [],
      notificationsJson: '[]',
    },
    ConditionExpression: 'attribute_not_exists(emailLower)',
  }))

  return json(200, {
    email: instructorEmail,
    name,
    role: 'instructor',
  })
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
    role: normalizeRole(user.role, emailLower),
    assignedInstructorEmail: normalizeEmail(user.assignedInstructorEmail),
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

async function handleGetProfileSettings(event) {
  const auth = requireAuth(event)

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
  }))

  const user = res?.Item || {}
  const updatedAtMs = Number(user.profileSettingsUpdatedAtMs)

  return json(200, {
    goalStartDate: normalizeIsoDate(user.goalStartDate),
    goalEndDate: normalizeIsoDate(user.goalEndDate),
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
  })
}

async function handleSetProfileSettings(event) {
  const auth = requireAuth(event)
  const body = readJsonBody(event) || {}

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const goalStartDate = normalizeIsoDate(body.goalStartDate)
  const goalEndDate = normalizeIsoDate(body.goalEndDate)
  if (!goalStartDate) return json(400, { error: 'goalStartDate must be a valid YYYY-MM-DD date' })
  if (!goalEndDate) return json(400, { error: 'goalEndDate must be a valid YYYY-MM-DD date' })
  if (goalEndDate <= goalStartDate) return json(400, { error: 'goalEndDate must be after goalStartDate' })

  const now = Date.now()
  const result = await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
    ConditionExpression: 'userId = :uid',
    UpdateExpression: 'SET goalStartDate = :goalStartDate, goalEndDate = :goalEndDate, profileSettingsUpdatedAtMs = :updatedAtMs',
    ExpressionAttributeValues: {
      ':goalStartDate': goalStartDate,
      ':goalEndDate': goalEndDate,
      ':updatedAtMs': now,
      ':uid': auth.sub,
    },
    ReturnValues: 'ALL_NEW',
  }))

  const user = result?.Attributes || {}
  return json(200, {
    goalStartDate: normalizeIsoDate(user.goalStartDate),
    goalEndDate: normalizeIsoDate(user.goalEndDate),
    updatedAtMs: Number(user.profileSettingsUpdatedAtMs) || now,
  })
}

async function handleGetRendererState(event) {
  const auth = requireAuth(event)

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
  }))

  const user = res?.Item || {}
  let value = null
  try {
    value = typeof user.rendererStateJson === 'string' ? JSON.parse(user.rendererStateJson) : null
  } catch {
    value = null
  }
  const updatedAtMs = Number(user.rendererStateUpdatedAtMs)

  return json(200, {
    value,
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
  })
}

async function handleSetRendererState(event) {
  const auth = requireAuth(event)
  const body = readJsonBody(event) || {}

  const emailLower = normalizeEmail(auth.email)
  if (!emailLower) return json(401, { error: 'Invalid token (missing email)' })

  const now = Date.now()
  const serializedValue = JSON.stringify(body.value ?? null)

  const result = await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
    ConditionExpression: 'userId = :uid',
    UpdateExpression: 'SET rendererStateJson = :value, rendererStateUpdatedAtMs = :updatedAtMs',
    ExpressionAttributeValues: {
      ':value': serializedValue,
      ':updatedAtMs': now,
      ':uid': auth.sub,
    },
    ReturnValues: 'ALL_NEW',
  }))

  let value = null
  try {
    value = typeof result?.Attributes?.rendererStateJson === 'string'
      ? JSON.parse(result.Attributes.rendererStateJson)
      : null
  } catch {
    value = null
  }

  return json(200, {
    value,
    updatedAtMs: Number(result?.Attributes?.rendererStateUpdatedAtMs) || now,
  })
}

async function handleGetProfileAccount(event) {
  const auth = requireAuth(event)
  const { emailLower, user } = await getCurrentUserRecord(auth)
  if (!user) return json(404, { error: 'User account not found' })

  return json(200, buildAccountResponse({
    ...user,
    emailLower,
  }))
}

async function handleInstructorAssignStudents(event) {
  const auth = requireAuth(event)
  const { emailLower, user } = await getCurrentUserRecord(auth)
  if (!user) return json(404, { error: 'User account not found' })

  const role = normalizeRole(user.role, emailLower)
  ensureSuperInstructorRole(role)

  const body = readJsonBody(event) || {}
  const instructorEmail = normalizeEmail(body.instructorEmail)
  const studentEmails = normalizeEmailArray(body.studentEmails)
  if (!instructorEmail) return json(400, { error: 'instructorEmail is required' })
  if (!studentEmails.length) return json(400, { error: 'studentEmails must include at least one student' })

  const instructor = await getUserByEmailLower(instructorEmail)
  if (!instructor) return json(404, { error: 'Instructor account not found' })
  if (normalizeRole(instructor.role, instructorEmail) === 'student') {
    return json(400, { error: 'Selected instructorEmail is not configured as an instructor' })
  }

  const nextInstructorStudentEmails = new Set(normalizeEmailArray(instructor.studentEmails))

  for (const studentEmail of studentEmails) {
    const student = await getUserByEmailLower(studentEmail)
    if (!student) return json(404, { error: `Student account not found: ${studentEmail}` })

    const previousInstructorEmail = normalizeEmail(student.assignedInstructorEmail)
    if (previousInstructorEmail && previousInstructorEmail !== instructorEmail) {
      const previousInstructor = await getUserByEmailLower(previousInstructorEmail)
      if (previousInstructor) {
        await putUser({
          ...previousInstructor,
          studentEmails: normalizeEmailArray(previousInstructor.studentEmails).filter((entry) => entry !== studentEmail),
        })
      }
    }

    await putUser({
      ...student,
      role: normalizeRole(student.role, studentEmail),
      assignedInstructorEmail: instructorEmail,
    })
    nextInstructorStudentEmails.add(studentEmail)
  }

  await putUser({
    ...instructor,
    role: normalizeRole(instructor.role, instructorEmail),
    studentEmails: [...nextInstructorStudentEmails].sort(),
  })

  return json(200, {
    instructorEmail,
    studentEmails: [...nextInstructorStudentEmails].sort(),
  })
}

async function handleInstructorSetRole(event) {
  const auth = requireAuth(event)
  const { emailLower, user } = await getCurrentUserRecord(auth)
  if (!user) return json(404, { error: 'User account not found' })

  const actorRole = normalizeRole(user.role, emailLower)
  ensureSuperInstructorRole(actorRole)

  const body = readJsonBody(event) || {}
  const targetEmail = normalizeEmail(body.email)
  const targetRole = body.role === 'instructor' ? 'instructor' : 'student'
  if (!targetEmail) return json(400, { error: 'email is required' })

  const targetUser = await getUserByEmailLower(targetEmail)
  if (!targetUser) return json(404, { error: 'User account not found' })
  if (normalizeRole(targetUser.role, targetEmail) === 'super-instructor' || targetEmail === emailLower) {
    return json(400, { error: 'That account role cannot be changed here' })
  }

  if (targetRole === 'student') {
    const assignedStudents = normalizeEmailArray(targetUser.studentEmails)
    for (const studentEmail of assignedStudents) {
      const student = await getUserByEmailLower(studentEmail)
      if (!student) continue
      await putUser({
        ...student,
        assignedInstructorEmail: normalizeEmail(student.assignedInstructorEmail) === targetEmail ? '' : student.assignedInstructorEmail,
      })
    }
  }

  await putUser({
    ...targetUser,
    role: targetRole,
    studentEmails: targetRole === 'student' ? [] : normalizeEmailArray(targetUser.studentEmails),
  })

  return json(200, {
    email: targetEmail,
    role: targetRole,
  })
}

async function handleInstructorDashboard(event) {
  const auth = requireAuth(event)
  const { emailLower, user } = await getCurrentUserRecord(auth)
  if (!user) return json(404, { error: 'User account not found' })

  const role = normalizeRole(user.role, emailLower)
  ensureInstructorRole(role)

  let rosterInstructorEmail = emailLower
  let rosterInstructor = user
  let instructors = []

  if (role === 'super-instructor') {
    const allUsers = await listAllUsers()
    instructors = allUsers
      .map((candidate) => ({
        email: normalizeEmail(candidate?.emailLower),
        name: normalizeName(candidate?.name),
        role: normalizeRole(candidate?.role, normalizeEmail(candidate?.emailLower)),
        studentCount: normalizeEmailArray(candidate?.studentEmails).length,
      }))
      .filter((candidate) => candidate.role === 'instructor' || candidate.role === 'super-instructor')
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))

    const requestedInstructorEmail = normalizeEmail(event?.queryStringParameters?.instructorEmail)
    const ownRosterEntry = instructors.find((candidate) => candidate.email === emailLower)
    const fallbackInstructorEmail = ownRosterEntry?.studentCount > 0
      ? emailLower
      : instructors.find((candidate) => candidate.email !== emailLower && candidate.studentCount > 0)?.email
      || instructors.find((candidate) => candidate.email !== emailLower)?.email
      || emailLower

    rosterInstructorEmail = requestedInstructorEmail || fallbackInstructorEmail
    if (rosterInstructorEmail !== emailLower) {
      rosterInstructor = await getUserByEmailLower(rosterInstructorEmail)
      if (!rosterInstructor) return json(404, { error: 'Instructor account not found' })
    }
  }

  const candidateStudents = await Promise.all(normalizeEmailArray(rosterInstructor?.studentEmails).map((studentEmail) => getUserByEmailLower(studentEmail)))

  const students = []
  for (const candidate of candidateStudents) {
    if (!candidate) continue
    const candidateEmail = normalizeEmail(candidate.emailLower)
    const candidateRole = normalizeRole(candidate.role, candidateEmail)
    if (candidateRole !== 'student') continue
    if (normalizeEmail(candidate.assignedInstructorEmail) !== rosterInstructorEmail) continue

    const rendererState = parseRendererState(candidate)
    const ledgerItems = await getLedgerItemsForUserId(candidate.userId)
    students.push(buildStudentSummary(candidate, rendererState, ledgerItems))
  }

  students.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))

  return json(200, {
    role,
    instructor: {
      email: rosterInstructorEmail,
      name: normalizeName(rosterInstructor?.name),
    },
    instructors,
    students,
  })
}

async function handleInstructorNotifications(event) {
  const auth = requireAuth(event)
  const { emailLower, user } = await getCurrentUserRecord(auth)
  if (!user) return json(404, { error: 'User account not found' })

  const role = normalizeRole(user.role, emailLower)
  ensureInstructorRole(role)

  const body = readJsonBody(event) || {}
  const message = normalizeLedgerText(body.message, 240)
  if (!message) return json(400, { error: 'message is required' })

  let rosterOwner = user
  if (role === 'super-instructor') {
    const targetInstructorEmail = normalizeEmail(body.instructorEmail) || emailLower
    if (targetInstructorEmail !== emailLower) {
      rosterOwner = await getUserByEmailLower(targetInstructorEmail)
      if (!rosterOwner) return json(404, { error: 'Instructor account not found' })
    }
  }

  const recipientEmails = normalizeEmailArray(rosterOwner?.studentEmails)

  const uniqueRecipients = [...new Set(recipientEmails)].filter(Boolean)
  const notification = {
    id: crypto.randomUUID(),
    message,
    senderEmail: emailLower,
    createdAtMs: Date.now(),
  }

  for (const recipientEmail of uniqueRecipients) {
    const recipient = await getUserByEmailLower(recipientEmail)
    if (!recipient) continue
    await putUser({
      ...recipient,
      notificationsJson: serializeNotifications([notification, ...parseNotifications(recipient.notificationsJson)]),
    })
  }

  return json(200, {
    deliveredCount: uniqueRecipients.length,
    message,
  })
}

// ---- NEW: Ledger Sync ----
function normalizeClientId(clientId) {
  if (typeof clientId !== 'string') return ''
  const s = clientId.trim()
  // keep it simple; just prevent absurdly large keys
  if (!s || s.length > 200) return ''
  return s
}

function normalizeLedgerText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function normalizeLedgerFunds(value) {
  const funds = {}
  if (!value || typeof value !== 'object') return funds
  for (const [rawName, rawAmount] of Object.entries(value)) {
    const fundName = normalizeLedgerText(rawName, 80)
    const amount = Number(rawAmount)
    if (!fundName) continue
    if (!Number.isFinite(amount) || amount < 0) continue
    funds[fundName] = Math.round(amount)
  }
  return funds
}

function parseNotifications(value) {
  const items = parseJsonObject(value)
  if (!Array.isArray(items)) return []
  return items
    .map((item) => ({
      id: normalizeLedgerText(item?.id, 80),
      message: normalizeLedgerText(item?.message, 240),
      senderEmail: normalizeEmail(item?.senderEmail),
      createdAtMs: Number(item?.createdAtMs) || 0,
    }))
    .filter((item) => item.id && item.message)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 25)
}

function serializeNotifications(items) {
  return JSON.stringify(parseNotifications(items))
}

function parseRendererState(user) {
  const value = parseJsonObject(user?.rendererStateJson)
  return value && typeof value === 'object' ? value : null
}

function getCurrentSavingsFromRendererState(rendererState) {
  const entries = Array.isArray(rendererState?.savingsLogEntries) ? rendererState.savingsLogEntries : []
  if (!entries.length) return 0
  return Math.max(0, Math.round(Number(entries[entries.length - 1]?.dollars) || 0))
}

function countCompletedHabitChecks(rendererState) {
  const weeksByKey = rendererState?.habitBoardState?.weeksByKey
  if (!weeksByKey || typeof weeksByKey !== 'object') return 0
  let total = 0
  for (const week of Object.values(weeksByKey)) {
    const days = Array.isArray(week?.days) ? week.days : []
    for (const day of days) {
      const checks = Array.isArray(day?.checks) ? day.checks : []
      total += checks.filter(Boolean).length
    }
  }
  return total
}

function startOfUtcWeekMs(value) {
  const date = new Date(value)
  const day = (date.getUTCDay() + 6) % 7
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - day)
  return date.getTime()
}

function startOfUtcMonthMs(value) {
  const date = new Date(value)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function startOfUtcYearMs(value) {
  const date = new Date(value)
  return Date.UTC(date.getUTCFullYear(), 0, 1)
}

function summarizeLedgerItems(items, nowMs = Date.now()) {
  const weekStartMs = startOfUtcWeekMs(nowMs)
  const monthStartMs = startOfUtcMonthMs(nowMs)
  const yearStartMs = startOfUtcYearMs(nowMs)
  const summary = {
    weekly: { incomeDollars: 0, expensesDollars: 0, savingsDollars: 0 },
    monthly: { incomeDollars: 0, expensesDollars: 0, savingsDollars: 0 },
    yearly: { incomeDollars: 0, expensesDollars: 0, savingsDollars: 0 },
  }

  for (const item of Array.isArray(items) ? items : []) {
    const dayMs = Number(item?.dayMs)
    if (!Number.isFinite(dayMs) || dayMs <= 0) continue
    const incomeDollars = Math.max(0, Math.round(Number(item?.incomeDollars) || 0))
    const expensesDollars = Math.max(0, Math.round(Number(item?.expensesDollars) || 0))
    const savingsDollars = Math.max(0, Math.round(Number(item?.savingsDollars) || 0))

    if (dayMs >= yearStartMs) {
      summary.yearly.incomeDollars += incomeDollars
      summary.yearly.expensesDollars += expensesDollars
      summary.yearly.savingsDollars += savingsDollars
    }
    if (dayMs >= monthStartMs) {
      summary.monthly.incomeDollars += incomeDollars
      summary.monthly.expensesDollars += expensesDollars
      summary.monthly.savingsDollars += savingsDollars
    }
    if (dayMs >= weekStartMs) {
      summary.weekly.incomeDollars += incomeDollars
      summary.weekly.expensesDollars += expensesDollars
      summary.weekly.savingsDollars += savingsDollars
    }
  }

  return summary
}

function buildAccountResponse(user) {
  return {
    email: normalizeEmail(user?.emailLower),
    name: normalizeName(user?.name),
    role: normalizeRole(user?.role, normalizeEmail(user?.emailLower)),
    assignedInstructorEmail: normalizeEmail(user?.assignedInstructorEmail),
    studentEmails: normalizeEmailArray(user?.studentEmails),
    notifications: parseNotifications(user?.notificationsJson),
  }
}

function buildStudentSummary(user, rendererState, ledgerItems) {
  const profileSettings = rendererState?.profileSettings && typeof rendererState.profileSettings === 'object'
    ? rendererState.profileSettings
    : {}
  const weeklyReports = Array.isArray(rendererState?.weeklyReports) ? rendererState.weeklyReports : []
  const journalEntries = Array.isArray(rendererState?.journalEntries) ? rendererState.journalEntries : []

  return {
    email: normalizeEmail(user?.emailLower),
    name: normalizeName(user?.name) || normalizeName(profileSettings?.name),
    role: normalizeRole(user?.role, normalizeEmail(user?.emailLower)),
    assignedInstructorEmail: normalizeEmail(user?.assignedInstructorEmail),
    profile: {
      contactInfo: normalizeLedgerText(profileSettings?.contactInfo, 240),
      strengths: normalizeLedgerText(profileSettings?.strengths, 400),
      weaknesses: normalizeLedgerText(profileSettings?.weaknesses, 400),
      goalStartDate: normalizeIsoDate(user?.goalStartDate),
      goalEndDate: normalizeIsoDate(user?.goalEndDate),
    },
    goal: {
      goalDollars: Math.max(0, Math.round(Number(user?.goalDollars) || 0)),
      currentSavingsDollars: getCurrentSavingsFromRendererState(rendererState),
    },
    financial: summarizeLedgerItems(ledgerItems),
    reports: {
      weeklyReportCount: weeklyReports.length,
      monthlyJournalCount: journalEntries.length,
      latestWeeklyReportWeek: normalizeLedgerText(weeklyReports[0]?.week, 20),
      latestJournalMonth: normalizeLedgerText(journalEntries[0]?.month, 20),
    },
    habitBoard: {
      weeksTracked: Object.keys(rendererState?.habitBoardState?.weeksByKey || {}).length,
      completedChecks: countCompletedHabitChecks(rendererState),
    },
    notifications: parseNotifications(user?.notificationsJson),
  }
}

async function getUserByEmailLower(emailLower) {
  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { emailLower },
  }))
  return res?.Item || null
}

async function putUser(item) {
  await ddb.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: item,
  }))
}

async function listAllUsers() {
  const out = await ddb.send(new ScanCommand({ TableName: USERS_TABLE }))
  return Array.isArray(out?.Items) ? out.Items : []
}

async function getCurrentUserRecord(auth) {
  const emailLower = normalizeEmail(auth?.email)
  if (!emailLower) {
    const e = new Error('Invalid token (missing email)')
    e.code = 'INVALID_TOKEN'
    throw e
  }
  return { emailLower, user: await getUserByEmailLower(emailLower) }
}

function ensureInstructorRole(role) {
  if (role === 'instructor' || role === 'super-instructor') return
  const e = new Error('Instructor access required')
  e.code = 'FORBIDDEN'
  throw e
}

function ensureSuperInstructorRole(role) {
  if (role === 'super-instructor') return
  const e = new Error('Super instructor access required')
  e.code = 'FORBIDDEN'
  throw e
}

async function getLedgerItemsForUserId(userId) {
  if (!userId) return []
  const out = await ddb.send(new QueryCommand({
    TableName: LEDGER_TABLE,
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }))
  return Array.isArray(out?.Items) ? out.Items : []
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
  const incomeSource = normalizeLedgerText(body.incomeSource, 120)
  const incomeNote = normalizeLedgerText(body.incomeNote, 240)
  const expenseCategory = normalizeLedgerText(body.expenseCategory, 80)
  const expenseNote = normalizeLedgerText(body.expenseNote, 240)
  const funds = normalizeLedgerFunds(body.funds)

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
      'incomeSource = :incomeSource',
      'incomeNote = :incomeNote',
      'expenseCategory = :expenseCategory',
      'expenseNote = :expenseNote',
      'funds = :funds',
      'updatedAtMs = :u',
      'createdAtMs = if_not_exists(createdAtMs, :c)',
    ].join(', '),
    ExpressionAttributeValues: {
      ':day': Math.round(dayMs),
      ':inc': Math.max(0, Math.round(incomeDollars)),
      ':exp': Math.max(0, Math.round(expensesDollars)),
      ':sav': Math.max(0, Math.round(savingsDollars)),
      ':incomeSource': incomeSource,
      ':incomeNote': incomeNote,
      ':expenseCategory': expenseCategory,
      ':expenseNote': expenseNote,
      ':funds': funds,
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
      if (routeKey === 'GET /profile/settings') return await handleGetProfileSettings(event)
      if (routeKey === 'POST /profile/settings') return await handleSetProfileSettings(event)
      if (routeKey === 'GET /profile/account') return await handleGetProfileAccount(event)
      if (routeKey === 'GET /profile/renderer-state') return await handleGetRendererState(event)
      if (routeKey === 'POST /profile/renderer-state') return await handleSetRendererState(event)

      if (routeKey === 'GET /ledger/pull') return await handleLedgerPull(event)
      if (routeKey === 'POST /ledger/upsert') return await handleLedgerUpsert(event)
      if (routeKey === 'GET /instructor/dashboard') return await handleInstructorDashboard(event)
      if (routeKey === 'POST /instructor/create-account') return await handleInstructorCreateAccount(event)
      if (routeKey === 'POST /instructor/set-role') return await handleInstructorSetRole(event)
      if (routeKey === 'POST /instructor/assign-students') return await handleInstructorAssignStudents(event)
      if (routeKey === 'POST /instructor/notifications') return await handleInstructorNotifications(event)
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
    if (method === 'GET' && path.endsWith('/profile/settings')) return await handleGetProfileSettings(event)
    if (method === 'POST' && path.endsWith('/profile/settings')) return await handleSetProfileSettings(event)
    if (method === 'GET' && path.endsWith('/profile/account')) return await handleGetProfileAccount(event)
    if (method === 'GET' && path.endsWith('/profile/renderer-state')) return await handleGetRendererState(event)
    if (method === 'POST' && path.endsWith('/profile/renderer-state')) return await handleSetRendererState(event)

    if (method === 'GET' && path.endsWith('/ledger/pull')) return await handleLedgerPull(event)
    if (method === 'POST' && path.endsWith('/ledger/upsert')) return await handleLedgerUpsert(event)
    if (method === 'GET' && path.endsWith('/instructor/dashboard')) return await handleInstructorDashboard(event)
    if (method === 'POST' && path.endsWith('/instructor/set-role')) return await handleInstructorSetRole(event)
    if (method === 'POST' && path.endsWith('/instructor/assign-students')) return await handleInstructorAssignStudents(event)
    if (method === 'POST' && path.endsWith('/instructor/notifications')) return await handleInstructorNotifications(event)

    return json(404, { error: 'Not found' })
  } catch (err) {
    if (err?.code === 'BAD_JSON') return json(400, { error: 'Invalid JSON body' })
    if (err?.code === 'NOT_AUTHENTICATED') return json(401, { error: err.message || 'Not authenticated' })
    if (err?.code === 'TOKEN_EXPIRED' || err?.code === 'INVALID_TOKEN') return json(401, { error: err.message || 'Invalid token' })
    if (err?.code === 'FORBIDDEN') return json(403, { error: err.message || 'Forbidden' })

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
  normalizeIsoDate,
  readJsonBody,
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  getRoute,
}