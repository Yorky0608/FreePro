import './style.css'

const MIN = 0
const MAX = 140
const DOLLARS_PER_UNIT = 1000

const app = document.querySelector('#app')
if (!app) {
	throw new Error('Missing #app element')
}

app.innerHTML = `
	<div class="shell">
		<header class="topbar" aria-label="Site header">
			<div class="topbar-inner">
				<div class="topbar-brand">The Freedom Program</div>
				<nav class="topbar-nav" aria-label="Primary">
					<a class="topbar-link" href="#home">Home</a>
					<a class="topbar-link" href="#demo">Goal Demo</a>
				</nav>
				<a class="topbar-cta" href="#demo">Try the demo</a>
			</div>
		</header>

		<section class="hero" id="home" aria-label="Homepage hero">
			<div class="hero-inner">
				<div class="hero-left">
					<div class="hero-stat">4</div>
					<p class="hero-text">
						A sensible four-year, non-degree path focused on real work, intentional savings, and growing into adulthood.
					</p>
					<p class="hero-text">
						This app is a mobile-first companion (starting as HTML) — the goal is to help you plan and track savings month by month.
					</p>
				</div>

				<div class="hero-right" aria-hidden="true">
					<div class="hero-wordmark">Freedom Program</div>
					<div class="mark">
						<div class="mark-rays"></div>
						<div class="mark-core"></div>
					</div>
				</div>
			</div>
		</section>

		<section class="panel" id="demo" aria-label="Savings goal demo">
			<h2>Freedom Program Goal</h2>
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
				<div class="progress-row">
					<label class="progress-label" for="currentSavings">Current Savings</label>
					<div class="progress-inputWrap">
						<span class="progress-prefix" aria-hidden="true">$</span>
						<input
							id="currentSavings"
							class="progress-input"
							type="number"
							inputmode="numeric"
							min="0"
							step="100"
							value="0"
							aria-label="Enter current savings amount in dollars"
						/>
					</div>
					<output class="progress-current" id="currentSavingsOut">$0</output>
				</div>
				<div class="progress-sub" aria-live="polite">
					<span class="progress-hint">Saved monthly (e.g., 1/26, 2/26)</span>
					<span class="progress-saved" id="lastSaved">Not saved yet</span>
				</div>

				<div class="chart" aria-label="Savings over time (4 years)">
					<canvas
						id="savingsChart"
						class="chart-canvas"
						role="img"
						aria-label="Line graph of your savings over the 4-year program"
					></canvas>
					<div id="chartTooltip" class="chart-tooltip" role="status" aria-live="polite" hidden></div>
					<div class="chart-meta" aria-hidden="true">
						<span class="chart-pct" id="chartPct">0%</span>
						<span class="chart-remaining" id="chartRemaining">Remaining: $0</span>
					</div>
				</div>
			</div>
		</section>

		<div id="spacer" aria-hidden="true"></div>
	</div>
`

const range = /** @type {HTMLInputElement} */ (document.querySelector('#rocketRange'))
const valueOut = /** @type {HTMLOutputElement} */ (document.querySelector('#rocketValue'))
const rocket = /** @type {HTMLDivElement} */ (document.querySelector('#rocket'))
const currentSavingsInput = /** @type {HTMLInputElement} */ (document.querySelector('#currentSavings'))
const currentSavingsOut = /** @type {HTMLOutputElement} */ (document.querySelector('#currentSavingsOut'))
const lastSaved = /** @type {HTMLSpanElement} */ (document.querySelector('#lastSaved'))
const chartCanvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#savingsChart'))
const chartPct = /** @type {HTMLSpanElement} */ (document.querySelector('#chartPct'))
const chartRemaining = /** @type {HTMLSpanElement} */ (document.querySelector('#chartRemaining'))
const chartTooltip = /** @type {HTMLDivElement} */ (document.querySelector('#chartTooltip'))

const STORAGE_KEY = 'rocket-slider:savings-log:v2'
const STORAGE_KEY_V1 = 'rocket-slider:savings-log:v1'
const PROGRAM_YEARS = 4

/** @type {Array<{ month: number, dollars: number }>} */
let savingsLog = loadSavingsLog()

