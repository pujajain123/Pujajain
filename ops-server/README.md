# Umami Studio operations server

The backend for the dashboard in `codex-app/`. It serves the dashboard, stores every record in SQLite,
and enforces sign-in and roles on every request.

## Run it

```sh
npm install
npm run ops            # http://localhost:4100
npm run ops:test       # access-control and account tests
```

On first start with an empty database, the server:

1. loads the exported workspace (`codex-app/seed-data.js`) and the rope workbook (`codex-app/rope_inventory_data.json`), and
2. creates the accounts in `config/initial-users.json` (2 admins, 2 staff) and prints each person's single-use
   set-password link (valid 48 hours). **Put the real emails in that file before the first start.**

Developer commands:

```sh
npm run ops:user -- list
npm run ops:user -- link --email person@company.com        # new set-password link
npm run ops:user -- invite --name "Name" --email x@y.com --role admin
npm run ops:backup                                         # copy of the database to <data dir>/backups
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 4100 | HTTP port |
| `OPS_DATA_DIR` | `data/ops` | Database (`ops.db`) and uploaded photos (`uploads/`). Must be a persistent disk in production. |
| `APP_URL` | request host | Public address used in set-password links |
| `RESEND_API_KEY`, `MAIL_FROM` | — | Send invite/reset emails through Resend. Without them, emails are kept in the `email_outbox` table and admins copy the link from the screen. |
| `OPS_DEMO_DATA` | 1 | `0` skips the sample (DEMO) staff entries on first start |
| `NODE_ENV=production` | — | Secure cookies (HTTPS only) |

## How access works

- **Accounts:** `admin` or `staff`, one unique login each (real email, or a generated `name@umami.app` ID). No public sign-up.
  Accounts are never deleted (a database trigger blocks it); admins disable and enable them.
- **Passwords:** scrypt-hashed with a per-user salt. Generated passwords are shown once and must be changed at first sign-in.
- **Links:** set-password and reset links are random 256-bit tokens, stored only as SHA-256 hashes, single use, 48-hour expiry.
  Issuing a new link cancels the previous one.
- **Sessions:** HttpOnly, SameSite=Lax cookies (Secure in production), stored hashed, revoked on disable, reset or password change.
  Sign-in attempts are throttled.
- **Staff** receive only orders where they have a job, and only their own job sheets within them. They can update progress,
  steps, QC, the job sheet and photos on their own jobs, and add inventory entries. Everything else on an order is rejected.
- **Admins** can do everything, including staff management, settings, the master production tracker and removing demo entries.
- **Inventory** totals change only through ledger transactions, posted by the server. Transactions and activity are append-only
  (except rows flagged as demo data). Every entry records the signed-in user, whatever the browser sends.
- **Conflicts:** each order has a version; a save based on an out-of-date copy is refused and the latest version is loaded.
- **Photos** sent as data URLs are stored as files under `uploads/` and served only to signed-in users.
