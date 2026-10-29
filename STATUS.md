# STATUS — MyTeam production copy (local build)

Updated: 2026-10-22. Scope of this build: **local code only** — no deployment, no accounts, no DNS changes, Muse artifact untouched.

Legend: **implemented+locally verified** = covered by the automated end-to-end suite (`npm test`, disposable seeded DB) and/or local HTTP checks; **implemented-unverified** = code present but not exercised end-to-end here; **not yet done** = intentionally left for the deployment stage.

## Acceptance checklist from the migration plan

| # | Checklist item | Status | Evidence |
|---|---|---|---|
| 1 | Company name in header: SHAWA GRILL & MANGAL | implemented+locally verified | Import test + `GET /api/bootstrap` returned the exact name; UI header binds to it |
| 2 | 4 locations with exact addresses | implemented+locally verified | Test asserts all four names/addresses from the snapshot (Sunny Isles; Miami Downtown — 2929 Biscayne Blvd; Fort Lauderdale — 2630 W Broward Blvd Ste 105; Hallandale — 410 NE 1st Ave Suite 8) |
| 3 | Owner login works; his time punches preserved | implemented+locally verified | Login by seed phone succeeded (no PIN in snapshot); state returned the 2 seeded punches |
| 4 | Invite «Повар · Sunny Isles»: registration lands with correct rank/position/location | implemented+locally verified | Invite created with rank `staff` from position; registered profile asserted position «Повар», location Sunny Isles, rank staff |
| 5 | Employee never sees rates; owner sees and edits them | implemented+locally verified | Owner PATCH set rate 20 and saw it; raw non-owner `/api/state` contains no `hourlyRate` and no `cost`; non-owner timesheet rows have hours only; owner timesheet has cost |
| 6 | Recurring shift creates a series; reminders at T-2h and T-1h appear | implemented+locally verified | Weekly series creation returned 4 occurrences in one `seriesId`; reminder job produced both `shift_2h` and `shift_1h` notifications for the employee. Series auto-extension code runs in the same job (not separately integration-tested over a long horizon) |
| 7 | Points: manual award visible in history; weekly bonus +10 accrues | implemented+locally verified | Manager award +5 visible; weekly job for the previous completed NY week brought the clean employee to 15; an employee with a violation in that week received no bonus |
| 8 | Ratings tables (employees and locations) are published | implemented+locally verified | After the weekly job, a staff profile could read the published snapshot containing employees and a Sunny Isles location row |
| 9 | Install on a phone home screen works | implemented-unverified | Manifest, 192/512 PNG icons, service worker and install button/instructions are implemented and served with HTTP 200 locally; a real device install prompt cannot be verified in this environment |
| 10 | Positions are the first level inside a location | implemented+locally verified | Team UI builds first-level position tabs inside a location from API data (standard roles + custom positions); the underlying location/position/invite data flow is covered by the automated suite. No visual browser click-through was performed in this environment |

## Other sections

| Area | Status | Notes |
|---|---|---|
| Auth (register name+surname+phone-or-email, login by contact+PIN, first profile = owner, company name by owner) | implemented+locally verified | Duplicate-contact and needs-PIN paths handled; owner can rename the company and set the weekly bonus size |
| Team structure (owners/directors sections; staff sees only «Мои данные» + all locations) | implemented+locally verified | Staff state contains exactly one employee (self) and all 4 locations; invite-above-own-rank rejected with 403 (tested) |
| Punches + kiosk by PIN + time off with approval | implemented+locally verified | Personal clock in/out and approval flow tested; kiosk endpoint implemented with employee ID + PIN (same clock logic) |
| Tasks | implemented+locally verified | Create/assign/status flow smoke-tested |
| Feed: announcements with read confirmation, polls with voting/closing | implemented+locally verified | Smoke-tested end-to-end |
| Checklists (templates + runs) | implemented+locally verified | Smoke-tested end-to-end |
| Learning: courses/lessons/progress, documents with acknowledgement, knowledge base | implemented+locally verified | Smoke-tested end-to-end |
| Rank chats (visibility strictly top-down, posting upward rejected) | implemented+locally verified | Staff state contains only level-1 channels; posting to the owner channel as staff returned 403; posting to the team channel succeeded |
| Cron jobs (every 15 min reminders/series extension; Monday 07:13 America/New_York weekly cycle) | implemented-unverified | Logic is shared with the manually invoked jobs that the suite verifies; real Cloudflare cron firing can only be verified after deployment. Cron expressions are UTC in `wrangler.toml`, the 07:13 decision is made in New York time in code |