/** @type {null | {
	canvasW: number,
	canvasH: number,
	start: number,
	end: number,
	padL: number,
	padT: number,
	plotW: number,
	plotH: number,
	yMax: number,
	log: Array<{ month: number, dollars: number }>,
	points: Array<{ month: number, dollars: number, x: number, y: number }>,
}} */
let chartState = null

let lastTooltipText = ''

// Initialize the current savings input from the most recent entry (if any).
if (savingsLog.length > 0) {
	const latest = savingsLog[savingsLog.length - 1]
	currentSavingsInput.value = String(latest.dollars)
	lastSaved.textContent = `Last saved: ${formatMonthLabel(latest.month)}`
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

function loadSavingsLog() {
	try {
		// Load v2 first, else attempt migration from v1.
		let raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) raw = localStorage.getItem(STORAGE_KEY_V1)
		if (!raw) return []
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []

		// Accept either {month, dollars} (v2) or {day, dollars} (v1).
		const cleaned = parsed
			.map((p) => {
				const monthCandidate = p?.month ?? p?.day
				return { month: Number(monthCandidate), dollars: Number(p?.dollars) }
			})
			.filter((p) => Number.isFinite(p.month) && Number.isFinite(p.dollars) && p.month > 0)
			.map((p) => ({
				month: startOfLocalMonthMs(new Date(p.month)),
				dollars: Math.max(0, p.dollars),
			}))
			.sort((a, b) => a.month - b.month)

		// De-dupe (keep last value for the month).
		/** @type {Map<number, number>} */
		const byMonth = new Map()
		for (const p of cleaned) byMonth.set(p.month, p.dollars)
		const result = [...byMonth.entries()]
			.map(([month, dollars]) => ({ month, dollars }))
			.sort((a, b) => a.month - b.month)

		// Write back as v2 to keep future loads simple.
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(result))
		} catch {
			// ignore
		}
		return result
	} catch {
		return []
	}
}

function saveSavingsLog() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(savingsLog))
	} catch {
		// ignore (private mode / storage disabled)
	}
}

function upsertSavingsForMonth(monthMs, dollars) {
	const month = startOfLocalMonthMs(new Date(monthMs))
	const value = Math.max(0, Math.round(dollars))
	const i = savingsLog.findIndex((p) => p.month === month)
	if (i >= 0) savingsLog[i] = { month, dollars: value }
	else savingsLog.push({ month, dollars: value })
	savingsLog.sort((a, b) => a.month - b.month)
}

