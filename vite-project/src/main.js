import './style.css'
import heroLogoUrl from './assets/frepro.png'

const MIN = 0
const MAX = 140
const DOLLARS_PER_UNIT = 1000

const app = document.querySelector('#app')
if (!app) {
	throw new Error('Missing #app element')
}

const desktop = /** @type {any} */ (globalThis?.desktop)
const isDesktopApp = Boolean(desktop?.auth?.login && desktop?.profile?.getGoal && desktop?.ledger?.listEntries)

const DEFAULT_API_BASE_URL = 'https://1wos40ydh1.execute-api.us-east-2.amazonaws.com'
const API_BASE_URL = (import.meta?.env?.VITE_API_BASE_URL || '').trim() || (import.meta.env.DEV ? '/api' : DEFAULT_API_BASE_URL)
const WEB_SESSION_KEY = 'freedom-program:web-session:v1'

/** @type {null | { id: number, name?: string, email: string, token?: string, cloudUserId?: string }} */
let session = null
let authMode = 'login'
let isProfileEditorOpen = false

app.innerHTML = `
	<div class="shell">
		<header class="topbar" aria-label="Site header">
			<div class="topbar-inner">
				<div class="topbar-brand">The Freedom Program</div>
				<nav class="topbar-nav" aria-label="Primary">
					<a class="topbar-link" href="#dashboard">Dashboard</a>
					<a class="topbar-link" href="#details">Details</a>
				</nav>
			</div>
		</header>

		<section class="hero" id="home" aria-label="Homepage hero">
			<div class="hero-inner">
				<div class="hero-brand" aria-label="Freedom Program">
					<img class="hero-logo" id="heroLogo" src="${heroLogoUrl}" alt="Freedom Program logo" hidden />
					<div class="mark" id="heroMark" aria-hidden="true">
						<div class="mark-rays"></div>
						<div class="mark-core"></div>
					</div>
				</div>
			</div>
		</section>

		<section class="panel" id="dashboard" aria-label="Dashboard">
			<h2>Dashboard</h2>
			<div class="auth" id="authWrap" aria-label="Account">
				<div class="auth-row">
					<div class="auth-status" id="authStatus">Not logged in</div>
					<button class="auth-btn" id="logoutBtn" type="button" hidden>Log out</button>
				</div>
				<div class="auth-mode" id="authModeSwitch" aria-label="Account mode">
					<button class="auth-mode-btn auth-mode-btn--active" id="authModeLoginBtn" type="button">Log in</button>
					<button class="auth-mode-btn" id="authModeRegisterBtn" type="button">Create account</button>
				</div>
				<div class="auth-hint" id="authHint">Use your email and password to log in.</div>
				<div class="auth-profile-summary" id="profileSummary" hidden>
					<div class="auth-profile-copy">
						<div class="auth-profile-label">Name</div>
						<div class="auth-profile-value" id="profileCurrentName">No name set</div>
					</div>
					<button class="auth-btn auth-btn--secondary" id="profileEditBtn" type="button">Edit name</button>
				</div>
				<form class="auth-profile" id="profileForm" hidden>
					<label class="auth-label auth-label--wide">
						<span>Name</span>
						<input id="profileName" class="auth-input" type="text" autocomplete="name" maxlength="120" />
					</label>
					<div class="auth-actions">
						<button class="auth-btn auth-btn--secondary" id="profileSaveBtn" type="submit">Save name</button>
						<button class="auth-btn auth-btn--ghost" id="profileCancelBtn" type="button">Cancel</button>
					</div>
					<div class="auth-error" id="profileError" role="status" aria-live="polite" hidden></div>
				</form>
				<form class="auth-form" id="authForm" autocomplete="on">
					<label class="auth-label" id="authNameField" hidden>
						<span>Name</span>
						<input id="authName" class="auth-input" type="text" autocomplete="name" maxlength="120" />
					</label>
					<label class="auth-label">
						<span>Email</span>
						<input id="authEmail" class="auth-input" type="email" autocomplete="username" inputmode="email" />
					</label>
					<label class="auth-label">
						<span>Password</span>
						<input id="authPassword" class="auth-input" type="password" autocomplete="current-password" />
					</label>
					<div class="auth-actions">
						<button class="auth-btn" id="loginBtn" type="submit">Log in</button>
						<button class="auth-btn auth-btn--secondary" id="registerBtn" type="button">Create account instead</button>
					</div>
					<div class="auth-error" id="authError" role="status" aria-live="polite" hidden></div>
				</form>
			</div>

			<div class="dashboard-gate" id="dashboardGate" role="status" aria-live="polite">
				Log in to view your summaries and goal progress.
			</div>

			<div id="dashboardContent" hidden>
				<div class="summary" aria-label="Expense and savings summaries">
					<div class="summary-grid">
						<div class="metric" aria-label="Weekly savings">
							<div class="metric-label">Weekly Savings</div>
							<div class="metric-value" id="weeklySavings">$0</div>
						</div>
						<div class="metric" aria-label="Weekly expenses">
							<div class="metric-label">Weekly Expenses</div>
							<div class="metric-value" id="weeklyExpenses">$0</div>
						</div>
						<div class="metric" aria-label="Monthly savings">
							<div class="metric-label">Monthly Savings</div>
							<div class="metric-value" id="monthlySavings">$0</div>
						</div>
						<div class="metric" aria-label="Monthly expenses">
							<div class="metric-label">Monthly Expenses</div>
							<div class="metric-value" id="monthlyExpenses">$0</div>
						</div>
						<div class="metric" aria-label="Yearly savings">
							<div class="metric-label">Yearly Savings</div>
							<div class="metric-value" id="yearlySavings">$0</div>
						</div>
						<div class="metric" aria-label="Yearly expenses">
							<div class="metric-label">Yearly Expenses</div>
							<div class="metric-value" id="yearlyExpenses">$0</div>
						</div>
					</div>
				</div>

			<div class="readout" aria-label="Savings goal readout">
				<span class="readout-label">Savings Goal</span>
				<output class="readout-value" id="rocketValue" for="rocketRange">$0</output>
				<span class="readout-max">Max $${(MAX * DOLLARS_PER_UNIT).toLocaleString()}</span>
			</div>

			<div class="sliderWrap">
				<div class="rocket" id="rocket" aria-hidden="true">🚀</div>
				<input
					id="rocketRange"
					class="range"
					type="range"
					min="${MIN}"
					max="${MAX}"
					step="1"
					value="${MIN}"
					aria-label="Target savings slider from $0 to $${(MAX * DOLLARS_PER_UNIT).toLocaleString()}"
				/>
				<div class="minmax" aria-hidden="true">
					<span>${MIN}</span>
					<span>${MAX}</span>
				</div>
			</div>

			<div class="progress" aria-label="Progress toward goal">
				<div class="bar" aria-label="Bar graph of current savings compared to 4-year goal">
					<div class="bar-track" role="img" aria-label="Current savings as a percentage of your 4-year goal">
						<div class="bar-fill" id="goalBarFill" style="width: 0%"></div>
					</div>
					<div class="bar-meta" aria-hidden="true">
						<span class="bar-current" id="barCurrent">Current: $0</span>
						<span class="bar-goal" id="barGoal">Goal: $0</span>
					</div>
				</div>
			</div>
			</div>
		</section>


		<section class="panel" id="details" aria-label="Income, expenses, and savings details" hidden>
			<h2>Details</h2>
			<div class="details-toolbar" aria-label="Period controls">
				<label class="auth-label">
					<span>View</span>
					<select id="detailKind" class="auth-input" aria-label="Select period">
						<option value="week">Week</option>
						<option value="month">Month</option>
						<option value="year">Year</option>
					</select>
				</label>
				<label class="auth-label">
					<span>Date</span>
					<input id="detailDate" class="auth-input" type="date" aria-label="Select a date" />
				</label>
				<div class="details-nav" aria-label="Navigate periods">
					<button class="auth-btn auth-btn--secondary" id="detailPrev" type="button">Prev</button>
					<button class="auth-btn auth-btn--secondary" id="detailNext" type="button">Next</button>
				</div>
			</div>

			<div class="summary" aria-label="Selected period totals">
				<div class="summary-grid">
					<div class="metric" aria-label="Total income">
						<div class="metric-label">Income</div>
						<div class="metric-value" id="detailIncomeTotal">$0</div>
					</div>
					<div class="metric" aria-label="Total expenses">
						<div class="metric-label">Expenses</div>
						<div class="metric-value" id="detailExpensesTotal">$0</div>
					</div>
					<div class="metric" aria-label="Total savings">
						<div class="metric-label">Savings</div>
						<div class="metric-value" id="detailSavingsTotal">$0</div>
					</div>
				</div>
			</div>

			<div class="chart" aria-label="Income, expenses, and savings chart">
				<canvas
					id="detailChart"
					class="chart-canvas"
					role="img"
					aria-label="Line graph of income, expenses, and savings"
				></canvas>
				<div id="detailTooltip" class="chart-tooltip" role="status" aria-live="polite" hidden></div>
				<div class="chart-meta" aria-hidden="true">
					<span>Income · Expenses · Savings</span>
					<span id="detailRange"></span>
				</div>
			</div>

			<form class="details-entry" id="entryForm" aria-label="Add income, expenses, and savings">
				<label class="auth-label">
					<span>Entry date</span>
					<input id="entryDate" class="auth-input" type="date" aria-label="Entry date" />
				</label>
				<label class="auth-label">
					<span>Income ($)</span>
					<input id="entryIncome" class="auth-input" type="number" inputmode="numeric" min="0" step="1" value="0" aria-label="Income in dollars" />
				</label>
				<label class="auth-label">
					<span>Expenses ($)</span>
					<input id="entryExpenses" class="auth-input" type="number" inputmode="numeric" min="0" step="1" value="0" aria-label="Expenses in dollars" />
				</label>
				<label class="auth-label">
					<span>Savings ($)</span>
					<input id="entrySavings" class="auth-input" type="number" inputmode="numeric" min="0" step="1" value="0" aria-label="Savings in dollars" />
				</label>
				<div class="auth-actions">
					<button class="auth-btn" id="entryAddBtn" type="submit">Add entry</button>
				</div>
				<div class="auth-error" id="entryError" role="status" aria-live="polite" hidden></div>
			</form>
		</section>

		<div id="spacer" aria-hidden="true"></div>
	</div>
`

