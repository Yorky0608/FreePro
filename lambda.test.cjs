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

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value))
  }

  function applyUserUpdate(item, input) {
    const values = input.ExpressionAttributeValues || {}
    if (input.UpdateExpression.includes('SET #name = :name')) {
      item.name = values[':name']
    }
    if (input.UpdateExpression.includes('goalDollars = :g')) {
      item.goalDollars = values[':g']
      item.goalUpdatedAtMs = values[':u']
      if (item.goalCreatedAtMs == null) item.goalCreatedAtMs = values[':u']
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
  return {
    routeKey,
    headers: headers || {},
    body: body == null ? '' : JSON.stringify(body),
    requestContext: {
      http: { method: routeKey.split(' ')[0] },
      stage: '$default',
    },
    rawPath: routeKey.split(' ')[1],
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