function getPreviewLog() {
	const thisMonth = startOfLocalMonthMs(new Date())
	const current = parseMoneyInput(currentSavingsInput.value)
	const copy = savingsLog.slice()
	const i = copy.findIndex((p) => p.month === thisMonth)
	if (i >= 0) copy[i] = { month: thisMonth, dollars: current }
	else copy.push({ month: thisMonth, dollars: current })
	copy.sort((a, b) => a.month - b.month)
	return copy
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

function drawSavingsChart() {
	const ctx = chartCanvas.getContext('2d')
	if (!ctx) return

	const rect = chartCanvas.getBoundingClientRect()
	if (rect.width <= 0 || rect.height <= 0) return

	const dpr = Math.max(1, window.devicePixelRatio || 1)
	const width = Math.round(rect.width * dpr)
	const height = Math.round(rect.height * dpr)
	if (chartCanvas.width !== width) chartCanvas.width = width
	if (chartCanvas.height !== height) chartCanvas.height = height

	ctx.setTransform(1, 0, 0, 1, 0, 0)
	ctx.scale(dpr, dpr)

	const w = rect.width
	const h = rect.height
	ctx.clearRect(0, 0, w, h)

	const goalUnits = Number(range.value)
	const goalDollars = goalUnits * DOLLARS_PER_UNIT
	const log = getPreviewLog()
	const points = []

	const start = log.length > 0 ? log[0].month : startOfLocalMonthMs(new Date())
	const end = addYearsMs(start, PROGRAM_YEARS)
	const maxLogged = log.reduce((m, p) => Math.max(m, p.dollars), 0)
	const yMax = Math.max(1, goalDollars, maxLogged)

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
	const goalLine = axis

	const xFor = (t) => {
		const pct = (t - start) / (end - start)
		return padL + clamp(pct, 0, 1) * plotW
	}
	const yFor = (v) => {
		const pct = v / yMax
		return padT + (1 - clamp(pct, 0, 1)) * plotH
	}

	for (const p of log) {
		points.push({ month: p.month, dollars: p.dollars, x: xFor(p.month), y: yFor(p.dollars) })
	}

	// Axes
	ctx.strokeStyle = axis
	ctx.lineWidth = 1
	ctx.beginPath()
	ctx.moveTo(padL, padT)
	ctx.lineTo(padL, padT + plotH)
	ctx.lineTo(padL + plotW, padT + plotH)
	ctx.stroke()

	// Goal line (dashed)
	if (goalDollars > 0) {
		const yGoal = yFor(goalDollars)
		ctx.save()
		ctx.globalAlpha = 0.7
		ctx.setLineDash([6, 6])
		ctx.strokeStyle = goalLine
		ctx.beginPath()
		ctx.moveTo(padL, yGoal)
		ctx.lineTo(padL + plotW, yGoal)
		ctx.stroke()
		ctx.restore()
	}

	// Savings line
	if (points.length >= 1) {
		ctx.strokeStyle = accent
		ctx.lineWidth = 2
		ctx.lineJoin = 'round'
		ctx.lineCap = 'round'
		ctx.beginPath()
		for (let i = 0; i < points.length; i++) {
			const p = points[i]
			if (i === 0) ctx.moveTo(p.x, p.y)
			else ctx.lineTo(p.x, p.y)
		}
		ctx.stroke()

		// Latest point marker
		const last = points[points.length - 1]
		ctx.fillStyle = accent
		ctx.beginPath()
		ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2)
		ctx.fill()
	}

	// Labels (start/end) as M/YY
	ctx.fillStyle = text
	ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif'
	ctx.textBaseline = 'alphabetic'
	const baselineY = padT + plotH

	// Yearly tick marks across the 4-year program.
	const tickMonths = [0, 12, 24, 36, 48]
	for (const m of tickMonths) {
		const t = addMonthsMs(start, m)
		const x = xFor(t)

		// subtle vertical guide line
		if (m !== 0 && m !== 48) {
			ctx.save()
			ctx.globalAlpha = 0.35
			ctx.strokeStyle = axis
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.moveTo(x, padT)
			ctx.lineTo(x, baselineY)
			ctx.stroke()
			ctx.restore()
		}

		// tick mark
		ctx.strokeStyle = axis
		ctx.lineWidth = 1
		ctx.beginPath()
		ctx.moveTo(x, baselineY)
		ctx.lineTo(x, baselineY + 5)
		ctx.stroke()

		// label
		if (m === 0) ctx.textAlign = 'left'
		else if (m === 48) ctx.textAlign = 'right'
		else ctx.textAlign = 'center'
		ctx.fillStyle = text
		ctx.fillText(formatMonthLabel(t), x, baselineY + 18)
	}

	// Minimal Y labels (0 and goal)
	ctx.textAlign = 'right'
	ctx.fillStyle = text
	ctx.fillText('$0', padL - 8, padT + plotH)
	if (goalDollars > 0) {
		ctx.fillStyle = textH
		ctx.fillText(formatDollars(goalDollars), padL - 8, yFor(goalDollars) + 4)
	}

	chartState = {
		canvasW: w,
		canvasH: h,
		start,
		end,
		padL,
		padT,
		plotW,
		plotH,
		yMax,
		log,
		points,
	}
}

function hideChartTooltip() {
	if (!chartTooltip) return
	chartTooltip.hidden = true
	lastTooltipText = ''
}

function dollarsForTimeMs(t) {
	if (!chartState) return 0
	const log = chartState.log
	if (log.length === 0) return 0
	if (log.length === 1) return log[0].dollars

	if (t <= log[0].month) return log[0].dollars
	if (t >= log[log.length - 1].month) return log[log.length - 1].dollars

	let hi = 1
	while (hi < log.length && log[hi].month < t) hi++
	const lo = Math.max(0, hi - 1)
	const a = log[lo]
	const b = log[Math.min(hi, log.length - 1)]
	if (a.month === b.month) return b.dollars
	const pct = (t - a.month) / (b.month - a.month)
	return a.dollars + pct * (b.dollars - a.dollars)
}