const range = /** @type {HTMLInputElement} */ (document.querySelector('#rocketRange'))
const valueOut = /** @type {HTMLOutputElement} */ (document.querySelector('#rocketValue'))
const rocket = /** @type {HTMLDivElement} */ (document.querySelector('#rocket'))

const detailChartCanvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#detailChart'))
const detailTooltip = /** @type {HTMLDivElement} */ (document.querySelector('#detailTooltip'))
const detailRange = /** @type {HTMLSpanElement} */ (document.querySelector('#detailRange'))

const detailKindSelect = /** @type {HTMLSelectElement} */ (document.querySelector('#detailKind'))
const detailDateInput = /** @type {HTMLInputElement} */ (document.querySelector('#detailDate'))
const detailPrevBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#detailPrev'))
const detailNextBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#detailNext'))

const detailIncomeTotalOut = /** @type {HTMLDivElement} */ (document.querySelector('#detailIncomeTotal'))
const detailExpensesTotalOut = /** @type {HTMLDivElement} */ (document.querySelector('#detailExpensesTotal'))
const detailSavingsTotalOut = /** @type {HTMLDivElement} */ (document.querySelector('#detailSavingsTotal'))

const entryForm = /** @type {HTMLFormElement} */ (document.querySelector('#entryForm'))
const entryDateInput = /** @type {HTMLInputElement} */ (document.querySelector('#entryDate'))
const entryIncomeInput = /** @type {HTMLInputElement} */ (document.querySelector('#entryIncome'))
const entryExpensesInput = /** @type {HTMLInputElement} */ (document.querySelector('#entryExpenses'))
const entrySavingsInput = /** @type {HTMLInputElement} */ (document.querySelector('#entrySavings'))
const entryAddBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#entryAddBtn'))
const entryError = /** @type {HTMLDivElement} */ (document.querySelector('#entryError'))

const authWrap = /** @type {HTMLDivElement} */ (document.querySelector('#authWrap'))
const authStatus = /** @type {HTMLDivElement} */ (document.querySelector('#authStatus'))
const authHint = /** @type {HTMLDivElement} */ (document.querySelector('#authHint'))
const authModeSwitch = /** @type {HTMLDivElement} */ (document.querySelector('#authModeSwitch'))
const authModeLoginBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#authModeLoginBtn'))
const authModeRegisterBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#authModeRegisterBtn'))
const profileSummary = /** @type {HTMLDivElement} */ (document.querySelector('#profileSummary'))
const profileCurrentName = /** @type {HTMLDivElement} */ (document.querySelector('#profileCurrentName'))
const profileEditBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#profileEditBtn'))
const profileForm = /** @type {HTMLFormElement} */ (document.querySelector('#profileForm'))
const profileName = /** @type {HTMLInputElement} */ (document.querySelector('#profileName'))
const profileSaveBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#profileSaveBtn'))
const profileCancelBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#profileCancelBtn'))
const profileError = /** @type {HTMLDivElement} */ (document.querySelector('#profileError'))
const authForm = /** @type {HTMLFormElement} */ (document.querySelector('#authForm'))
const authNameField = /** @type {HTMLLabelElement} */ (document.querySelector('#authNameField'))
const authName = /** @type {HTMLInputElement} */ (document.querySelector('#authName'))
const authEmail = /** @type {HTMLInputElement} */ (document.querySelector('#authEmail'))
const authPassword = /** @type {HTMLInputElement} */ (document.querySelector('#authPassword'))
const loginBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#loginBtn'))
const registerBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#registerBtn'))
const logoutBtn = /** @type {HTMLButtonElement} */ (document.querySelector('#logoutBtn'))
const authError = /** @type {HTMLDivElement} */ (document.querySelector('#authError'))

const dashboardGate = /** @type {HTMLDivElement} */ (document.querySelector('#dashboardGate'))
const dashboardContent = /** @type {HTMLDivElement} */ (document.querySelector('#dashboardContent'))

const weeklySavingsOut = /** @type {HTMLDivElement} */ (document.querySelector('#weeklySavings'))
const weeklyExpensesOut = /** @type {HTMLDivElement} */ (document.querySelector('#weeklyExpenses'))
const monthlySavingsOut = /** @type {HTMLDivElement} */ (document.querySelector('#monthlySavings'))
const monthlyExpensesOut = /** @type {HTMLDivElement} */ (document.querySelector('#monthlyExpenses'))
const yearlySavingsOut = /** @type {HTMLDivElement} */ (document.querySelector('#yearlySavings'))
const yearlyExpensesOut = /** @type {HTMLDivElement} */ (document.querySelector('#yearlyExpenses'))

const goalBarFill = /** @type {HTMLDivElement} */ (document.querySelector('#goalBarFill'))
const barCurrent = /** @type {HTMLSpanElement} */ (document.querySelector('#barCurrent'))
const barGoal = /** @type {HTMLSpanElement} */ (document.querySelector('#barGoal'))

const heroLogo = /** @type {HTMLImageElement} */ (document.querySelector('#heroLogo'))
const heroMark = /** @type {HTMLDivElement} */ (document.querySelector('#heroMark'))

const GOAL_STORAGE_KEY = 'rocket-slider:goal-dollars:v1'
const LEDGER_STORAGE_PREFIX = 'freedom-program:ledger:v1:'
const LEDGER_CLOUD_SYNC_PREFIX = 'freedom-program:ledger-cloud-sync:v1:'
const LEDGER_CLOUD_PULL_PATH = '/ledger/pull'
const LEDGER_CLOUD_UPSERT_PATH = '/ledger/upsert'
const PROGRAM_YEARS = 4

