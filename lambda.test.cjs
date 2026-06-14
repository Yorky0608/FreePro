const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

function createHarness() {
  const users = new Map()
  const savings = new Map()
  const ledger = new Map()

  class PutCommand {
    constructor(input) {
      this.input = input
    }
  }

  class GetCommand {
    constructor(input) {
      this.input = input
    }
  }

  class UpdateCommand {
    constructor(input) {
      this.input = input
    }
  }

  class QueryCommand {
    constructor(input) {
      this.input = input
    }
  }

  class ScanCommand {
    constructor(input) {
      this.input = input
    }
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value))
  }

  function applyUserUpdate(item, input) {
    const values = input.ExpressionAttributeValues || {}
    if (input.UpdateExpression.includes('SET #name = :name')) {
      item.name = values[':name']
    }
    if (input.UpdateExpression.includes('goalStartDate = :goalStartDate')) {
      item.goalStartDate = values[':goalStartDate']
      item.goalEndDate = values[':goalEndDate']
      item.profileSettingsUpdatedAtMs = values[':updatedAtMs']
    }
    if (input.UpdateExpression.includes('goalDollars = :g')) {
      item.goalDollars = values[':g']
      item.goalUpdatedAtMs = values[':u']
      if (item.goalCreatedAtMs == null) item.goalCreatedAtMs = values[':u']
    }
    if (input.UpdateExpression.includes('rendererStateJson = :value')) {
      item.rendererStateJson = values[':value']
      item.rendererStateUpdatedAtMs = values[':updatedAtMs']
    }
    return item
  }

  const docClient = {
    async send(command) {
      if (command instanceof PutCommand) {
        const { TableName, Item, ConditionExpression } = command.input
        if (TableName === 'users-table') {
          if (ConditionExpression === 'attribute_not_exists(emailLower)' && users.has(Item.emailLower)) {
            const error = new Error('Conditional check failed')
            error.name = 'ConditionalCheckFailedException'
            throw error
          }
          users.set(Item.emailLower, clone(Item))
          return {}
        }
        throw new Error(`Unexpected PutCommand table: ${TableName}`)
      }

      if (command instanceof GetCommand) {
        const { TableName, Key } = command.input
        if (TableName === 'users-table') {
          return { Item: clone(users.get(Key.emailLower)) }
        }
        if (TableName === 'savings-table') {
          return { Item: clone(savings.get(`${Key.userId}:${Key.monthMs}`)) }
        }
        throw new Error(`Unexpected GetCommand table: ${TableName}`)
      }

      if (command instanceof UpdateCommand) {
        const { TableName, Key, ConditionExpression, ExpressionAttributeValues } = command.input
        if (TableName === 'users-table') {
          const existing = users.get(Key.emailLower)
          if (!existing) {
            const error = new Error('Missing user')
            error.name = 'ConditionalCheckFailedException'
            throw error
          }
          if (ConditionExpression === 'userId = :uid' && existing.userId !== ExpressionAttributeValues[':uid']) {
            const error = new Error('Conditional check failed')
            error.name = 'ConditionalCheckFailedException'
            throw error
          }
          const updated = applyUserUpdate({ ...existing }, command.input)
          users.set(Key.emailLower, updated)
          return { Attributes: clone(updated) }
        }
        if (TableName === 'savings-table') {
          const key = `${Key.userId}:${Key.monthMs}`
          const existing = savings.get(key) || { userId: Key.userId, monthMs: Key.monthMs }
          const updated = {
            ...existing,
            dollars: ExpressionAttributeValues[':d'],
            updatedAtMs: ExpressionAttributeValues[':u'],
            createdAtMs: existing.createdAtMs ?? ExpressionAttributeValues[':u'],
          }
          savings.set(key, updated)
          return { Attributes: clone(updated) }
        }
        if (TableName === 'ledger-table') {
          const key = `${Key.userId}:${Key.clientId}`
          const existing = ledger.get(key) || { userId: Key.userId, clientId: Key.clientId }
          const updated = {
            ...existing,
            dayMs: ExpressionAttributeValues[':day'],
            incomeDollars: ExpressionAttributeValues[':inc'],
            expensesDollars: ExpressionAttributeValues[':exp'],
            savingsDollars: ExpressionAttributeValues[':sav'],
            incomeSource: ExpressionAttributeValues[':incomeSource'],
            incomeNote: ExpressionAttributeValues[':incomeNote'],
            expenseCategory: ExpressionAttributeValues[':expenseCategory'],
            expenseNote: ExpressionAttributeValues[':expenseNote'],
            funds: clone(ExpressionAttributeValues[':funds']),
            updatedAtMs: ExpressionAttributeValues[':u'],
            createdAtMs: existing.createdAtMs ?? ExpressionAttributeValues[':c'],
          }
          ledger.set(key, updated)
          return { Attributes: clone(updated) }
        }
        throw new Error(`Unexpected UpdateCommand table: ${TableName}`)
      }

      if (command instanceof QueryCommand) {
        const { TableName, ExpressionAttributeValues } = command.input
        if (TableName === 'savings-table') {
          const items = [...savings.values()].filter((item) => item.userId === ExpressionAttributeValues[':uid'])
          return { Items: clone(items) }
        }
        if (TableName === 'ledger-table') {
          const items = [...ledger.values()].filter((item) => item.userId === ExpressionAttributeValues[':uid'])
          return { Items: clone(items) }
        }
        throw new Error(`Unexpected QueryCommand table: ${TableName}`)
      }

      if (command instanceof ScanCommand) {
        const { TableName } = command.input
        if (TableName === 'users-table') {
          return { Items: clone([...users.values()]) }
        }
        throw new Error(`Unexpected ScanCommand table: ${TableName}`)
      }

      throw new Error(`Unexpected command: ${command?.constructor?.name}`)
    },
  }

  return {
    users,
    sdkModules: {
      '@aws-sdk/client-dynamodb': {
        DynamoDBClient: class DynamoDBClient {},
      },
      '@aws-sdk/lib-dynamodb': {
        DynamoDBDocumentClient: {
          from() {
            return docClient
          },
        },
        PutCommand,
        GetCommand,
        UpdateCommand,
        QueryCommand,
        ScanCommand,
      },
    },
  }
}

