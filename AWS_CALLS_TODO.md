# AWS Calls Inventory

This file tracks the API Gateway routes the app currently uses, plus the larger feature endpoints that would only be needed if the project moves away from the current renderer-state sync approach.

## Current API Gateway Routes

These routes are active in the current app and implemented in Lambda:

- `POST /auth/register`
- `POST /auth/login`
- `GET /profile/goal`
- `POST /profile/goal`
- `GET /profile/name`
- `POST /profile/name`
- `GET /profile/settings`
- `POST /profile/settings`
- `GET /profile/account`
- `GET /profile/renderer-state`
- `POST /profile/renderer-state`
- `GET /sync/pull`
- `POST /sync/save`
- `GET /ledger/pull`
- `POST /ledger/upsert`
- `GET /instructor/dashboard`
- `POST /instructor/create-account`
- `POST /instructor/set-role`
- `POST /instructor/assign-students`
- `POST /instructor/notifications`

## What Each Route Covers

### Auth

- `POST /auth/register`
- `POST /auth/login`

Used by both the web frontend and the Electron shell for account creation and login.

### Goal

- `GET /profile/goal`
- `POST /profile/goal`

Covers the savings goal amount.

### Profile Name

- `GET /profile/name`
- `POST /profile/name`

Covers the display name stored with the authenticated account.

### Profile Settings And Account

- `GET /profile/settings`
- `POST /profile/settings`
- `GET /profile/account`

These routes cover the goal timeline dates plus account metadata used by the authenticated session, including role, assigned instructor, assigned student emails, and notification inbox items.

### Renderer State

- `GET /profile/renderer-state`
- `POST /profile/renderer-state`

This is the main cloud sync path for several app features that are not modeled as separate AWS resources yet.

Currently this renderer-state payload is used to carry:

- settings/profile details
- monthly journal entries
- weekly report entries
- habit board definition
- habit tracker daily/weekly state
- local ledger metadata keyed by `clientId`
- local savings snapshot history

So, under the current architecture, separate endpoints for journal, weekly report, habits, and settings are not required for the app to function.

### Savings Snapshot Sync

- `GET /sync/pull`
- `POST /sync/save`

This is the legacy monthly savings snapshot sync used for the savings table.

### Ledger Sync

- `GET /ledger/pull`
- `POST /ledger/upsert`

This route pair now carries both the core numeric ledger amounts and the richer financial entry metadata.

Current ledger payload fields supported:

- `clientId`
- `dayMs`
- `incomeDollars`
- `expensesDollars`
- `savingsDollars`
- `incomeSource`
- `incomeNote`
- `expenseCategory`
- `expenseNote`
- `funds`
- `createdAtMs`
- `updatedAtMs`

### Instructor Routes

- `GET /instructor/dashboard`
- `POST /instructor/create-account`
- `POST /instructor/set-role`
- `POST /instructor/assign-students`
- `POST /instructor/notifications`

These routes power the instructor and super-instructor experience.

Current responsibilities covered:

- viewing an instructor roster and student summaries
- viewing a selected instructor roster as a super instructor
- creating instructor accounts
- promoting or demoting instructor roles
- assigning students to instructors
- sending roster-scoped notifications to students

## Routes Not Strictly Needed Right Now

These would only be needed if the project later decides to split the renderer-state payload into dedicated AWS resources.

### Monthly Journal

Optional future endpoints:

- `GET /journal/monthly`
- `POST /journal/monthly`
- `PUT /journal/monthly/{entryId}`
- `DELETE /journal/monthly/{entryId}`

### Weekly Report

Optional future endpoints:

- `GET /reports/weekly`
- `POST /reports/weekly`
- `PUT /reports/weekly/{entryId}`
- `DELETE /reports/weekly/{entryId}`

### Daily Habit Tracker

Optional future endpoints:

- `GET /habits/daily`
- `POST /habits/daily`
- `PUT /habits/daily/{weekOf}`
- `DELETE /habits/daily/{weekOf}`

### Extended Profile Details

Optional future endpoints:

- `GET /profile/details`
- `POST /profile/details`

## Remaining Architecture Notes

- The current app works with the routes listed in `Current API Gateway Routes`.
- Renderer-state is doing real work right now, not just a temporary placeholder.
- If the team wants cleaner DynamoDB modeling later, journal, weekly, habits, and settings can be broken out into dedicated routes without changing the current app behavior first.
- The richer financial/ledger metadata is now covered by the existing ledger routes, not by a separate metadata endpoint.
- The newer instructor routes do not add new AWS services; they are additional API Gateway routes handled by the same Lambda and existing DynamoDB tables.