function makeClientId() {
	try {
		const cryptoObj = /** @type {any} */ (globalThis?.crypto)
		if (cryptoObj?.randomUUID) return String(cryptoObj.randomUUID())
	} catch {
		// ignore
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getLedgerCloudSyncKeyFor(userKey) {
	const normalized = String(userKey || '').trim().toLowerCase()
	return `${LEDGER_CLOUD_SYNC_PREFIX}${normalized || 'anonymous'}`
}

function getLedgerCloudSyncKey() {
	return getLedgerCloudSyncKeyFor(session?.cloudUserId || session?.email || '')
}

function loadLedgerCloudSyncState() {
	try {
		const primaryKey = getLedgerCloudSyncKey()
		let raw = localStorage.getItem(primaryKey)

		// Migration: older desktop sessions didn’t have `cloudUserId`, so the key
		// would have been based on `email`. If we now have a cloudUserId key but
		// it doesn't exist yet, carry over the legacy state.
		const legacyEmailKey = session?.cloudUserId && session?.email ? getLedgerCloudSyncKeyFor(session.email) : ''
		if (!raw && legacyEmailKey && legacyEmailKey !== primaryKey) {
			const legacyRaw = localStorage.getItem(legacyEmailKey)
			if (legacyRaw) {
				raw = legacyRaw
				try {
					localStorage.setItem(primaryKey, legacyRaw)
					localStorage.removeItem(legacyEmailKey)
				} catch {
					// ignore
				}
			}
		}

		if (!raw) return { pendingClientIds: [], lastPullMs: 0 }

		const parsed = JSON.parse(raw)
		const pending = Array.isArray(parsed?.pendingClientIds) ? parsed.pendingClientIds.filter((x) => typeof x === 'string' && x.trim()) : []
		const lastPullMs = Number(parsed?.lastPullMs)
		return {
			pendingClientIds: [...new Set(pending)],
			lastPullMs: Number.isFinite(lastPullMs) && lastPullMs > 0 ? lastPullMs : 0,
		}
	} catch {
		return { pendingClientIds: [], lastPullMs: 0 }
	}
}

function saveLedgerCloudSyncState(state) {
	try {
		localStorage.setItem(getLedgerCloudSyncKey(), JSON.stringify(state))
	} catch {
		// ignore
	}
}

function enqueueLedgerForCloudSync(clientId) {
	if (!clientId) return
	const state = loadLedgerCloudSyncState()
	if (!state.pendingClientIds.includes(clientId)) {
		state.pendingClientIds.push(clientId)
		saveLedgerCloudSyncState(state)
	}
}

function dequeueLedgerCloudSync(clientId) {
	if (!clientId) return
	const state = loadLedgerCloudSyncState()
	const next = state.pendingClientIds.filter((x) => x !== clientId)
	if (next.length === state.pendingClientIds.length) return
	state.pendingClientIds = next
	saveLedgerCloudSyncState(state)
}

function startOfLocalDayMs(date) {
	const d = new Date(date)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

function isoDateValue(ms) {
	const d = new Date(ms)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

function parseDateInputToDayMs(value) {
	const raw = String(value || '').trim()
	if (!raw) return startOfLocalDayMs(new Date())
	const [y, m, d] = raw.split('-').map((x) => Number(x))
	if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return startOfLocalDayMs(new Date())
	return startOfLocalDayMs(new Date(y, m - 1, d))
}

function getLedgerStorageKey() {
	const email = String(session?.email || '').trim().toLowerCase()
	return `${LEDGER_STORAGE_PREFIX}${email || 'anonymous'}`
}

function loadLedgerFromLocalStorage() {
	try {
		const raw = localStorage.getItem(getLedgerStorageKey())
		if (!raw) return []
		const data = JSON.parse(raw)
		if (!Array.isArray(data)) return []

		let changed = false
		const cleaned = data
			.map((e) => {
				let clientId = typeof e?.clientId === 'string' ? e.clientId.trim() : ''
				if (!clientId) {
					clientId = makeClientId()
					changed = true
				}
				return {
					id: e?.id ?? clientId,
					clientId,
					dayMs: Number(e?.dayMs),
					incomeDollars: Number(e?.incomeDollars) || 0,
					expensesDollars: Number(e?.expensesDollars) || 0,
					savingsDollars: Number(e?.savingsDollars) || 0,
				}
			})
			.filter((e) => Number.isFinite(e.dayMs) && e.dayMs > 0)
			.sort((a, b) => a.dayMs - b.dayMs)

		if (changed) {
			ledgerEntries = cleaned
			saveLedgerToLocalStorage()
		}
		return cleaned
	} catch {
		return []
	}
}

function saveLedgerToLocalStorage() {
	try {
		localStorage.setItem(getLedgerStorageKey(), JSON.stringify(ledgerEntries))
	} catch {
		// ignore
	}
}

async function loadLedgerEntriesFromDesktop() {
	if (!isDesktopApp) return
	if (!session) {
		ledgerEntries = []
		return
	}
	try {
		const rows = await desktop.ledger.listEntries()
		ledgerEntries = Array.isArray(rows)
			? rows
				.map((r) => ({
					id: r?.id ?? 0,
					clientId: typeof r?.clientId === 'string' ? r.clientId : `legacy-${r?.id ?? 0}`,
					dayMs: Number(r?.dayMs),
					incomeDollars: Number(r?.incomeDollars) || 0,
					expensesDollars: Number(r?.expensesDollars) || 0,
					savingsDollars: Number(r?.savingsDollars) || 0,
				}))
				.filter((e) => Number.isFinite(e.dayMs) && e.dayMs > 0)
				.sort((a, b) => a.dayMs - b.dayMs)
			: []
	} catch {
		ledgerEntries = []
	}
}

async function loadLedgerEntriesFromStorage() {
	if (!session) {
		ledgerEntries = []
		return
	}
	if (isDesktopApp) {
		await loadLedgerEntriesFromDesktop()
		return
	}
	ledgerEntries = loadLedgerFromLocalStorage()
}

function upsertLedgerEntryInMemory(entry) {
	if (!entry?.clientId) return
	const idx = ledgerEntries.findIndex((e) => e.clientId === entry.clientId)
	if (idx >= 0) ledgerEntries[idx] = { ...ledgerEntries[idx], ...entry }
	else ledgerEntries.push(entry)
	ledgerEntries.sort((a, b) => a.dayMs - b.dayMs)
}

async function upsertLedgerEntryLocally(entry) {
	if (!session) return
	if (!entry?.clientId) return

	if (isDesktopApp) {
		try {
			const out = await desktop.ledger.addEntry({
				clientId: entry.clientId,
				dayMs: entry.dayMs,
				incomeDollars: entry.incomeDollars,
				expensesDollars: entry.expensesDollars,
				savingsDollars: entry.savingsDollars,
				createdAtMs: entry.createdAtMs,
				updatedAtMs: entry.updatedAtMs,
			})
			const id = Number(out?.id)
			upsertLedgerEntryInMemory({ ...entry, id: Number.isFinite(id) && id > 0 ? id : entry.id })
		} catch {
			// ignore
		}
		return
	}

	upsertLedgerEntryInMemory(entry)
	saveLedgerToLocalStorage()
}

async function cloudLedgerPull({ token, sinceMs }) {
	return apiJson({ method: 'GET', apiPath: LEDGER_CLOUD_PULL_PATH, token, query: { sinceMs } })
}

async function cloudLedgerUpsert({ token, entry }) {
	return apiJson({
		method: 'POST',
		apiPath: LEDGER_CLOUD_UPSERT_PATH,
		token,
		body: {
			clientId: entry.clientId,
			dayMs: entry.dayMs,
			incomeDollars: entry.incomeDollars,
			expensesDollars: entry.expensesDollars,
			savingsDollars: entry.savingsDollars,
			createdAtMs: entry.createdAtMs,
			updatedAtMs: entry.updatedAtMs,
		},
	})
}

let ledgerCloudSyncInFlight = false
async function syncLedgerWithCloud() {
	if (!session?.token) return
	if (!session) return
	if (ledgerCloudSyncInFlight) return
	ledgerCloudSyncInFlight = true

	try {
		const state = loadLedgerCloudSyncState()
		let maxSeen = state.lastPullMs || 0

		try {
			const out = await cloudLedgerPull({ token: session.token, sinceMs: state.lastPullMs || 0 })
			const items = Array.isArray(out?.items) ? out.items : []
			for (const item of items) {
				const clientId = typeof item?.clientId === 'string' ? item.clientId.trim() : ''
				const dayMs = Number(item?.dayMs)
				const incomeDollars = Math.max(0, Math.round(Number(item?.incomeDollars) || 0))
				const expensesDollars = Math.max(0, Math.round(Number(item?.expensesDollars) || 0))
				const savingsDollars = Math.max(0, Math.round(Number(item?.savingsDollars) || 0))
				const updatedAtMs = Number(item?.updatedAtMs)
				const createdAtMs = Number(item?.createdAtMs)

				if (!clientId) continue
				if (!Number.isFinite(dayMs) || dayMs <= 0) continue
				if (Number.isFinite(updatedAtMs) && updatedAtMs > maxSeen) maxSeen = updatedAtMs
				await upsertLedgerEntryLocally({
					id: clientId,
					clientId,
					dayMs: Math.round(dayMs),
					incomeDollars,
					expensesDollars,
					savingsDollars,
					createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? Math.round(createdAtMs) : undefined,
					updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? Math.round(updatedAtMs) : undefined,
				})
			}
		} catch (err) {
			warnWebSyncIfNeeded(err)
		}

		state.lastPullMs = maxSeen

		// Push pending local entries (cloud backup)
		const pending = Array.isArray(state.pendingClientIds) ? state.pendingClientIds.slice() : []
		/** @type {string[]} */
		const stillPending = []
		for (const clientId of pending) {
			const entry = ledgerEntries.find((e) => e.clientId === clientId)
			if (!entry) continue
			try {
				await cloudLedgerUpsert({ token: session.token, entry })
			} catch (err) {
				warnWebSyncIfNeeded(err)
				stillPending.push(clientId)
			}
		}
		state.pendingClientIds = stillPending
		saveLedgerCloudSyncState(state)
	} finally {
		ledgerCloudSyncInFlight = false
	}
}

async function addLedgerEntry({ dayMs, incomeDollars, expensesDollars, savingsDollars }) {
	if (!session) throw new Error('Not logged in')
	const now = Date.now()
	const entry = {
		id: '',
		clientId: makeClientId(),
		dayMs: Math.round(Number(dayMs)),
		incomeDollars: Math.max(0, Math.round(Number(incomeDollars) || 0)),
		expensesDollars: Math.max(0, Math.round(Number(expensesDollars) || 0)),
		savingsDollars: Math.max(0, Math.round(Number(savingsDollars) || 0)),
		createdAtMs: now,
		updatedAtMs: now,
	}
	entry.id = entry.clientId
	if (!Number.isFinite(entry.dayMs) || entry.dayMs <= 0) throw new Error('Invalid date')
	if (entry.incomeDollars <= 0 && entry.expensesDollars <= 0 && entry.savingsDollars <= 0) {
		throw new Error('Enter at least one amount')
	}

	if (isDesktopApp) {
		const out = await desktop.ledger.addEntry({
			clientId: entry.clientId,
			dayMs: entry.dayMs,
			incomeDollars: entry.incomeDollars,
			expensesDollars: entry.expensesDollars,
			savingsDollars: entry.savingsDollars,
			createdAtMs: entry.createdAtMs,
			updatedAtMs: entry.updatedAtMs,
		})
		const id = Number(out?.id)
		ledgerEntries.push({ ...entry, id: Number.isFinite(id) && id > 0 ? id : entry.id })
		ledgerEntries.sort((a, b) => a.dayMs - b.dayMs)
		enqueueLedgerForCloudSync(entry.clientId)
		void syncLedgerWithCloud()
		return
	}

	ledgerEntries.push(entry)
	ledgerEntries.sort((a, b) => a.dayMs - b.dayMs)
	saveLedgerToLocalStorage()
	enqueueLedgerForCloudSync(entry.clientId)
	void syncLedgerWithCloud()
}

/** @type {null | { canvasW: number, canvasH: number, padL: number, padT: number, plotW: number, plotH: number, labels: string[], x: number[], series: Array<{ key: string, values: number[], points: Array<{ x: number, y: number, v: number }> }> }} */
let detailChartState = null

/** @type {'week' | 'month' | 'year'} */
let detailKind = 'week'

let detailAnchorDayMs = (() => {
	const d = new Date()
	d.setHours(0, 0, 0, 0)
	return d.getTime()
})()

/** @type {Array<{ id: number | string, clientId: string, dayMs: number, incomeDollars: number, expensesDollars: number, savingsDollars: number, createdAtMs?: number, updatedAtMs?: number }>} */
let ledgerEntries = []

if (authWrap) {
	authWrap.hidden = false
}

// Apply any locally saved goal immediately (web demo, or pre-login in desktop).
try {
	const savedGoalDollars = loadGoalDollarsFromLocalStorage()
	if (savedGoalDollars > 0) {
		const units = clamp(Math.round(savedGoalDollars / DOLLARS_PER_UNIT), MIN, MAX)
		range.value = String(units)
	}
} catch {
	// ignore
}
// Optional logo override: if /logo.png exists (in public/), show it.
if (heroLogo) {
	heroLogo.addEventListener('load', () => {
		heroLogo.hidden = false
		if (heroMark) heroMark.hidden = true
	})
	heroLogo.addEventListener('error', () => {
		heroLogo.hidden = true
		if (heroMark) heroMark.hidden = false
	})
}

const homeSection = /** @type {HTMLElement} */ (document.querySelector('#home'))
const dashboardSection = /** @type {HTMLElement} */ (document.querySelector('#dashboard'))
const detailsSection = /** @type {HTMLElement} */ (document.querySelector('#details'))

function normalizeRoute(hash) {
	const raw = String(hash || '').replace(/^#/, '').trim().toLowerCase()
	const allowed = new Set(['home', 'dashboard', 'details'])
	return allowed.has(raw) ? raw : 'dashboard'
}

function renderRoute() {
	const route = normalizeRoute(location.hash)
	const needsAuth = route === 'details'
	const authed = Boolean(session)
	const target = needsAuth && !authed ? 'dashboard' : route

	if (homeSection) homeSection.hidden = target !== 'home'
	if (dashboardSection) dashboardSection.hidden = target !== 'dashboard'
	if (detailsSection) detailsSection.hidden = target !== 'details'

	// Ensure charts render when navigating to details.
	if (target === 'details') drawDetails()

	// Avoid weird scroll positions when switching pages.
	try {
		window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
	} catch {
		window.scrollTo(0, 0)
	}

	const hasExplicitHash = typeof location.hash === 'string' && location.hash.length > 1
	if (!hasExplicitHash) {
		// Default route should be visible in the URL, but don't add a history entry.
		try {
			history.replaceState(null, '', `#${target}`)
		} catch {
			location.hash = `#${target}`
		}
	} else if (target !== route) {
		// Keep the URL consistent with the redirect.
		location.hash = `#${target}`
	}
}

window.addEventListener('hashchange', renderRoute)
renderRoute()

updateAuthUi()
void refreshSessionAndLoad()

function loadWebSessionFromStorage() {
	try {
		const raw = localStorage.getItem(WEB_SESSION_KEY)
		if (!raw) return null
		const data = JSON.parse(raw)
		const name = typeof data?.name === 'string' ? data.name.trim() : ''
		const email = typeof data?.email === 'string' ? data.email : ''
		const token = typeof data?.token === 'string' ? data.token : ''
		const cloudUserId = typeof data?.cloudUserId === 'string' ? data.cloudUserId : ''
		if (!email || !token) return null
		return { id: 0, name: name || undefined, email, token, cloudUserId: cloudUserId || undefined }
	} catch {
		return null
	}
}

function saveWebSessionToStorage(nextSession) {
	try {
		if (!nextSession?.token) {
			localStorage.removeItem(WEB_SESSION_KEY)
			return
		}
		localStorage.setItem(
			WEB_SESSION_KEY,
			JSON.stringify({
				name: nextSession.name,
				email: nextSession.email,
				token: nextSession.token,
				cloudUserId: nextSession.cloudUserId,
			})
		)
	} catch {
		// ignore
	}
}

function normalizePersonName(name) {
	if (typeof name !== 'string') return ''
	return name.trim().replace(/\s+/g, ' ').slice(0, 120)
}

async function apiJson({ method, apiPath, token, body, query, contentType }) {
	const base = API_BASE_URL
	const url = base.startsWith('/')
		? new URL(`${base.replace(/\/$/, '')}${apiPath}`, location.origin)
		: new URL(apiPath, base)
	if (query && typeof query === 'object') {
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined || v === null) continue
			url.searchParams.set(k, String(v))
		}
	}

	/** @type {Record<string, string>} */
	const headers = {
		'content-type': (typeof contentType === 'string' && contentType) ? contentType : 'application/json',
		'accept': 'application/json',
	}
	if (token) headers.authorization = `Bearer ${token}`

	let res
	try {
		res = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		})
	} catch (err) {
		// In browsers this is commonly thrown for CORS failures (preflight blocked),
		// DNS issues, offline mode, or the server refusing the connection.
		const hint =
			`Network error calling ${url.origin}${url.pathname}. ` +
			`If you're running in a browser (Vite/GitHub Pages), this is often a CORS issue. ` +
			`Your API must allow Origin: ${location.origin} and handle OPTIONS preflight.`
		const e = new Error(hint)
		e.cause = err
		throw e
	}

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
		const backendMsg =
			typeof data?.error === 'string'
				? data.error
				: typeof data?.message === 'string'
					? data.message
					: (typeof text === 'string' && text.trim() ? text.trim() : '')
		const msg = backendMsg || `Request failed (${res.status})`
		const err = new Error(`${msg} [${method} ${url.pathname}]`)
		err.status = res.status
		err.apiPath = apiPath
		err.responseText = typeof text === 'string' ? text.slice(0, 1000) : ''

		// If a previously saved web session token becomes invalid (common after changing
		// JWT secrets), don't silently keep the user "logged in" with stale local data.
		if (!isDesktopApp && res.status === 401 && token) {
			try {
				saveWebSessionToStorage(null)
			} catch {
				// ignore
			}
			session = null
			updateAuthUi()
			showAuthError('Session expired. Please log in again to refresh cloud data.')
		}

		// In desktop mode, ledger sync failures are otherwise silent; log details.
		if (isDesktopApp) {
			try {
				console.warn('API error', { status: res.status, method, path: url.pathname, body: err.responseText })
			} catch {
				// ignore
			}
		}
		throw err
	}

	return data
}