function onChartPointerMove(e) {
	if (!chartTooltip) return
	if (!chartState || chartState.points.length === 0) {
		hideChartTooltip()
		return
	}

	const r = chartCanvas.getBoundingClientRect()
	const x = e.clientX - r.left
	const y = e.clientY - r.top
	if (x < 0 || y < 0 || x > r.width || y > r.height) {
		hideChartTooltip()
		return
	}

	const xClamped = clamp(x, chartState.padL, chartState.padL + chartState.plotW)
	const t = chartState.start + ((xClamped - chartState.padL) / chartState.plotW) * (chartState.end - chartState.start)
	const dollars = dollarsForTimeMs(t)
	const yAt = chartState.padT + (1 - clamp(dollars / chartState.yMax, 0, 1)) * chartState.plotH

	const labelMonth = startOfLocalMonthMs(new Date(t))
	const nextText = `${formatMonthLabel(labelMonth)} — ${formatDollars(dollars)}`
	if (nextText !== lastTooltipText) {
		chartTooltip.textContent = nextText
		lastTooltipText = nextText
	}

	chartTooltip.hidden = false
	const canvasLeft = chartCanvas.offsetLeft
	const canvasTop = chartCanvas.offsetTop

	// Place the tooltip anchored to the hovered X and interpolated Y.
	const tipW = chartTooltip.offsetWidth || 0
	const anchorLeft = canvasLeft + xClamped
	const anchorTop = canvasTop + yAt
	const minLeft = canvasLeft + tipW / 2 + 6
	const maxLeft = canvasLeft + chartState.canvasW - tipW / 2 - 6
	const clampedLeft = tipW > 0 ? clamp(anchorLeft, minLeft, maxLeft) : anchorLeft
	chartTooltip.style.left = `${clampedLeft}px`
	chartTooltip.style.top = `${anchorTop}px`

	const tipH = chartTooltip.offsetHeight || 0
	chartTooltip.classList.toggle('chart-tooltip--bottom', yAt < tipH + 18)
}

function updateProgress() {
	const goalUnits = Number(range.value)
	const goalDollars = goalUnits * DOLLARS_PER_UNIT
	const currentDollars = parseMoneyInput(currentSavingsInput.value)

	currentSavingsOut.textContent = formatDollars(currentDollars)

	const pct = goalDollars > 0 ? clamp(currentDollars / goalDollars, 0, 1) : 0
	const pctText = `${Math.round(pct * 100)}%`
	chartPct.textContent = pctText

	const remaining = Math.max(0, goalDollars - currentDollars)
	chartRemaining.textContent = `Remaining: ${formatDollars(remaining)}`

	drawSavingsChart()
}

function onInput() {
	const value = Number(range.value)
	valueOut.textContent = formatDollarsFromUnits(value)
	const percent = (value - MIN) / (MAX - MIN)
	range.style.setProperty('--range-pct', `${percent * 100}%`)
	layoutRocket()
	updateProgress()
}

range.addEventListener('input', onInput)

let logTimer = null
currentSavingsInput.addEventListener('input', () => {
	updateProgress()
	if (logTimer) window.clearTimeout(logTimer)
	logTimer = window.setTimeout(() => {
		const thisMonth = startOfLocalMonthMs(new Date())
		const dollars = parseMoneyInput(currentSavingsInput.value)
		upsertSavingsForMonth(thisMonth, dollars)
		saveSavingsLog()
		lastSaved.textContent = `Last saved: ${formatMonthLabel(thisMonth)}`
		drawSavingsChart()
	}, 600)
})

currentSavingsInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') currentSavingsInput.blur()
})

currentSavingsInput.addEventListener('change', () => {
	const thisMonth = startOfLocalMonthMs(new Date())
	const dollars = parseMoneyInput(currentSavingsInput.value)
	upsertSavingsForMonth(thisMonth, dollars)
	saveSavingsLog()
	lastSaved.textContent = `Last saved: ${formatMonthLabel(thisMonth)}`
	updateProgress()
})

window.addEventListener('resize', () => {
	layoutRocket()
	drawSavingsChart()
})

chartCanvas.addEventListener('pointermove', onChartPointerMove)
chartCanvas.addEventListener('pointerleave', hideChartTooltip)

// Initial layout after first paint (ensures we can measure sizes).
requestAnimationFrame(() => {
	onInput()
})