function loadLambda() {
  process.env.USERS_TABLE = 'users-table'
  process.env.SAVINGS_TABLE = 'savings-table'
  process.env.LEDGER_TABLE = 'ledger-table'
  process.env.JWT_SECRET = 'test-secret'
  delete process.env.JWT_ISS
  delete process.env.JWT_AUD
  process.env.INSTRUCTOR_EMAILS = 'coach@example.com'
  process.env.SUPER_INSTRUCTOR_EMAILS = 'super@example.com'

  const lambdaPath = path.resolve(__dirname, 'lambda.js')
  const harness = createHarness()
  const originalLoad = Module._load

  Module._load = function patchedLoad(request, parent, isMain) {
    if (harness.sdkModules[request]) return harness.sdkModules[request]
    return originalLoad.call(this, request, parent, isMain)
  }

  delete require.cache[lambdaPath]
  try {
    const mod = require(lambdaPath)
    return { ...harness, lambda: mod }
  } finally {
    Module._load = originalLoad
  }
}

function eventFor(routeKey, body, headers) {
  const rawPath = routeKey.split(' ')[1]
  const [pathOnly, rawQuery] = rawPath.split('?')
  const queryStringParameters = rawQuery
    ? Object.fromEntries(rawQuery.split('&').map((entry) => {
      const [rawKey, rawValue = ''] = entry.split('=')
      return [decodeURIComponent(rawKey), decodeURIComponent(rawValue)]
    }))
    : undefined
  return {
    routeKey,
    headers: headers || {},
    body: body == null ? '' : JSON.stringify(body),
    queryStringParameters,
    requestContext: {
      http: { method: routeKey.split(' ')[0] },
      stage: '$default',
    },
    rawPath: pathOnly,
  }
}

