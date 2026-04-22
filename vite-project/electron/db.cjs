const fs = require('fs')
const path = require('path')

const initSqlJs = require('sql.js')

let SQL = null
/** @type {import('sql.js').Database | null} */
let db = null
let dbFilePath = null

function requireReady() {
	if (!db || !SQL || !dbFilePath) {
		throw new Error('Database not initialized')
	}
}

function normalizeEmail(email) {
	if (typeof email !== 'string') return ''
	return email.trim().toLowerCase()
}

function locateSqlWasm(file) {
	const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
	const wasmDir = path.dirname(wasmPath)
	return path.join(wasmDir, file)
}

function persist() {
	requireReady()
	const data = db.export()
	fs.mkdirSync(path.dirname(dbFilePath), { recursive: true })
	fs.writeFileSync(dbFilePath, Buffer.from(data))
}

function migrate() {
	requireReady()
	db.run(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS savings (
			user_id INTEGER NOT NULL,
			month_ms INTEGER NOT NULL,
			dollars INTEGER NOT NULL,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL,
			PRIMARY KEY (user_id, month_ms),
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS user_profile (
			user_id INTEGER PRIMARY KEY,
			goal_dollars INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS ledger_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			client_id TEXT,
			day_ms INTEGER NOT NULL,
			income_dollars INTEGER NOT NULL DEFAULT 0,
			expenses_dollars INTEGER NOT NULL DEFAULT 0,
			savings_dollars INTEGER NOT NULL DEFAULT 0,
			created_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_savings_user_month ON savings(user_id, month_ms);
		CREATE INDEX IF NOT EXISTS idx_ledger_user_day ON ledger_entries(user_id, day_ms);
	`)

	// Backfill/migrate existing installs that created ledger_entries before client_id existed.
	try {
		const info = getAll('PRAGMA table_info(ledger_entries)')
		const cols = new Set(info.map((r) => String(r.name)))
		if (!cols.has('client_id')) {
			run('ALTER TABLE ledger_entries ADD COLUMN client_id TEXT')
		}
	} catch {
		// ignore
	}

	// Ensure uniqueness per-user for de-duping cloud sync.
	try {
		run('CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_user_client ON ledger_entries(user_id, client_id)')
	} catch {
		// ignore
	}
}

function getOne(sql, params = []) {
	requireReady()
	const stmt = db.prepare(sql)
	try {
		stmt.bind(params)
		if (!stmt.step()) return null
		return stmt.getAsObject()
	} finally {
		stmt.free()
	}
}

function getAll(sql, params = []) {
	requireReady()
	const stmt = db.prepare(sql)
	try {
		stmt.bind(params)
		/** @type {any[]} */
		const rows = []
		while (stmt.step()) rows.push(stmt.getAsObject())
		return rows
	} finally {
		stmt.free()
	}
}

function run(sql, params = []) {
	requireReady()
	db.run(sql, params)
}

async function initDb({ userDataPath }) {
	if (db) return

	if (!userDataPath) throw new Error('initDb requires userDataPath')
	dbFilePath = path.join(userDataPath, 'freedom-program.sqlite3')

	SQL = await initSqlJs({ locateFile: locateSqlWasm })

	if (fs.existsSync(dbFilePath)) {
		const fileBuffer = fs.readFileSync(dbFilePath)
		db = new SQL.Database(fileBuffer)
	} else {
		db = new SQL.Database()
	}

	migrate()
	persist()
}

function createUser({ email, passwordHash }) {
	const safeEmail = normalizeEmail(email)
	if (!safeEmail) throw new Error('Email is required')
	if (typeof passwordHash !== 'string' || passwordHash.length < 10) throw new Error('Invalid password hash')

	const now = Date.now()
	run(
		`INSERT INTO users (email, password_hash, created_at_ms) VALUES (?, ?, ?)` ,
		[safeEmail, passwordHash, now]
	)
	persist()

	const row = getOne('SELECT id, email, created_at_ms FROM users WHERE email = ?', [safeEmail])
	if (!row) throw new Error('Failed to create user')
	return { id: Number(row.id), email: String(row.email), createdAtMs: Number(row.created_at_ms) }
}

function getUserByEmail(email) {
	const safeEmail = normalizeEmail(email)
	if (!safeEmail) return null
	const row = getOne('SELECT id, email, password_hash, created_at_ms FROM users WHERE email = ?', [safeEmail])
	if (!row) return null
	return {
		id: Number(row.id),
		email: String(row.email),
		passwordHash: String(row.password_hash),
		createdAtMs: Number(row.created_at_ms),
	}
}

function updateUserPasswordHash({ userId, passwordHash }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (typeof passwordHash !== 'string' || passwordHash.length < 10) throw new Error('Invalid password hash')

	run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId])
	persist()
	return true
}

function listSavingsLog(userId) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	const rows = getAll(
		'SELECT month_ms, dollars FROM savings WHERE user_id = ? ORDER BY month_ms ASC',
		[userId]
	)
	return rows.map((r) => ({ month: Number(r.month_ms), dollars: Number(r.dollars) }))
}

function upsertSavingsMonth({ userId, monthMs, dollars }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (!Number.isFinite(monthMs) || monthMs <= 0) throw new Error('Invalid month')
	if (!Number.isFinite(dollars) || dollars < 0) throw new Error('Invalid dollars')

	const now = Date.now()
	run(
		`INSERT INTO savings (user_id, month_ms, dollars, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, month_ms)
		 DO UPDATE SET dollars = excluded.dollars, updated_at_ms = excluded.updated_at_ms`,
		[userId, Math.round(monthMs), Math.round(dollars), now, now]
	)
	persist()
	return true
}

function getSavingsMonthMeta({ userId, monthMs }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (!Number.isFinite(monthMs) || monthMs <= 0) throw new Error('Invalid month')
	const row = getOne(
		'SELECT dollars, created_at_ms, updated_at_ms FROM savings WHERE user_id = ? AND month_ms = ?',
		[userId, Math.round(monthMs)]
	)
	if (!row) return null
	return {
		dollars: Number(row.dollars),
		createdAtMs: Number(row.created_at_ms),
		updatedAtMs: Number(row.updated_at_ms),
	}
}

function upsertSavingsMonthFromCloud({ userId, monthMs, dollars, createdAtMs, updatedAtMs }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (!Number.isFinite(monthMs) || monthMs <= 0) throw new Error('Invalid month')
	if (!Number.isFinite(dollars) || dollars < 0) throw new Error('Invalid dollars')
	if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) throw new Error('Invalid updatedAtMs')
	const safeCreated = Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : updatedAtMs

	run(
		`INSERT INTO savings (user_id, month_ms, dollars, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, month_ms)
		 DO UPDATE SET dollars = excluded.dollars, updated_at_ms = excluded.updated_at_ms`,
		[
			userId,
			Math.round(monthMs),
			Math.round(dollars),
			Math.round(safeCreated),
			Math.round(updatedAtMs),
		]
	)
	persist()
	return true
}

function getUserGoalMeta(userId) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	const row = getOne(
		'SELECT goal_dollars, created_at_ms, updated_at_ms FROM user_profile WHERE user_id = ?',
		[userId]
	)
	if (!row) return null
	return {
		goalDollars: Number(row.goal_dollars),
		createdAtMs: Number(row.created_at_ms),
		updatedAtMs: Number(row.updated_at_ms),
	}
}

function upsertUserGoal({ userId, goalDollars }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (!Number.isFinite(goalDollars) || goalDollars < 0) throw new Error('Invalid goal')

	const now = Date.now()
	run(
		`INSERT INTO user_profile (user_id, goal_dollars, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id)
		 DO UPDATE SET goal_dollars = excluded.goal_dollars, updated_at_ms = excluded.updated_at_ms`,
		[userId, Math.round(goalDollars), now, now]
	)
	persist()
	return true
}

function upsertUserGoalFromCloud({ userId, goalDollars, createdAtMs, updatedAtMs }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (!Number.isFinite(goalDollars) || goalDollars < 0) throw new Error('Invalid goal')
	if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) throw new Error('Invalid updatedAtMs')
	const safeCreated = Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : updatedAtMs

	run(
		`INSERT INTO user_profile (user_id, goal_dollars, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id)
		 DO UPDATE SET goal_dollars = excluded.goal_dollars, updated_at_ms = excluded.updated_at_ms`,
		[userId, Math.round(goalDollars), Math.round(safeCreated), Math.round(updatedAtMs)]
	)
	persist()
	return true
}

function listLedgerEntries(userId) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	const rows = getAll(
		"SELECT id, COALESCE(client_id, 'legacy-' || id) AS client_id, day_ms, income_dollars, expenses_dollars, savings_dollars FROM ledger_entries WHERE user_id = ? ORDER BY day_ms ASC, id ASC",
		[userId]
	)
	return rows.map((r) => ({
		id: Number(r.id),
		clientId: String(r.client_id),
		dayMs: Number(r.day_ms),
		incomeDollars: Number(r.income_dollars),
		expensesDollars: Number(r.expenses_dollars),
		savingsDollars: Number(r.savings_dollars),
	}))
}

function addLedgerEntry({ userId, clientId, dayMs, incomeDollars, expensesDollars, savingsDollars, createdAtMs, updatedAtMs }) {
	if (!Number.isFinite(userId)) throw new Error('Invalid user id')
	if (!Number.isFinite(dayMs) || dayMs <= 0) throw new Error('Invalid day')
	const income = Number(incomeDollars)
	const expenses = Number(expensesDollars)
	const savings = Number(savingsDollars)
	if (!Number.isFinite(income) || income < 0) throw new Error('Invalid income')
	if (!Number.isFinite(expenses) || expenses < 0) throw new Error('Invalid expenses')
	if (!Number.isFinite(savings) || savings < 0) throw new Error('Invalid savings')
	const safeClientId = typeof clientId === 'string' ? clientId.trim() : ''

	const now = Date.now()
	const safeUpdated = Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? Math.round(updatedAtMs) : now
	const safeCreated = Number.isFinite(createdAtMs) && createdAtMs > 0 ? Math.round(createdAtMs) : safeUpdated

	if (safeClientId) {
		run(
			`INSERT INTO ledger_entries (user_id, client_id, day_ms, income_dollars, expenses_dollars, savings_dollars, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, client_id)
			 DO UPDATE SET day_ms = excluded.day_ms, income_dollars = excluded.income_dollars, expenses_dollars = excluded.expenses_dollars, savings_dollars = excluded.savings_dollars, updated_at_ms = excluded.updated_at_ms`,
			[
				userId,
				safeClientId,
				Math.round(dayMs),
				Math.round(income),
				Math.round(expenses),
				Math.round(savings),
				safeCreated,
				safeUpdated,
			]
		)
		persist()
		const row = getOne('SELECT id FROM ledger_entries WHERE user_id = ? AND client_id = ? LIMIT 1', [userId, safeClientId])
		return { id: row ? Number(row.id) : 0 }
	}

	run(
		`INSERT INTO ledger_entries (user_id, day_ms, income_dollars, expenses_dollars, savings_dollars, created_at_ms, updated_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			userId,
			Math.round(dayMs),
			Math.round(income),
			Math.round(expenses),
			Math.round(savings),
			safeCreated,
			safeUpdated,
		]
	)
	persist()
	const row = getOne('SELECT id FROM ledger_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId])
	return { id: row ? Number(row.id) : 0 }
}

module.exports = {
	initDb,
	createUser,
	getUserByEmail,
	updateUserPasswordHash,
	listSavingsLog,
	upsertSavingsMonth,
	getSavingsMonthMeta,
	upsertSavingsMonthFromCloud,
	getUserGoalMeta,
	upsertUserGoal,
	upsertUserGoalFromCloud,
	listLedgerEntries,
	addLedgerEntry,
	normalizeEmail,
}