async function cloudRegister(email, password, name) {
	// Use a "simple" Content-Type to avoid CORS preflight in browsers when the API
	// doesn't support OPTIONS. The backend can still parse JSON from the body string.
	return apiJson({ method: 'POST', apiPath: '/auth/register', body: { email, password, name }, contentType: 'text/plain' })
}

async function cloudLogin(email, password) {
	return apiJson({ method: 'POST', apiPath: '/auth/login', body: { email, password }, contentType: 'text/plain' })
}

async function cloudGetGoal({ token }) {
	return apiJson({ method: 'GET', apiPath: '/profile/goal', token })
}

async function cloudGetProfileName({ token }) {
	return apiJson({ method: 'GET', apiPath: '/profile/name', token })
}

async function cloudSetGoal({ token, goalDollars }) {
	return apiJson({ method: 'POST', apiPath: '/profile/goal', token, body: { goalDollars } })
}

async function cloudSetProfileName({ token, name }) {
	return apiJson({ method: 'POST', apiPath: '/profile/name', token, body: { name } })
}

function formatDollarsFromUnits(units) {
	const dollars = units * DOLLARS_PER_UNIT
	return `$${dollars.toLocaleString()}`
}

function parseMoneyInput(input) {
	// Keep it forgiving: treat empty/invalid as 0.
	const n = Number(input)
	if (!Number.isFinite(n)) return 0
	return Math.max(0, n)
}