test('register stores and returns normalized name', async () => {
  const { lambda, users } = loadLambda()

  const res = await lambda.handler(eventFor('POST /auth/register', {
    email: ' Person@Example.com ',
    password: 'password123',
    name: '  Person   Name  ',
  }))

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.email, 'person@example.com')
  assert.equal(body.name, 'Person Name')
  assert.ok(typeof body.token === 'string' && body.token.length > 20)

  const stored = users.get('person@example.com')
  assert.equal(stored.name, 'Person Name')
  assert.equal(stored.emailLower, 'person@example.com')
})

test('login returns stored name', async () => {
  const { lambda } = loadLambda()

  await lambda.handler(eventFor('POST /auth/register', {
    email: 'login@example.com',
    password: 'password123',
    name: 'Login User',
  }))

  const res = await lambda.handler(eventFor('POST /auth/login', {
    email: 'login@example.com',
    password: 'password123',
  }))

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.name, 'Login User')
  assert.equal(body.email, 'login@example.com')
})

test('profile name route updates and returns normalized name', async () => {
  const { lambda, users } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'rename@example.com',
    password: 'password123',
    name: 'Original Name',
  }))
  const registerBody = JSON.parse(registerRes.body)

  const res = await lambda.handler(eventFor(
    'POST /profile/name',
    { name: '  New   Display   Name ' },
    { authorization: `Bearer ${registerBody.token}` }
  ))

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.name, 'New Display Name')
  assert.equal(users.get('rename@example.com').name, 'New Display Name')
})

test('get profile name returns the stored normalized name', async () => {
  const { lambda } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'readname@example.com',
    password: 'password123',
    name: 'Read Name',
  }))
  const registerBody = JSON.parse(registerRes.body)

  const res = await lambda.handler(eventFor(
    'GET /profile/name',
    null,
    { authorization: `Bearer ${registerBody.token}` }
  ))

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.name, 'Read Name')
})

test('profile settings routes round-trip goal timeline dates', async () => {
  const { lambda, users } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'timeline@example.com',
    password: 'password123',
    name: 'Timeline User',
  }))
  const registerBody = JSON.parse(registerRes.body)
  const headers = { authorization: `Bearer ${registerBody.token}` }

  const saveRes = await lambda.handler(eventFor(
    'POST /profile/settings',
    { goalStartDate: '2026-01-01', goalEndDate: '2030-01-01' },
    headers,
  ))

  assert.equal(saveRes.statusCode, 200)
  const saveBody = JSON.parse(saveRes.body)
  assert.equal(saveBody.goalStartDate, '2026-01-01')
  assert.equal(saveBody.goalEndDate, '2030-01-01')
  assert.ok(saveBody.updatedAtMs > 0)

  const getRes = await lambda.handler(eventFor('GET /profile/settings', null, headers))
  assert.equal(getRes.statusCode, 200)
  const getBody = JSON.parse(getRes.body)
  assert.equal(getBody.goalStartDate, '2026-01-01')
  assert.equal(getBody.goalEndDate, '2030-01-01')

  const stored = users.get('timeline@example.com')
  assert.equal(stored.goalStartDate, '2026-01-01')
  assert.equal(stored.goalEndDate, '2030-01-01')
})

test('profile settings route rejects an end date before the start date', async () => {
  const { lambda } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'timeline-invalid@example.com',
    password: 'password123',
    name: 'Timeline User',
  }))
  const registerBody = JSON.parse(registerRes.body)

  const saveRes = await lambda.handler(eventFor(
    'POST /profile/settings',
    { goalStartDate: '2030-01-01', goalEndDate: '2026-01-01' },
    { authorization: `Bearer ${registerBody.token}` },
  ))

  assert.equal(saveRes.statusCode, 400)
  assert.match(JSON.parse(saveRes.body).error, /goalEndDate must be after goalStartDate/)
})

