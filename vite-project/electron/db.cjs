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

		CREATE INDEX IF NOT EXISTS idx_savings_user_month ON savings(user_id, month_ms);
	`)
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

module.exports = {
	initDb,
	createUser,
	getUserByEmail,
	listSavingsLog,
	upsertSavingsMonth,
	normalizeEmail,
}