## Not yet done (deployment stage, out of scope here)

- Cloudflare account setup, D1 creation, `wrangler deploy`, attaching `shawa.team` + `www`, HTTPS verification — exact steps are in `README.md`; the owner must be present for account/registrar logins.
- Live acceptance pass on the real domain (the plan's checklist against production data).
- Visual/browser QA pass of the production UI on a real phone (layout was built responsively and assets verified over HTTP, but no device click-through was run here).
- Push notifications — not part of the current version either; reminders are in-app, as before.

## Local verification performed

- `npm run check` — syntax OK (API, Worker, frontend, tools).
- `npm test` — **all tests passed** (seed import → owner login → invites → rates privacy → points/violations/weekly bonus → ratings publication → timesheet → series + reminders → tasks/feed/checklists/learning/chat/timeoff smoke flows).
- Local server run with the seed snapshot: `/`, `/styles.css`, `/app.js`, `/manifest.webmanifest`, `/sw.js`, both PNG icons and `/api/bootstrap` all returned HTTP 200.

## Production deployment — 2026-10-22 (live)

- Deployed to Cloudflare account eaa2800d9908adcf4cdac9907a02bf5e via API token (custom.cloudflare connector, surrogate passed to wrangler as CLOUDFLARE_API_TOKEN).
- Worker "myteam" version 8352b1dd-978f-4aac-a98a-eb443a41ca1c. Custom domains: shawa.team, www.shawa.team (zone active). Cron schedules registered: */15 * * * *, Mon 11:13 and 12:13 UTC.
- D1 myteam-production (5395eea4-ab5c-470a-aeef-ef96e6718103): migration applied, snapshot imported — verified counts: locations 4, employees 1 (owner), punches 2, channels 5, companyName SHAWA GRILL & MANGAL.
- Live checks: GET https://shawa.team/ 200 (app HTML), /api/bootstrap returns company + 4 locations + America/New_York, /app.js and /sw.js 200, https://www.shawa.team/ 200.
- Old NameSilo parking A records (6) deleted from the zone before domain attach.
- Still only observable over time on production: cron firing in the wild and PWA install on a real device (owner to tap the install button once).

## Security fix — 2026-10-22 (PIN self-service)
- Muhammad flagged: login by phone/email alone (owner profile had no PIN) let anyone with the number in.
- UI gap found: API supported PINs (PBKDF2, login enforces when set) but no screen could set one. Added: "Мой PIN" form on own card (Team), PIN field in the manager edit form (empty = unchanged; handler strips empty pin so edits can't wipe it). SW cache bumped to myteam-v2. Redeployed (version 507ac6a8).
- E2E verified live with a throwaway account (deleted after): set PIN → login without PIN = 401 needsPin, wrong PIN = 401, correct PIN = 200.
- Owner duplicate merge (same day): his fresh email registration (id 2, staff) merged with the imported phone owner (id 1): punches moved, id 2 promoted to owner with phone +19547161616, id 1 deactivated and its phone cleared.

## Password auth — 2026-10-22 (per Muhammad's spec)
- Flow now: manager issues invite code (rank/position/location preset) → person registers name + surname + phone or email + invite code + creates own password (min 6) → logs in with contact + password. Open registration without a code is closed (403). Password required at registration (400 without).
- employees.password_hash added (migration 0002, PBKDF2 same format as PIN). Login: password_hash wins; legacy PIN-only accounts still log in with their PIN typed in the password field; accounts with neither stay contact-only until they set a password (owner still must set his — UI: Team → own card → "Мой пароль", which replaced "Мой PIN" and also holds the optional kiosk PIN). Managers can reset an employee's password/PIN in the edit form.
- Tests updated (register calls carry passwords; import-snapshot applies all migrations in order) — npm test green. Live E2E with a D1-inserted test invite (deleted after): no-password 400, no-invite 403, invite+password 201 with invite's position/location, login no/wrong/correct password = 401/401/200. Deployed version e2932a96, SW cache myteam-v3.

## Personal bound invites + 2-step registration — 2026-10-22
- Muhammad's concern: anyone could type a phone number and self-register/set a PIN. Fix shipped: invites can be BOUND to one phone/email (invites.contact, migration 0003). Manager enters the person's contact when creating the invite; registration with that code works only for that exact contact (400 otherwise — verified live). Registration UI split into 2 steps: (1) name/surname/contact/code, (2) create password. Deployed version edaadddc, SW myteam-v4. Tests green incl. bound-invite case.
- Still open (his decision): AUTOMATIC code delivery by SMS/email. The Worker cannot send SMS itself — needs a provider: Twilio (SMS, paid per message) or Resend (email codes, free tier). Owner creates the account, key via Vault, then codes are sent automatically at invite creation.

## Mangal roster import — 2026-10-23 (live)

- Muhammad sent the real Connecteam export (`users__1.xlsx`, 32 people) and confirmed import into MyTeam **and** CEO. 31 imported (Muhammad Malikov from the file skipped — he is the owner, id 2). Idempotent name-matched inserts straight into prod D1; a second run created zero duplicates.
- Resulting active counts (identical in both systems): Sunny Isles 18, Miami Downtown 6, Fort Lauderdale 6, no location 2 (owner + Artur), total 32 active. Hallandale: nobody (opening).
- Mapping: Adam Oganesyan → Director; Aleksei Chernov → «Шеф-повар» (rank staff); Natella Krainova, Artur, Hamza Rezgui → Manager/«Менеджер»; Cook→«Повар», Cashier→«Кассир», Server→«Официант», Helper→«Помощник», Prep→«Повар». Positions stored in the canonical Russian form (matches STANDARD_ROLES and the CEO scene role matcher). Russian position strings were used deliberately.
- Multi-location people got ONE profile at their primary location (first in the export); the employees schema has no secondary-location field — all locations per person are listed in the owner-only notes file (below).
- The export's last column holds the chef's private evaluations of almost every employee. **Not written to any database** — neither schema has an owner-only notes field. They live only in `~/workspace/goals/shawa-ceo/files/mangal-staff-notes-2026-10-23.md`. Verified live: temporary staff/manager/owner sessions (inserted via D1, deleted after) — `/api/state` payloads contain none of the probe fragments from the evaluations.
- No contacts exist in the export, so profiles are roster-only (no phone/email, no password/PIN, cannot log in) and no invites were issued. Adding contacts later enables bound invites.
- Neither locations schema has a manager field, so there is no «MANGAL» placeholder to replace in the DB; Hamza Rezgui is now manager of Miami Downtown by profile (rank manager + location). Location managers for Sunny Isles and Fort Lauderdale remain unassigned.

## Email-code verification via Resend — 2026-10-22 (built, awaiting Resend account)
- Muhammad chose email codes via Resend (free). Machinery built and deployed (version b98fab9f, SW myteam-v5): pending_registrations table (migration 0004); POST /api/auth/register/start|verify|resend; register() accepts {pendingId, password} after verification and refuses classic email registration once RESEND_API_KEY is set. Codes: 6 digits, PBKDF2 hash, 10-min expiry, max 5 attempts, resend resets. Feature-flagged: without the secret, /start returns verificationRequired=false and registration behaves as before — nothing breaks pre-setup.
- Verified: local tests green incl. state machine; LIVE on production with a D1-inserted pending row (deleted after): verify wrong 401 / right 200, complete 201 (position from invite, hasPassword), login 200; /start fallback 200.
- Remaining (Muhammad): create Resend account (free) + API key via Vault. Then LockMan: add shawa.team domain in Resend via API, copy its DNS records into his Cloudflare zone, trigger verification, set RESEND_API_KEY as a Worker secret (test-send verifies; fallback = he pastes it in the dashboard), confirm a real code email arrives.

## Video training module — 2026-10-26 (live)

- Migration `0005_training.sql` applied to production D1 **directly by file** (`wrangler d1 execute --file`). ⚠️ Do NOT use `wrangler d1 migrations apply` on production: migrations 0001–0004 were applied manually, the `d1_migrations` tracker is empty, and `apply` fails on `0002` (duplicate `password_hash`).
- Lessons gained `video_url` (YouTube link or direct video file), quiz questions (`lesson_questions`: options JSON + correct index, never sent to clients) and per-employee results (`lesson_results`: watched_at, score/total, completed_at).
- Flow: manager+ creates a lesson with a video link and optional quiz → employee watches, presses «Я посмотрел видео» → takes the quiz (blocked until watched) → completion requires all answers correct; a video lesson without a quiz completes on watch. Managers see «Прогресс обучения» (per employee × lesson, with location, watched/score/completed) in the Learning tab via `state.trainingProgress`.
- Verified: local suite `npm test` passes incl. new training flow; production deploy version `e5f6fb3b-6e46-4554-b7fd-b7cb38a9913f`; https://shawa.team and /api/bootstrap return 200; new SQL shapes executed read-only against production D1. Backups: `backups/pre-training-2026-10-26.tar.gz`, `backups/d1-pre-training-2026-10-26.sql`.
- Not included: uploading/storing video files (lessons take a YouTube/file URL only), per-lesson deadlines or assignments to specific locations.

## Lesson assignments + due dates — 2026-10-26 night (live)

- Migration `0006_lesson_assignments.sql` applied to production D1 **directly by file** (same warning as 0005: never `wrangler d1 migrations apply`). New table `lesson_assignments` (lesson → location OR employee, optional `due_date` YYYY-MM-DD, unique per lesson+target).
- Semantics: a lesson **with** assignments is targeted — staff see it only when assigned to them directly or through their location; lessons without assignments stay visible to everyone (previous behavior, tests unchanged). Managers always see everything plus the assignment list per lesson.
- API: `POST /api/lessons/:id/assignments` (manager+, `{locationId}` xor `{employeeId}`, optional `dueDate`; re-posting the same target updates the due date), `DELETE /api/lessons/:id/assignments/:assignmentId` (manager+).
- State: per-lesson `myAssignment {dueDate, overdue}`; top-level `myAssignments` (employee's assigned lessons, overdue = due date passed in America/New_York and not completed, overdue first); manager-only `assignmentProgress` — assignments expanded to employees with watched/score/completed/overdue, direct assignment wins over location for the same lesson.
- UI (Learning tab): «Мои назначенные уроки» card with due dates and a red «Просрочено» badge; per-lesson assign form (location/employee selects + date) and ✕ removal for manager+; «Прогресс обучения» gained a location filter and a «Назначения и сроки» list (overdue in red). SW cache `myteam-v7`.
- Verified: `npm run check` clean; `npm test` passes incl. the new assignment flow (403 for staff, overdue flag set/cleared, upsert, targeting hides the lesson from non-assignees, direct assign + delete). Production deploy version `eaa9522c-e350-4b75-b484-bba7df463fcb`; https://shawa.team and www return 200, `/api/bootstrap` 200, served app.js contains the new UI, read-only assignment-join SQL executed against production D1 without errors. Backups: `backups/pre-assignments-2026-10-26.tar.gz`, `backups/d1-pre-assignments-2026-10-26.sql`.
- Not done: push/in-app notifications when a due date approaches (assignments surface in the Learning tab only); no live click-through under a real account (owner password not available to the agent — the full flow is covered by the local suite on the same code/schema).
