# AWS Calls To Add Later

This project now has local-only UI and storage for several features that do not yet have matching AWS/Lambda support.

## Already Present

These calls already exist in the current app and Lambda:

- `POST /auth/register`
- `POST /auth/login`
- `GET /profile/goal`
- `POST /profile/goal`
- `GET /profile/name`
- `POST /profile/name`
- `GET /sync/pull`
- `POST /sync/save`
- `GET /ledger/pull`
- `POST /ledger/upsert`

## New Calls Needed

### Monthly Journal

Current monthly journal data is still local-only in the frontend.

Suggested endpoints:

- `GET /journal/monthly`
- `POST /journal/monthly`
- `PUT /journal/monthly/{entryId}`
- `DELETE /journal/monthly/{entryId}`

Suggested payload fields:

- `entryId`
- `month`
- `own`
- `owe`
- `financialProgress`
- `aheadBehind`
- `goalThisMonth`
- `primaryJob`
- `secondaryJob`
- `volunteerOpportunities`
- `reading`
- `meetings`
- `classes`
- `billingJob`
- `interests`
- `enjoying`
- `helpPeople`
- `isStarred`
- `starredSections`
- `starredSections.financial.active`
- `starredSections.jobs.active`
- `starredSections.lessons.active`
- `starredSections.meaningfulWork.active`
- `createdAtMs`
- `updatedAtMs`

### Weekly Report

Current weekly report data is local-only.

Suggested endpoints:

- `GET /reports/weekly`
- `POST /reports/weekly`
- `PUT /reports/weekly/{entryId}`
- `DELETE /reports/weekly/{entryId}`

Suggested payload fields:

- `entryId`
- `week`
- `meetingWho1`
- `meetingLearned1`
- `meetingWho2`
- `meetingLearned2`
- `book1`
- `book1Chapter`
- `book1Learned`
- `book2`
- `book2Chapter`
- `book2Learned`
- `lessonTitle1`
- `lessonLearned1`
- `lessonTitle2`
- `lessonLearned2`
- `incomeJob1`
- `incomeJob2`
- `expenses`
- `isStarred`
- `starredSections`
- `starredSections.meetings.active`
- `starredSections.books.active`
- `starredSections.lessons.active`
- `starredSections.finances.active`
- `createdAtMs`
- `updatedAtMs`

### Daily Habit Tracker

The new daily report and 4-square habit tracker are local-only.

Suggested endpoints:

- `GET /habits/daily`
- `POST /habits/daily`
- `PUT /habits/daily/{weekOf}`
- `DELETE /habits/daily/{weekOf}`

Suggested payload fields:

- `weekOf`
- `items`: array of 4 item definitions
- `items[].id`
- `items[].icon`
- `items[].title`
- `items[].description`
- `days`: array of 7 day rows
- `days[].did`
- `days[].didWell`
- `days[].couldDoBetter`
- `days[].checks`: 4 booleans
- `days[].isStarred`
- `weeksByKey`
- `updatedAtMs`

Note: the current frontend stores the habit tracker as a board definition plus multiple saved weeks keyed by week start date. The AWS shape should support previous-week history, not only the current week.

### Settings / Extended Profile

The new settings screen stores extra profile details locally only.

Suggested endpoints:

- `GET /profile/details`
- `POST /profile/details`

Suggested payload fields:

- `name`
- `email`
- `contactInfo`
- `goalStartDate`
- `goalEndDate`
- `strengths`
- `weaknesses`
- `updatedAtMs`

Dashboard note: the dashboard now displays name, email, and contact info from this same settings/profile data, so no separate dashboard endpoint is required right now.

Note: if changing the login email should also change authentication identity, that needs a separate auth/account-change flow rather than only a profile endpoint.

### Ledger Metadata

The current ledger amount sync exists, but the new entry metadata does not.

New metadata now tracked locally:

- income source
- income note
- expense category
- expense note
- savings fund allocations

Suggested options:

1. Extend `POST /ledger/upsert` and `GET /ledger/pull` to include metadata.
2. Add a separate metadata endpoint keyed by `clientId`.

Suggested additional ledger fields:

- `incomeSource`
- `incomeNote`
- `expenseCategory`
- `expenseNote`
- `funds`
- `funds.E-Fund`
- `funds.Car Fund`
- `funds.Next Big Fund`
- custom fund keys

## Derived Dashboard Data

The dashboard's starred highlights are derived from journal, weekly report, and daily habit data already listed above.

No extra AWS endpoint is required if those source records include:

- journal `starredSections`
- weekly report `starredSections`
- habit `days[].isStarred`

## Desktop Bridge Work Later

If these cloud-backed features should also flow through Electron IPC, add matching methods in:

- `vite-project/electron/preload.cjs`
- `vite-project/electron/main.cjs`
- `vite-project/electron/db.cjs` if local desktop persistence should move out of browser localStorage

## Current Implementation Note

For now, the monthly journal, weekly report, daily habit tracker, settings profile details, goal timeline, weekly target calculation, and ledger metadata/fund splits are implemented locally in the frontend and build successfully without new AWS work.