test('profile goal routes round-trip the goal amount', async () => {
  const { lambda, users } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'goal@example.com',
    password: 'password123',
    name: 'Goal User',
  }))
  const registerBody = JSON.parse(registerRes.body)
  const headers = { authorization: `Bearer ${registerBody.token}` }

  const saveRes = await lambda.handler(eventFor('POST /profile/goal', {
    goalDollars: 17500,
  }, headers))

  assert.equal(saveRes.statusCode, 200)
  const saveBody = JSON.parse(saveRes.body)
  assert.equal(saveBody.goalDollars, 17500)
  assert.ok(saveBody.updatedAtMs > 0)

  const getRes = await lambda.handler(eventFor('GET /profile/goal', null, headers))
  assert.equal(getRes.statusCode, 200)
  const getBody = JSON.parse(getRes.body)
  assert.equal(getBody.goalDollars, 17500)

  const stored = users.get('goal@example.com')
  assert.equal(stored.goalDollars, 17500)
})

test('renderer state routes round-trip the stored state payload', async () => {
  const { lambda } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'renderer@example.com',
    password: 'password123',
    name: 'Renderer User',
  }))
  const registerBody = JSON.parse(registerRes.body)
  const headers = { authorization: `Bearer ${registerBody.token}` }

  const payload = {
    profileSettings: { contactInfo: '555-1111', strengths: 'Reading' },
    weeklyReports: [{ week: '2026-05-25', incomeJob1: 200 }],
  }

  const saveRes = await lambda.handler(eventFor('POST /profile/renderer-state', {
    value: payload,
  }, headers))
  assert.equal(saveRes.statusCode, 200)
  const saveBody = JSON.parse(saveRes.body)
  assert.deepEqual(saveBody.value, payload)
  assert.ok(saveBody.updatedAtMs > 0)

  const getRes = await lambda.handler(eventFor('GET /profile/renderer-state', null, headers))
  assert.equal(getRes.statusCode, 200)
  const getBody = JSON.parse(getRes.body)
  assert.deepEqual(getBody.value, payload)
})

test('legacy sync save and pull routes round-trip savings snapshots', async () => {
  const { lambda } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'sync@example.com',
    password: 'password123',
    name: 'Sync User',
  }))
  const registerBody = JSON.parse(registerRes.body)
  const headers = { authorization: `Bearer ${registerBody.token}` }

  const saveRes = await lambda.handler(eventFor('POST /sync/save', {
    monthMs: 1714521600000,
    dollars: 3200,
  }, headers))
  assert.equal(saveRes.statusCode, 200)
  const saveBody = JSON.parse(saveRes.body)
  assert.equal(saveBody.ok, true)
  assert.equal(saveBody.item.dollars, 3200)

  const pullRes = await lambda.handler(eventFor('GET /sync/pull', null, headers))
  assert.equal(pullRes.statusCode, 200)
  const pullBody = JSON.parse(pullRes.body)
  assert.equal(Array.isArray(pullBody.items), true)
  assert.equal(pullBody.items.length, 1)
  assert.equal(pullBody.items[0].monthMs, 1714521600000)
  assert.equal(pullBody.items[0].dollars, 3200)
})

test('ledger routes round-trip richer financial metadata', async () => {
  const { lambda } = loadLambda()

  const registerRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'ledgermeta@example.com',
    password: 'password123',
    name: 'Ledger Meta',
  }))
  const registerBody = JSON.parse(registerRes.body)
  const headers = { authorization: `Bearer ${registerBody.token}` }

  const upsertRes = await lambda.handler(eventFor('POST /ledger/upsert', {
    clientId: 'ledger-meta-1',
    dayMs: 1715904000000,
    incomeDollars: 1200,
    expensesDollars: 300,
    savingsDollars: 900,
    incomeSource: ' Paycheck ',
    incomeNote: ' Main job deposit ',
    expenseCategory: ' Housing ',
    expenseNote: ' Rent payment ',
    funds: {
      'E-Fund': 400,
      ' Car Fund ': 200,
      '': 50,
      'Bad Fund': -5,
    },
  }, headers))

  assert.equal(upsertRes.statusCode, 200)
  const upsertBody = JSON.parse(upsertRes.body)
  assert.equal(upsertBody.item.incomeSource, 'Paycheck')
  assert.equal(upsertBody.item.expenseCategory, 'Housing')
  assert.deepEqual(upsertBody.item.funds, { 'E-Fund': 400, 'Car Fund': 200 })

  const pullRes = await lambda.handler(eventFor('GET /ledger/pull', null, headers))
  assert.equal(pullRes.statusCode, 200)
  const pullBody = JSON.parse(pullRes.body)
  assert.equal(Array.isArray(pullBody.items), true)
  assert.equal(pullBody.items.length, 1)
  assert.equal(pullBody.items[0].incomeNote, 'Main job deposit')
  assert.equal(pullBody.items[0].expenseNote, 'Rent payment')
  assert.deepEqual(pullBody.items[0].funds, { 'E-Fund': 400, 'Car Fund': 200 })
})

