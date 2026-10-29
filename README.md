# MyTeam — production copy for shawa.team

Standalone production version of the MyTeam team-management app, built locally for a later deployment to Cloudflare. It reproduces the current Muse artifact: employees and locations, rank-based access, one-time invites, shifts (including weekly series and T-2h/T-1h reminders), time punches and timesheet, tasks, feed/polls, checklists, learning/KB/documents, rank chats, points, efficiency and weekly published ratings.

**Nothing in this folder is deployed.** No Cloudflare account, DNS change or external service is used by the local build.

## Stack

- Cloudflare Worker (`src/worker.js`) serving the PWA and the API
- Cloudflare D1 (SQLite) database, schema in `migrations/0001_initial.sql`
- Static PWA in `public/` (Russian UI, accent `#FF6B00`, installable, service worker)
- Optional Pages variant: `functions/api/[[path]].js` exposes the same API as a Pages Function. Scheduled jobs (reminders, weekly cycle) require the Worker deployment, because Pages has no cron triggers.
- Local development uses the exact same Worker/API code with a local D1-compatible adapter backed by Node's built-in SQLite (`tools/local-db.mjs`). All schedule/points time math uses `America/New_York`.

## Project layout

- `src/api.js` — API, permissions, jobs (reminders, recurring-series extension, weekly bonuses/ratings)
- `src/time.js` — America/New_York date helpers
- `src/worker.js` — Worker entrypoint (`fetch` + `scheduled`)
- `public/` — PWA frontend (`index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, icons)
- `migrations/` — D1 migrations
- `tools/import-snapshot.mjs` — snapshot import into a local SQLite DB or SQL file generation
- `tools/local-server.mjs` — local server (default port 8787)
- `tests/run-tests.mjs` — end-to-end API tests against a disposable seeded DB
- `data/import.sql` — generated seed SQL for D1 (regenerate with `npm run seed:sql`)

## Local run

Prerequisite: Node.js 22.5+ (the local adapter uses the built-in `node:sqlite`). No `npm install` is needed for local run/tests; Wrangler is only needed for deployment.

```bash
cd ~/workspace/myteam-production

# 1) Create the local DB from the approved snapshot (company, owner, 4 locations, owner punches)
npm run seed:local
#    — equivalent to:
#    node tools/import-snapshot.mjs ../goals/shawa-ceo/hidden_files/myteam-backup-2026-10-22-1251utc.json

# 2) Start the app
npm run dev        # seeds .local/myteam.sqlite from the snapshot if it does not exist yet
# or, to reuse an existing .local DB without reseeding:
npm run dev:clean

# 3) Open
#    http://localhost:8787
#    Seed owner login: phone +19547161616, no PIN is set in the snapshot.
```

Useful commands:

```bash
npm test           # full local end-to-end suite (disposable DB; does not touch .local)
npm run check      # syntax checks
npm run seed:sql   # regenerate data/import.sql from the snapshot for D1
```

## Cloudflare deploy steps (later, owner present)

These steps were **not** executed as part of the local build.

1. The owner creates a Cloudflare account in his own name and, when ready, adds the `shawa.team` zone (registrar nameserver change happens at this stage, with the owner logged in).
2. Install tooling and sign in as the owner:
   ```bash
   cd ~/workspace/myteam-production
   npm install
   npx wrangler login
   ```
3. Create the database and put its real ID into `wrangler.toml` (replacing `REPLACE_AFTER_ACCOUNT_SETUP`):
   ```bash
   npx wrangler d1 create myteam-production
   ```
4. Apply the schema:
   ```bash
   npx wrangler d1 migrations apply myteam-production --remote
   ```
5. Load the approved snapshot data (first import only):
   ```bash
   npm run seed:sql
   npx wrangler d1 execute myteam-production --remote --file data/import.sql
   ```
6. Deploy the Worker (static PWA + API + cron triggers from `wrangler.toml`):
   ```bash
   npx wrangler deploy
   ```
7. Attach the domain in Cloudflare: Workers & Pages → `myteam` → Settings → Domains & Routes → add `shawa.team` and `www.shawa.team`. If the zone's DNS is in the same Cloudflare account, the records are created automatically; verify HTTPS loads the app and `www` reaches the same app.
8. Run the acceptance checklist from the migration plan against the live domain before switching the team over. The Muse version stays as the backup until the checklist passes.

## Security notes

- Hourly rates are owner-only at the API level: the server omits the rate field entirely for other ranks, and non-owner timesheets contain hours only.
- PINs are stored as PBKDF2 hashes; session tokens are stored as SHA-256 hashes.
- Invite codes are one-time and cannot be created for a rank above the creator's rank.
- Reminders and ratings are in-app notifications/tables, matching the current version; there are no push notifications.
