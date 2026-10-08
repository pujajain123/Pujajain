# Umami Studios — Operations Platform

Umami Studios' internal system for order lifecycle, production, job sheets, inventory and dispatch. It replaces the Order Detailed, Master Production, Job Sheet, Rope Stock and Fabric Stock spreadsheets with one connected application.

> Every order has a lifecycle: **Received → Reviewed → Being Prepared → Ready for Production → In Production → Quality Check → Ready for Dispatch → Dispatched → Completed**. Orders can also be put **On Hold** or **Cancelled**, and are flagged **Delayed** automatically.

## Quick start

```bash
npm install
npm run dev            # API on :4000 + web on :5173 (first run loads demo data)
```

Open http://localhost:5173. Every demo account uses the password `umami123`.

| Account | Role | What to try |
|---|---|---|
| `admin@umami.studio` | Admin | Dashboard → pipeline → UM-1024 → lifecycle timeline |
| `amit@umami.studio` | Staff (Rope) | Dashboard → open JOB-049 (UM-1024 rope work) → **Save update** |
| `rahul@umami.studio` / `neha@umami.studio` | Staff (Iron / Fabric) | |

Production: `npm run build && npm start` serves the built app and API from one port (`PORT`, default 4000).
`npm run seed` wipes the database and reloads the demo data. `npm test` runs the workflow tests.

| Env var | Default | |
|---|---|---|
| `PORT` | 4000 | |
| `DB_PATH` / `DATA_DIR` | `data/umami.db` / `data/` | SQLite database and uploaded files |
| `APP_TZ` | `Asia/Kolkata` | Defines "today" for deadlines |
| `INSECURE_COOKIES` | — | Set to `1` to run production mode over plain HTTP (local testing only) |

## Browser-only demo

`npm run build:demo` builds `dist-demo/umami-ops.html`, a single self-contained page that runs the same server code (routes, status engine, seed data) in the browser. It uses a pure-JS SQLite build and small stand-ins for Express and Node built-ins, which live in `web/src/demo/`. Data is saved to the viewer's browser storage. The demo is for previewing only: its password hashing is not secure, and file attachments are kept only until the tab closes.

## Stack

- **Server:** Node 22, Express, Zod validation. SQLite through Node's built-in `node:sqlite`, so there are no native modules to install.
- **Web:** React 18 + Vite + React Router, with a hand-built design system in `web/src/styles.css`.
- **Live updates:** every write broadcasts a "topics changed" event over Server-Sent Events, and open screens refetch. A staff update appears on the admin dashboard within a second.
- **Auth:** scrypt password hashes, HttpOnly session cookies, role-based routes. Admin-only endpoints are enforced on the server, not just hidden in the UI.

## Architecture

```text
shared/domain.ts        lifecycle stages, statuses, deadline-risk rules (used by server + web)
server/db.ts            schema (normalised, FK-linked), inventory VIEW, append-only triggers
server/services/
  orders.ts             order summaries (progress, risk, delay, shortage) + STATUS ENGINE (gates, auto-advance, hold, cancel)
  orderOps.ts           order creation wizard backend, order detail, QC, dispatch, checklists, requirements
  jobs.ts               job sheet updates → ledger → order progress → lifecycle → audit → notifications
  inventory.ts          ledger postings, reservations, shortages, auto-allocation on receipt
  notifications.ts      idempotent alert engine (overdue, due soon, shortage, low stock, job past due)
  activity.ts           audit trail
server/routes/          REST API
server/import/          CSV importer for the existing Google Sheets
web/src/pages/          screens (admin + staff)
docs/DATA_MAPPING.md    sheet → field → entity mapping (read this first)
```

### Core rules

- **One source of truth.** Client, product, quantity, deadline and assignee are each stored once. Job sheets, Master Production, dashboards and dispatch all join to them.
- **Stock is a ledger.** Balances are never overwritten: `on_hand = opening + incoming ± adjustments − consumption − wastage`, `available = on_hand − reserved`. Ledger rows are immutable, and corrections are made by posting adjustments.
- **Gated status engine.** Stages cannot be skipped. Ready for Production requires every job to be assigned. Quality Check requires every job sheet to be complete. Ready for Dispatch requires a passed QC. Dispatched requires a dispatch record. Moving back a stage is admin-only and needs a reason. Warnings (e.g. material shortage) must be acknowledged.
- **Automatic propagation.** One staff "Save update":

  ```text
  job sheet → ledger consumption → order progress → stage (auto-start production, auto-QC when all jobs done)
            → Master Production / dashboard (live) → notifications → audit trail
  ```

- **Audit trail.** `activity_logs` and `order_status_history` are append-only, enforced by database triggers. Every field change records old → new, who made it, and when.

## Importing the real spreadsheets

1. Export each Google Sheet tab as CSV.
2. Edit `config/import-mapping.json` so its header names match yours. The defaults are placeholders, and `docs/import-templates/` shows the expected shape.
3. Preview the import with `npm run import -- --orders orders.csv --jobs jobs.csv --rope rope.csv --fabric fabric.csv --dry-run`.
4. Re-run the same command without `--dry-run`.

See [`docs/DATA_MAPPING.md`](docs/DATA_MAPPING.md) for the full field mapping, duplicates, conflicts and automated fields.
