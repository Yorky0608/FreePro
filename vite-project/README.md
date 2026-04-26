# Rocket Slider (Vite + Electron)

A small mockup app: a slider from **0** to **140** that moves a rocket across the track.

## Requirements

- Node.js (LTS recommended)
- Windows (this project is set up to run as a Windows desktop app during development)

## Install

Important: run all `npm` commands from the `vite-project/` folder (the folder that contains `package.json`).

```bash
cd vite-project
```

Then install dependencies:

```bash
npm install
```

## Run as a website (browser)

Start the Vite dev server:

```bash
npm run dev
```

If you are in the parent folder (one level above `vite-project/`), you can also run:

```bash
npm --prefix vite-project run dev
```

Then open the URL shown in the terminal (usually `http://localhost:5173/`).

### Web login + sync (optional)

The browser build now supports the same email/password login UI. In web mode, it authenticates directly against the cloud API (and, when logged in, will sync savings + goal to the API).

Notes:

- In dev (`npm run dev`), the app uses a Vite proxy: requests go to `/api/...` and Vite forwards them to your real API (helps avoid CORS while developing locally).
- In production (including GitHub Pages), your API must enable CORS for your site origin or the browser will fail with a network error like "Failed to fetch".

To point the web build at a different API base URL, set:

- `VITE_API_BASE_URL` (example: `https://your-api.example.com`)

## Cloud API (AWS) notes

If your API Gateway routes point at a Lambda, that Lambda must have the required environment variables set.
If they are missing, endpoints like `POST /auth/login` will return `500 {"message":"Internal Server Error"}` and the desktop app will show `cloud sync OFF`.

Required Lambda env vars:

- `USERS_TABLE` — DynamoDB table name for users
- `SAVINGS_TABLE` — DynamoDB table name for savings/month log
- `LEDGER_TABLE` — DynamoDB table name for ledger entries
- `JWT_SECRET` — secret used to sign/verify JWTs (keep this stable, or existing tokens become invalid)

If you want account names to sync through AWS as well, update your auth Lambda and `USERS_TABLE` items so:

- `POST /auth/register` accepts `name` alongside `email` and `password`
- the user item stores a `name` attribute in DynamoDB
- `POST /auth/register` returns `name` in its JSON response
- `POST /auth/login` also returns `name` so the browser app can restore it from cloud auth

Recommended shape for a user item:

```json
{
	"userId": "uuid-or-cognito-sub",
	"email": "person@example.com",
	"name": "Person Name",
	"passwordHash": "...",
	"createdAtMs": 1714090000000
}
```

Minimum backend checklist:

- extend request validation to allow an optional `name` string
- write `name` into DynamoDB on registration
- include `name` in the JWT payload or fetch it during login response generation
- keep CORS enabled for your app origin if the browser build calls API Gateway directly

For the in-app name editor added in the dashboard, expose one more authenticated route:

- `POST /profile/name` with body `{ "name": "New Name" }`
- read the user from the bearer token
- update the `name` attribute in `USERS_TABLE`
- return `{ "name": "New Name" }`

Example Lambda handler shape:

```js
if (event.httpMethod === 'POST' && event.path === '/profile/name') {
	const token = event.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
	const claims = verifyJwt(token)
	const body = JSON.parse(event.body || '{}')
	const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120)

	await dynamo.update({
		TableName: process.env.USERS_TABLE,
		Key: { userId: claims.userId },
		UpdateExpression: 'SET #name = :name',
		ExpressionAttributeNames: { '#name': 'name' },
		ExpressionAttributeValues: { ':name': name || null },
	}).promise()

	return json(200, { name })
}
```

Quick verification (should return `401` for bad creds, not `500`):

```bash
node -e "fetch('https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'debug@example.com',password:'notreal'})}).then(async r=>{console.log('status',r.status); console.log('body', (await r.text()).slice(0,200));}).catch(e=>{console.error(e); process.exit(1);});"
```

## Run as a desktop app (Electron)

This runs Vite and Electron together (Electron opens a desktop window pointing at the Vite dev server):

```bash
npm run dev:desktop
```

If you are in the parent folder (one level above `vite-project/`), you can also run:

```bash
npm --prefix vite-project run dev:desktop
```

Notes:

- If you close the Electron window, the command may stop (that’s expected).
- If you want to re-open just the desktop window while Vite is running, use:

```bash
npm run dev:electron
```

## Build

Build the web assets:

```bash
npm run build
```

This outputs a production build into the `dist/` folder.

## Project Structure

- `index.html` – app entry HTML
- `src/main.js` – UI + slider logic
- `src/style.css` – theme + styles
- `electron/main.cjs` – Electron main process (desktop window)
- `electron/preload.cjs` – safe preload bridge (minimal)

## Desktop Login + Database (SQLite)

When you run the desktop app (`npm run dev:desktop`), savings are stored per-user in a local SQLite database file under Electron's `userData` folder.

- Create an account (email + password) or log in.
- Savings entries are stored per month for the logged-in user.
- In plain browser mode (`npm run dev`), the demo continues to use `localStorage`.

## Python DB Schema Init (portable)

There is also a Python helper script to create the same tables in a SQL database:

```bash
python scripts/init_db.py
```

It uses `DATABASE_URL` (defaults to SQLite). For other SQL engines later, point `DATABASE_URL` at your rollout database.

Dependencies for that script:

- `sqlalchemy`