function formatDollars(dollars) {
	const safe = Math.max(0, Math.round(dollars))
	return `$${safe.toLocaleString()}`
}

function formatSignedDollars(dollars) {
	const rounded = Math.round(Number(dollars) || 0)
	const sign = rounded < 0 ? '-' : ''
	const abs = Math.abs(rounded)
	return `${sign}$${abs.toLocaleString()}`
}

function clamp(n, min, max) {
	return Math.min(max, Math.max(min, n))
}

function startOfLocalMonthMs(date) {
	return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

function addYearsMs(startMs, years) {
	const d = new Date(startMs)
	d.setFullYear(d.getFullYear() + years)
	return d.getTime()
}

function addMonthsMs(startMs, months) {
	const d = new Date(startMs)
	d.setMonth(d.getMonth() + months)
	return d.getTime()
}

function formatMonthLabel(monthMs) {
	const d = new Date(monthMs)
	const m = d.getMonth() + 1
	const yy = String(d.getFullYear()).slice(-2)
	return `${m}/${yy}`
}

function loadGoalDollarsFromLocalStorage() {
	try {
		const raw = localStorage.getItem(GOAL_STORAGE_KEY)
		if (!raw) return 0
		const n = Number(raw)
		if (!Number.isFinite(n)) return 0
		return Math.max(0, Math.round(n))
	} catch {
		return 0
	}
}

function saveGoalDollarsToLocalStorage(goalDollars) {
	try {
		localStorage.setItem(GOAL_STORAGE_KEY, String(Math.max(0, Math.round(goalDollars))))
	} catch {
		// ignore
	}
}

function showAuthError(message) {
	if (!authError) return
	authError.textContent = message
	authError.hidden = !message
}

function showProfileError(message) {
	if (!profileError) return
	profileError.textContent = message
	profileError.hidden = !message
}

function setAuthMode(mode) {
	authMode = mode === 'register' ? 'register' : 'login'
	if (!authNameField || !loginBtn || !registerBtn || !authHint || !authModeLoginBtn || !authModeRegisterBtn) return

	const isRegister = authMode === 'register'
	authNameField.hidden = !isRegister
	authHint.hidden = false
	loginBtn.textContent = isRegister ? 'Create account' : 'Log in'
	registerBtn.textContent = isRegister ? 'Back to login' : 'Create account instead'
	authHint.textContent = isRegister
		? 'Create an account with your name, email, and password.'
		: 'Use your email and password to log in.'
	authModeLoginBtn.classList.toggle('auth-mode-btn--active', !isRegister)
	authModeRegisterBtn.classList.toggle('auth-mode-btn--active', isRegister)
	authPassword.autocomplete = isRegister ? 'new-password' : 'current-password'
	showAuthError('')
}

function setProfileEditorOpen(isOpen) {
	isProfileEditorOpen = Boolean(isOpen)
	if (!profileForm || !profileSummary || !session) return
	profileForm.hidden = !isProfileEditorOpen
	profileSummary.hidden = isProfileEditorOpen
	if (isProfileEditorOpen && profileName) profileName.value = session.name || ''
	if (!isProfileEditorOpen) showProfileError('')
}

function resetGoalUi({ persistLocal }) {
	setGoalUnits(0)
	if (persistLocal) saveGoalDollarsToLocalStorage(0)
}

let didWarnWebSync = false
function warnWebSyncIfNeeded(err) {
	if (isDesktopApp) return
	if (didWarnWebSync) return
	const msg = String(err?.message || '')
	if (!msg) return
	if (!msg.toLowerCase().includes('cors')) return
	didWarnWebSync = true
	showAuthError(msg)
}

function updateAuthUi() {
	if (!authStatus || !logoutBtn || !authForm) return

	if (session) {
		const cloudStatus = isDesktopApp ? (session?.token ? ' (cloud sync ON)' : ' (cloud sync OFF)') : ''
		const identity = session.name || session.email
		authStatus.textContent = `Logged in as ${identity}${cloudStatus}`
		logoutBtn.hidden = false
		if (authModeSwitch) authModeSwitch.hidden = true
		if (authHint) {
			authHint.hidden = Boolean(session.name)
			authHint.textContent = 'Your login email stays the same. Add a name if you want it shown on your account.'
		}
		if (profileCurrentName) profileCurrentName.textContent = session.name || 'No name set'
		if (profileSummary) profileSummary.hidden = isProfileEditorOpen
		if (profileForm) profileForm.hidden = !isProfileEditorOpen
		if (profileName && document.activeElement !== profileName) profileName.value = session.name || ''
		authForm.classList.add('auth-form--hidden')
		authModeLoginBtn.hidden = true
		authModeRegisterBtn.hidden = true
		showAuthError('')
		showProfileError('')
	} else {
		authStatus.textContent = 'Not logged in'
		logoutBtn.hidden = true
		isProfileEditorOpen = false
		if (authModeSwitch) authModeSwitch.hidden = false
		if (authHint) authHint.hidden = false
		if (profileSummary) profileSummary.hidden = true
		if (profileForm) profileForm.hidden = true
		if (profileName) profileName.value = ''
		authForm.classList.remove('auth-form--hidden')
		authModeLoginBtn.hidden = false
		authModeRegisterBtn.hidden = false
		showAuthError('')
		showProfileError('')
		setAuthMode(authMode)
	}
	setDashboardAuthGate(Boolean(session))
	renderRoute()
}

async function persistProfileName(name) {
	if (!session) throw new Error('Not logged in')
	const safeName = normalizePersonName(name)

	if (isDesktopApp) {
		if (!desktop?.profile?.setName) throw new Error('Profile updates are unavailable in this build')
		const out = await desktop.profile.setName(safeName)
		const nextName = normalizePersonName(out?.name)
		session = { ...session, name: nextName || safeName || undefined }
		setProfileEditorOpen(false)
		updateAuthUi()
		return
	}

	if (!session.token) throw new Error('Cloud sync is unavailable (no AWS token)')
	const out = await cloudSetProfileName({ token: session.token, name: safeName })
	const nextName = normalizePersonName(out?.name)
	session = { ...session, name: nextName || safeName || undefined }
	saveWebSessionToStorage(session)
	setProfileEditorOpen(false)
	updateAuthUi()
}

async function hydrateProfileNameFromCloud() {
	if (!session?.token) return

	try {
		if (isDesktopApp) {
			if (!desktop?.profile?.getName) return
			const out = await desktop.profile.getName()
			const nextName = normalizePersonName(out?.name)
			if (nextName !== (session.name || '')) {
				session = { ...session, name: nextName || undefined }
				updateAuthUi()
			}
			return
		}

		const out = await cloudGetProfileName({ token: session.token })
		const nextName = normalizePersonName(out?.name)
		if (nextName !== (session.name || '')) {
			session = { ...session, name: nextName || undefined }
			saveWebSessionToStorage(session)
			updateAuthUi()
		}
	} catch {
		// ignore
	}
}

function setDashboardAuthGate(isAuthed) {
	if (dashboardGate) dashboardGate.hidden = isAuthed
	if (dashboardContent) dashboardContent.hidden = !isAuthed
}

function updateDashboardSummary({ goalDollars, currentDollars }) {
	if (!weeklySavingsOut || !monthlySavingsOut || !yearlySavingsOut) return

	const today = startOfLocalDayMs(new Date())
	const week = buildPeriodSeries('week', today).totals
	const month = buildPeriodSeries('month', today).totals
	const year = buildPeriodSeries('year', today).totals

	weeklySavingsOut.textContent = formatDollars(week.savingsDollars)
	monthlySavingsOut.textContent = formatDollars(month.savingsDollars)
	yearlySavingsOut.textContent = formatDollars(year.savingsDollars)

	if (weeklyExpensesOut) weeklyExpensesOut.textContent = formatDollars(week.expensesDollars)
	if (monthlyExpensesOut) monthlyExpensesOut.textContent = formatDollars(month.expensesDollars)
	if (yearlyExpensesOut) yearlyExpensesOut.textContent = formatDollars(year.expensesDollars)

	const pct = goalDollars > 0 ? clamp(currentDollars / goalDollars, 0, 1) : 0
	if (goalBarFill) goalBarFill.style.width = `${Math.round(pct * 1000) / 10}%`
	if (barCurrent) barCurrent.textContent = `Current: ${formatDollars(currentDollars)}`
	if (barGoal) barGoal.textContent = `Goal: ${formatDollars(goalDollars)}`
}

async function refreshSessionAndLoad() {
	if (isDesktopApp) {
		try {
			session = await desktop.auth.getSession()
		} catch {
			session = null
		}
	} else {
		session = loadWebSessionFromStorage()
	}
	updateAuthUi()
	if (isDesktopApp) {
		if (session) {
			await hydrateProfileNameFromCloud()
			await loadGoalFromDbOrMigrate()
			await loadLedgerEntriesFromStorage()
			void syncLedgerWithCloud()
		}
		updateProgress()
		renderRoute()
		return
	}

	// Web mode: if logged in, pull goal from cloud + ledger from localStorage.
	if (session?.token) {
		await hydrateProfileNameFromCloud()
		resetGoalUi({ persistLocal: false })
		await loadGoalFromCloudOrFallback()
		await loadLedgerEntriesFromStorage()
		void syncLedgerWithCloud()
	}
	updateProgress()
	renderRoute()
}

async function loadGoalFromCloudOrFallback() {
	if (!session?.token) return
	let goalDollars = 0
	try {
		const out = await cloudGetGoal({ token: session.token })
		goalDollars = Number(out?.goalDollars)
	} catch (err) {
		warnWebSyncIfNeeded(err)
		goalDollars = 0
	}
	if (!Number.isFinite(goalDollars) || goalDollars < 0) goalDollars = 0
	if (goalDollars > 0) {
		setGoalUnits(goalDollars / DOLLARS_PER_UNIT)
		saveGoalDollarsToLocalStorage(goalDollars)
		return
	}

	// No cloud goal saved yet; reset to zero so we don't keep a previous user's slider.
	resetGoalUi({ persistLocal: true })
}


let suppressGoalPersist = false
let goalTimer = null
let didWarnDesktopGoalSync = false

function setGoalUnits(units) {
	suppressGoalPersist = true
	range.value = String(clamp(Math.round(units), MIN, MAX))
	onInput()
	suppressGoalPersist = false
}

async function loadGoalFromDbOrMigrate() {
	if (!session) return
	if (!desktop?.profile?.getGoal) return

	let goalDollars = 0
	try {
		const out = await desktop.profile.getGoal()
		goalDollars = Number(out?.goalDollars)
	} catch {
		goalDollars = 0
	}

	if (!Number.isFinite(goalDollars) || goalDollars < 0) goalDollars = 0

	// If the account has no saved goal yet, seed it from localStorage (if present).
	if (goalDollars <= 0) {
		const localGoal = loadGoalDollarsFromLocalStorage()
		if (localGoal > 0) {
			goalDollars = localGoal
			try {
				await desktop.profile.setGoal(goalDollars)
			} catch {
				// ignore
			}
		}
	}

	setGoalUnits(goalDollars / DOLLARS_PER_UNIT)
	saveGoalDollarsToLocalStorage(goalDollars)
}

async function persistGoalDollars(goalDollars) {
	const safe = Math.max(0, Math.round(goalDollars))
	saveGoalDollarsToLocalStorage(safe)

	if (isDesktopApp) {
		if (!session) return
		if (!session?.token) {
			if (!didWarnDesktopGoalSync) {
				didWarnDesktopGoalSync = true
				showAuthError('Cloud sync is unavailable (no AWS token). Try logging out and logging back in.')
			}
			return
		}
		if (!desktop?.profile?.setGoal) return
		try {
			await desktop.profile.setGoal(safe)
		} catch {
			if (!didWarnDesktopGoalSync) {
				didWarnDesktopGoalSync = true
				showAuthError('Cloud sync failed while saving your goal. Check your API/Lambda logs for /profile/goal.')
			}
		}
		return
	}

	if (!session?.token) return
	try {
		await cloudSetGoal({ token: session.token, goalDollars: safe })
	} catch (err) {
		warnWebSyncIfNeeded(err)
		// ignore
	}
}

function layoutRocket() {
	const wrap = range.parentElement
	if (!wrap) return

	const value = Number(range.value)
	const percent = (value - MIN) / (MAX - MIN)

	const wrapRect = wrap.getBoundingClientRect()
	const rangeRect = range.getBoundingClientRect()
	const rocketRect = rocket.getBoundingClientRect()

	// Compute X relative to wrapper so the rocket stays fully inside.
	const available = rangeRect.width - rocketRect.width
	const x = clamp(available * percent, 0, Math.max(0, available))

	// Position rocket above the thumb/track.
	const top = rangeRect.top - wrapRect.top + rangeRect.height / 2
	rocket.style.transform = `translate3d(${x}px, ${top}px, 0) translate3d(0, -50%, 0)`
}

function startOfLocalWeekMs(date) {
	const d = new Date(date)
	const day = d.getDay() // 0=Sun ... 6=Sat
	const diff = (day + 6) % 7 // Monday=0
	d.setDate(d.getDate() - diff)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

function formatShortDate(ms) {
	const d = new Date(ms)
	return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

function formatYear(ms) {
	return String(new Date(ms).getFullYear())
}

const DAY_MS = 24 * 60 * 60 * 1000

function fourYearWindowStartDayMs() {
	const now = new Date()
	const start = new Date(now.getFullYear() - PROGRAM_YEARS, now.getMonth(), now.getDate())
	return startOfLocalDayMs(start)
}

function sumLedgerSavingsSince(startDayMs) {
	const start = Number(startDayMs)
	if (!Number.isFinite(start)) return 0
	let total = 0
	for (const e of ledgerEntries) {
		const dayMs = Number(e?.dayMs)
		if (!Number.isFinite(dayMs) || dayMs < start) continue
		total += Math.max(0, Number(e?.savingsDollars) || 0)
	}
	return total
}

function getCurrentSavingsForGoalProgress() {
	if (!session) return 0
	return sumLedgerSavingsSince(fourYearWindowStartDayMs())
}

function getPeriodBounds(kind, anchorDayMs) {
	const anchor = startOfLocalDayMs(new Date(anchorDayMs))
	if (kind === 'week') {
		const startMs = startOfLocalWeekMs(new Date(anchor))
		const endMs = startMs + 7 * DAY_MS
		return {
			startMs,
			endMs,
			rangeText: `${formatShortDate(startMs)} – ${formatShortDate(endMs - DAY_MS)}`,
		}
	}
	if (kind === 'year') {
		const y = new Date(anchor).getFullYear()
		const startMs = startOfLocalDayMs(new Date(y, 0, 1))
		const endMs = startOfLocalDayMs(new Date(y + 1, 0, 1))
		return { startMs, endMs, rangeText: String(y) }
	}
	// month
	const startMs = startOfLocalMonthMs(new Date(anchor))
	const endMs = addMonthsMs(startMs, 1)
	return { startMs, endMs, rangeText: formatMonthLabel(startMs) }
}

function shiftAnchor(kind, anchorDayMs, delta) {
	const d = new Date(startOfLocalDayMs(new Date(anchorDayMs)))
	if (kind === 'week') d.setDate(d.getDate() + delta * 7)
	else if (kind === 'month') d.setMonth(d.getMonth() + delta)
	else d.setFullYear(d.getFullYear() + delta)
	return startOfLocalDayMs(d)
}

function buildPeriodSeries(kind, anchorDayMs) {
	const { startMs, endMs, rangeText } = getPeriodBounds(kind, anchorDayMs)

	/** @type {string[]} */
	let labels = []
	let buckets = 0

	if (kind === 'week') {
		buckets = 7
		labels = new Array(7).fill(0).map((_, i) => formatShortDate(startMs + i * DAY_MS))
	} else if (kind === 'year') {
		buckets = 12
		labels = new Array(12).fill(0).map((_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'short' }))
	} else {
		const d = new Date(startMs)
		const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() || 30
		buckets = daysInMonth
		labels = new Array(daysInMonth).fill(0).map((_, i) => String(i + 1))
	}

	const income = new Array(buckets).fill(0)
	const expenses = new Array(buckets).fill(0)
	const savings = new Array(buckets).fill(0)

	for (const e of ledgerEntries) {
		const dayMs = Number(e?.dayMs)
		if (!Number.isFinite(dayMs)) continue
		if (dayMs < startMs || dayMs >= endMs) continue
		let idx = 0
		if (kind === 'year') {
			idx = new Date(dayMs).getMonth()
		} else {
			idx = Math.floor((dayMs - startMs) / DAY_MS)
		}
		if (idx < 0 || idx >= buckets) continue
		income[idx] += Math.max(0, Number(e?.incomeDollars) || 0)
		expenses[idx] += Math.max(0, Number(e?.expensesDollars) || 0)
		savings[idx] += Math.max(0, Number(e?.savingsDollars) || 0)
	}

	const totals = {
		incomeDollars: income.reduce((a, b) => a + b, 0),
		expensesDollars: expenses.reduce((a, b) => a + b, 0),
		savingsDollars: savings.reduce((a, b) => a + b, 0),
	}

	return {
		labels,
		rangeText,
		totals,
		series: [
			{ key: 'income', values: income },
			{ key: 'expenses', values: expenses },
			{ key: 'savings', values: savings },
		],
	}
}

function drawDetailChart(kind, canvas, tooltip, rangeOut) {
	if (!canvas) return
	const ctx = canvas.getContext('2d')
	if (!ctx) return

	const rect = canvas.getBoundingClientRect()
	if (rect.width <= 0 || rect.height <= 0) return

	const dpr = Math.max(1, window.devicePixelRatio || 1)
	const width = Math.round(rect.width * dpr)
	const height = Math.round(rect.height * dpr)
	if (canvas.width !== width) canvas.width = width
	if (canvas.height !== height) canvas.height = height

	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.scale(dpr, dpr)

	const w = rect.width
	const h = rect.height
	ctx.clearRect(0, 0, w, h)

	const padL = 44
	const padR = 14
	const padT = 12
	const padB = 26
	const plotW = Math.max(1, w - padL - padR)
	const plotH = Math.max(1, h - padT - padB)

	const rootStyle = getComputedStyle(document.documentElement)
	const accent = rootStyle.getPropertyValue('--accent').trim() || '#f97316'
	const axis = rootStyle.getPropertyValue('--border').trim() || 'rgba(15, 23, 42, 0.22)'
	const text = rootStyle.getPropertyValue('--text').trim() || 'rgba(15, 23, 42, 0.65)'
	const textH = rootStyle.getPropertyValue('--text-h').trim() || 'rgba(15, 23, 42, 0.85)'

	const { labels, series, rangeText } = buildPeriodSeries(kind, detailAnchorDayMs)
	if (rangeOut) rangeOut.textContent = rangeText

	const allValues = []
	for (const s of series) for (const v of s.values) allValues.push(Number(v) || 0)
	const minV = Math.min(0, ...allValues)
	const maxV = Math.max(0, ...allValues)
	const span = Math.max(1, maxV - minV)

	const yFor = (v) => {
		const pct = (v - minV) / span
		return padT + (1 - clamp(pct, 0, 1)) * plotH
	}
	const xForIndex = (i) => {
		const pct = labels.length <= 1 ? 0 : i / (labels.length - 1)
		return padL + clamp(pct, 0, 1) * plotW
	}

	/** @type {number[]} */
	const x = labels.map((_, i) => xForIndex(i))

	// Axes
	ctx.strokeStyle = axis
	ctx.lineWidth = 1
	ctx.beginPath()
	ctx.moveTo(padL, padT)
	ctx.lineTo(padL, padT + plotH)
	ctx.lineTo(padL + plotW, padT + plotH)
	ctx.stroke()

	// Zero line
	const y0 = yFor(0)
	ctx.save()
	ctx.globalAlpha = 0.45
	ctx.setLineDash([6, 6])
	ctx.beginPath()
	ctx.moveTo(padL, y0)
	ctx.lineTo(padL + plotW, y0)
	ctx.stroke()
	ctx.restore()

	// Series styles
	/** @type {Record<string, { stroke: string, dash: number[], alpha: number, width: number }>} */
	const styleByKey = {
		income: { stroke: textH, dash: [6, 6], alpha: 0.9, width: 2 },
		expenses: { stroke: text, dash: [2, 6], alpha: 0.9, width: 2 },
		savings: { stroke: accent, dash: [], alpha: 1, width: 2.5 },
	}

	/** @type {Array<{ key: string, values: number[], points: Array<{ x: number, y: number, v: number }> }>} */
	const seriesWithPoints = []
	for (const s of series) {
		const values = s.values.map((v) => Number(v) || 0)
		const points = values.map((v, i) => ({ x: x[i], y: yFor(v), v }))
		seriesWithPoints.push({ key: s.key, values, points })

		const st = styleByKey[s.key] || styleByKey.savings
		ctx.save()
		ctx.globalAlpha = st.alpha
		ctx.strokeStyle = st.stroke
		ctx.lineWidth = st.width
		ctx.lineJoin = 'round'
		ctx.lineCap = 'round'
		ctx.setLineDash(st.dash)
		ctx.beginPath()
		for (let i = 0; i < points.length; i++) {
			const p = points[i]
			if (i === 0) ctx.moveTo(p.x, p.y)
			else ctx.lineTo(p.x, p.y)
		}
		ctx.stroke()
		ctx.restore()
	}

	// X ticks (keep it sparse)
	ctx.fillStyle = text
	ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
	ctx.textBaseline = 'alphabetic'
	const baselineY = padT + plotH
	const maxTicks = 6
	const step = Math.max(1, Math.ceil(labels.length / maxTicks))
	for (let i = 0; i < labels.length; i += step) {
		const xi = x[i]
		ctx.strokeStyle = axis
		ctx.lineWidth = 1
		ctx.beginPath()
		ctx.moveTo(xi, baselineY)
		ctx.lineTo(xi, baselineY + 5)
		ctx.stroke()

		ctx.textAlign = i === 0 ? 'left' : (i + step >= labels.length ? 'right' : 'center')
		ctx.fillText(labels[i], xi, baselineY + 18)
	}

	// Y labels (min/0/max)
	ctx.textAlign = 'right'
	ctx.fillStyle = text
	ctx.fillText(formatSignedDollars(minV), padL - 8, yFor(minV) + 4)
	ctx.fillStyle = textH
	ctx.fillText('$0', padL - 8, y0 + 4)
	ctx.fillStyle = text
	ctx.fillText(formatSignedDollars(maxV), padL - 8, yFor(maxV) + 4)

	detailChartState = {
		canvasW: w,
		canvasH: h,
		padL,
		padT,
		plotW,
		plotH,
		labels,
		x,
		series: seriesWithPoints,
	}
}

function hideDetailTooltip(tooltip) {
	if (!tooltip) return
	tooltip.hidden = true
}

function onDetailPointerMove(canvas, tooltip, e) {
	if (!canvas || !tooltip) return
	const state = detailChartState
	if (!state || state.labels.length === 0) {
		hideDetailTooltip(tooltip)
		return
	}

	const r = canvas.getBoundingClientRect()
	const x = e.clientX - r.left
	const y = e.clientY - r.top
	if (x < 0 || y < 0 || x > r.width || y > r.height) {
		hideDetailTooltip(tooltip)
		return
	}

	let bestI = 0
	let bestDist = Infinity
	for (let i = 0; i < state.x.length; i++) {
		const d = Math.abs(state.x[i] - x)
		if (d < bestDist) {
			bestDist = d
			bestI = i
		}
	}

	const label = state.labels[bestI] || ''
	const income = state.series.find((s) => s.key === 'income')?.values[bestI] ?? 0
	const expenses = state.series.find((s) => s.key === 'expenses')?.values[bestI] ?? 0
	const savings = state.series.find((s) => s.key === 'savings')?.values[bestI] ?? 0
	tooltip.textContent = `${label} — Income ${formatDollars(income)} · Expenses ${formatDollars(expenses)} · Savings ${formatDollars(savings)}`

	// Anchor tooltip near the savings point.
	const savingsPoint = state.series.find((s) => s.key === 'savings')?.points[bestI]
	const anchorX = savingsPoint ? savingsPoint.x : state.x[bestI]
	const anchorY = savingsPoint ? savingsPoint.y : (state.padT + state.plotH / 2)

	tooltip.hidden = false
	const canvasLeft = canvas.offsetLeft
	const canvasTop = canvas.offsetTop
	const tipW = tooltip.offsetWidth || 0
	const left = canvasLeft + anchorX
	const top = canvasTop + anchorY
	const minLeft = canvasLeft + tipW / 2 + 6
	const maxLeft = canvasLeft + state.canvasW - tipW / 2 - 6
	const clampedLeft = tipW > 0 ? clamp(left, minLeft, maxLeft) : left
	tooltip.style.left = `${clampedLeft}px`
	tooltip.style.top = `${top}px`

	const tipH = tooltip.offsetHeight || 0
	tooltip.classList.toggle('chart-tooltip--bottom', anchorY < tipH + 18)
}

function updateDetailsTotals() {
	if (!detailIncomeTotalOut || !detailExpensesTotalOut || !detailSavingsTotalOut) return
	if (!session) {
		detailIncomeTotalOut.textContent = '$0'
		detailExpensesTotalOut.textContent = '$0'
		detailSavingsTotalOut.textContent = '$0'
		return
	}
	const { totals } = buildPeriodSeries(detailKind, detailAnchorDayMs)
	detailIncomeTotalOut.textContent = formatDollars(totals.incomeDollars)
	detailExpensesTotalOut.textContent = formatDollars(totals.expensesDollars)
	detailSavingsTotalOut.textContent = formatDollars(totals.savingsDollars)
}

function drawDetails() {
	if (!detailChartCanvas) return
	if (!session) {
		detailChartState = null
		return
	}
	if (detailKindSelect) detailKindSelect.value = detailKind
	const iso = isoDateValue(detailAnchorDayMs)
	if (detailDateInput) detailDateInput.value = iso
	if (entryDateInput && document.activeElement !== entryDateInput) entryDateInput.value = iso
	drawDetailChart(detailKind, detailChartCanvas, detailTooltip, detailRange)
	updateDetailsTotals()
}

function updateProgress() {
	const goalUnits = Number(range.value)
	const goalDollars = goalUnits * DOLLARS_PER_UNIT
	const currentDollars = getCurrentSavingsForGoalProgress()
	updateDashboardSummary({ goalDollars, currentDollars })
	if (normalizeRoute(location.hash) === 'details') drawDetails()
}

function onInput() {
	const value = Number(range.value)
	valueOut.textContent = formatDollarsFromUnits(value)
	const percent = (value - MIN) / (MAX - MIN)
	range.style.setProperty('--range-pct', `${percent * 100}%`)
	layoutRocket()
	updateProgress()

	if (!suppressGoalPersist) {
		const goalDollars = value * DOLLARS_PER_UNIT
		if (goalTimer) window.clearTimeout(goalTimer)
		goalTimer = window.setTimeout(() => {
			void persistGoalDollars(goalDollars)
		}, 400)
	}
}

range.addEventListener('input', onInput)

authForm?.addEventListener('submit', async (e) => {
	e.preventDefault()
	showAuthError('')
	try {
		loginBtn.disabled = true
		registerBtn.disabled = true
		const isRegister = authMode === 'register'
		const name = normalizePersonName(String(authName?.value || ''))
		const email = String(authEmail.value || '').trim().toLowerCase()
		const password = String(authPassword.value || '')

		if (isRegister) {
			if (isDesktopApp) {
				session = await desktop.auth.register(email, password, name)
			} else {
				const out = await cloudRegister(email, password, name)
				const token = typeof out?.token === 'string' ? out.token : ''
				const cloudUserId = typeof out?.userId === 'string' ? out.userId : ''
				const returnedName = typeof out?.name === 'string' ? out.name.trim() : ''
				if (!token) throw new Error('Registration failed')
				session = { id: 0, name: returnedName || name || undefined, email, token, cloudUserId: cloudUserId || undefined }
				saveWebSessionToStorage(session)
			}
		} else if (isDesktopApp) {
			session = await desktop.auth.login(email, password)
		} else {
			const out = await cloudLogin(email, password)
			const token = typeof out?.token === 'string' ? out.token : ''
			const cloudUserId = typeof out?.userId === 'string' ? out.userId : ''
			const returnedName = typeof out?.name === 'string' ? out.name.trim() : ''
			if (!token) throw new Error('Login failed')
			session = { id: 0, name: returnedName || undefined, email, token, cloudUserId: cloudUserId || undefined }
			saveWebSessionToStorage(session)
		}

		// Clear previous values immediately (prevents old account values lingering).
		resetGoalUi({ persistLocal: !isDesktopApp })
		didWarnDesktopGoalSync = false

		authName.value = ''
		authPassword.value = ''
		setAuthMode('login')
		setProfileEditorOpen(false)
		updateAuthUi()
		if (isDesktopApp) {
			await loadGoalFromDbOrMigrate()
			await loadLedgerEntriesFromStorage()
			void syncLedgerWithCloud()
		} else {
			await loadGoalFromCloudOrFallback()
			await loadLedgerEntriesFromStorage()
			void syncLedgerWithCloud()
		}
		updateProgress()
	} catch (err) {
		showAuthError(err?.message ? String(err.message) : (authMode === 'register' ? 'Registration failed' : 'Login failed'))
	} finally {
		loginBtn.disabled = false
		registerBtn.disabled = false
	}
})

registerBtn?.addEventListener('click', async () => {
	setAuthMode(authMode === 'register' ? 'login' : 'register')
})

authModeLoginBtn?.addEventListener('click', () => setAuthMode('login'))
authModeRegisterBtn?.addEventListener('click', () => setAuthMode('register'))

profileEditBtn?.addEventListener('click', () => setProfileEditorOpen(true))
profileCancelBtn?.addEventListener('click', () => setProfileEditorOpen(false))

profileForm?.addEventListener('submit', async (e) => {
	e.preventDefault()
	showProfileError('')
	try {
		if (!profileSaveBtn) return
		profileSaveBtn.disabled = true
		await persistProfileName(String(profileName?.value || ''))
	} catch (err) {
		showProfileError(err?.message ? String(err.message) : 'Could not save your name')
	} finally {
		if (profileSaveBtn) profileSaveBtn.disabled = false
	}
})

logoutBtn?.addEventListener('click', async () => {
	showAuthError('')
	try {
		logoutBtn.disabled = true
		if (isDesktopApp) {
			await desktop.auth.logout()
			session = null
			ledgerEntries = []
			resetGoalUi({ persistLocal: false })
			didWarnDesktopGoalSync = false
		} else {
			session = null
			ledgerEntries = []
			saveWebSessionToStorage(null)
			resetGoalUi({ persistLocal: true })
		}
		setProfileEditorOpen(false)
		try {
			saveLedgerCloudSyncState({ pendingClientIds: [], lastPullMs: 0 })
		} catch {
			// ignore
		}
		updateAuthUi()
		updateProgress()
	} catch {
		// ignore
	} finally {
		logoutBtn.disabled = false
	}
})

setAuthMode('login')

window.addEventListener('resize', () => {
	layoutRocket()
	if (normalizeRoute(location.hash) === 'details') drawDetails()
})

detailChartCanvas?.addEventListener('pointermove', (e) => onDetailPointerMove(detailChartCanvas, detailTooltip, e))
detailChartCanvas?.addEventListener('pointerleave', () => hideDetailTooltip(detailTooltip))

detailKindSelect?.addEventListener('change', () => {
	const next = String(detailKindSelect.value || '').trim().toLowerCase()
	if (next === 'month' || next === 'year' || next === 'week') {
		detailKind = next
	}
	drawDetails()
})

detailDateInput?.addEventListener('change', () => {
	detailAnchorDayMs = parseDateInputToDayMs(detailDateInput.value)
	drawDetails()
})

detailPrevBtn?.addEventListener('click', () => {
	detailAnchorDayMs = shiftAnchor(detailKind, detailAnchorDayMs, -1)
	drawDetails()
})

detailNextBtn?.addEventListener('click', () => {
	detailAnchorDayMs = shiftAnchor(detailKind, detailAnchorDayMs, 1)
	drawDetails()
})

function showEntryError(msg) {
	if (!entryError) return
	const text = String(msg || '').trim()
	entryError.textContent = text
	entryError.hidden = !text
}

entryForm?.addEventListener('submit', async (e) => {
	e.preventDefault()
	showEntryError('')
	if (!session) {
		showEntryError('Log in to add entries')
		return
	}
	try {
		if (entryAddBtn) entryAddBtn.disabled = true
		const dayMs = parseDateInputToDayMs(entryDateInput?.value)
		const income = parseMoneyInput(entryIncomeInput?.value)
		const expenses = parseMoneyInput(entryExpensesInput?.value)
		const savings = parseMoneyInput(entrySavingsInput?.value)
		await addLedgerEntry({ dayMs, incomeDollars: income, expensesDollars: expenses, savingsDollars: savings })
		if (entryIncomeInput) entryIncomeInput.value = '0'
		if (entryExpensesInput) entryExpensesInput.value = '0'
		if (entrySavingsInput) entrySavingsInput.value = '0'
		updateProgress()
		drawDetails()
	} catch (err) {
		showEntryError(err?.message ? String(err.message) : 'Failed to add entry')
	} finally {
		if (entryAddBtn) entryAddBtn.disabled = false
	}
})

// Initial layout after first paint (ensures we can measure sizes).
requestAnimationFrame(() => {
	onInput()
	if (detailDateInput) detailDateInput.value = isoDateValue(detailAnchorDayMs)
	if (entryDateInput) entryDateInput.value = isoDateValue(detailAnchorDayMs)
})