test('register marks configured instructor emails with instructor roles', async () => {
  const { lambda } = loadLambda()

  const instructorRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'coach@example.com',
    password: 'password123',
    name: 'Coach User',
  }))
  const instructorBody = JSON.parse(instructorRes.body)
  assert.equal(instructorRes.statusCode, 200)
  assert.equal(instructorBody.role, 'instructor')

  const superRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'super@example.com',
    password: 'password123',
    name: 'Super User',
  }))
  const superBody = JSON.parse(superRes.body)
  assert.equal(superRes.statusCode, 200)
  assert.equal(superBody.role, 'super-instructor')
})

test('super instructor can assign students and instructors can view summaries and notify them', async () => {
  const { lambda } = loadLambda()

  const superRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'super@example.com',
    password: 'password123',
    name: 'Super User',
  }))
  const superBody = JSON.parse(superRes.body)
  const superHeaders = { authorization: `Bearer ${superBody.token}` }

  const instructorRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'coach@example.com',
    password: 'password123',
    name: 'Coach User',
  }))
  const instructorBody = JSON.parse(instructorRes.body)
  const instructorHeaders = { authorization: `Bearer ${instructorBody.token}` }

  const studentRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'student@example.com',
    password: 'password123',
    name: 'Student User',
  }))
  const studentBody = JSON.parse(studentRes.body)
  const studentHeaders = { authorization: `Bearer ${studentBody.token}` }

  const profileRes = await lambda.handler(eventFor('POST /profile/settings', {
    goalStartDate: '2026-01-01',
    goalEndDate: '2030-01-01',
  }, studentHeaders))
  assert.equal(profileRes.statusCode, 200)

  const rendererStateRes = await lambda.handler(eventFor('POST /profile/renderer-state', {
    value: {
      weeklyReports: [{ week: '2026-05-25', incomeJob1: 400, incomeJob2: 100, expenses: 250 }],
      journalEntries: [{ month: '2026-05-01', own: 1800, owe: 300 }],
      savingsLogEntries: [{ month: 202605, dollars: 2400 }],
      habitBoardState: {
        boxes: [{ items: [{ title: 'Workout', icon: 'W' }, { title: 'Read', icon: 'R' }] }],
        weeksByKey: {
          '2026-05-25': {
            days: [
              { checks: [true, false] },
              { checks: [true, true] },
              { checks: [false, false] },
              { checks: [true, false] },
              { checks: [true, true] },
              { checks: [false, true] },
              { checks: [true, true] },
            ],
          },
        },
      },
    },
  }, studentHeaders))
  assert.equal(rendererStateRes.statusCode, 200)

  const promoteRes = await lambda.handler(eventFor('POST /instructor/set-role', {
    email: 'coach2@example.com',
    role: 'instructor',
  }, superHeaders))
  assert.equal(promoteRes.statusCode, 404)

  const createInstructorRes = await lambda.handler(eventFor('POST /instructor/create-account', {
    email: 'coach2@example.com',
    password: 'password123',
    name: 'Coach Two',
  }, superHeaders))
  assert.equal(createInstructorRes.statusCode, 200)
  const createInstructorBody = JSON.parse(createInstructorRes.body)
  assert.equal(createInstructorBody.role, 'instructor')

  const secondPromoteRes = await lambda.handler(eventFor('POST /instructor/set-role', {
    email: 'coach2@example.com',
    role: 'instructor',
  }, superHeaders))
  assert.equal(secondPromoteRes.statusCode, 200)

  const assignRes = await lambda.handler(eventFor('POST /instructor/assign-students', {
    instructorEmail: 'coach@example.com',
    studentEmails: ['student@example.com'],
  }, superHeaders))
  assert.equal(assignRes.statusCode, 200)
  const assignBody = JSON.parse(assignRes.body)
  assert.deepEqual(assignBody.studentEmails, ['student@example.com'])

  const dashboardRes = await lambda.handler(eventFor('GET /instructor/dashboard', null, instructorHeaders))
  assert.equal(dashboardRes.statusCode, 200)
  const dashboardBody = JSON.parse(dashboardRes.body)
  assert.equal(dashboardBody.students.length, 1)
  assert.equal(dashboardBody.students[0].email, 'student@example.com')
  assert.equal(dashboardBody.students[0].assignedInstructorEmail, 'coach@example.com')
  assert.equal(dashboardBody.students[0].goal.currentSavingsDollars, 2400)
  assert.equal(dashboardBody.students[0].reports.monthlyJournalCount, 1)
  assert.equal(dashboardBody.students[0].reports.weeklyReportCount, 1)
  assert.equal(dashboardBody.students[0].habitBoard.completedChecks, 9)

  const superDashboardRes = await lambda.handler(eventFor('GET /instructor/dashboard?instructorEmail=coach%40example.com', null, superHeaders))
  assert.equal(superDashboardRes.statusCode, 200)
  const superDashboardBody = JSON.parse(superDashboardRes.body)
  assert.equal(superDashboardBody.instructor.email, 'coach@example.com')
  assert.equal(superDashboardBody.instructors.some((entry) => entry.email === 'coach@example.com' && entry.role === 'instructor'), true)
  assert.equal(superDashboardBody.students.length, 1)
  assert.equal(superDashboardBody.students[0].email, 'student@example.com')

  const superStudentRes = await lambda.handler(eventFor('POST /auth/register', {
    email: 'super-student@example.com',
    password: 'password123',
    name: 'Super Student',
  }))
  assert.equal(superStudentRes.statusCode, 200)

  const superAssignRes = await lambda.handler(eventFor('POST /instructor/assign-students', {
    instructorEmail: 'super@example.com',
    studentEmails: ['super-student@example.com'],
  }, superHeaders))
  assert.equal(superAssignRes.statusCode, 200)

  const ownSuperDashboardRes = await lambda.handler(eventFor('GET /instructor/dashboard', null, superHeaders))
  assert.equal(ownSuperDashboardRes.statusCode, 200)
  const ownSuperDashboardBody = JSON.parse(ownSuperDashboardRes.body)
  assert.equal(ownSuperDashboardBody.instructor.email, 'super@example.com')
  assert.equal(ownSuperDashboardBody.students.length, 1)
  assert.equal(ownSuperDashboardBody.students[0].email, 'super-student@example.com')

  const notifyRes = await lambda.handler(eventFor('POST /instructor/notifications', {
    message: 'Team meeting on Monday',
  }, instructorHeaders))
  assert.equal(notifyRes.statusCode, 200)
  const notifyBody = JSON.parse(notifyRes.body)
  assert.equal(notifyBody.deliveredCount, 1)

  const studentAccountRes = await lambda.handler(eventFor('GET /profile/account', null, studentHeaders))
  assert.equal(studentAccountRes.statusCode, 200)
  const studentAccountBody = JSON.parse(studentAccountRes.body)
  assert.equal(studentAccountBody.role, 'student')
  assert.equal(studentAccountBody.assignedInstructorEmail, 'coach@example.com')
  assert.equal(studentAccountBody.notifications.length, 1)
  assert.match(studentAccountBody.notifications[0].message, /Team meeting on Monday/)
})
