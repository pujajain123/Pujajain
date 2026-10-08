# Spreadsheet → database mapping

> **Status: ASSUMED — verify against the real sheets.**
> The five source spreadsheets (Order Detailed, Master Production, Job Sheet, Rope Stock, Fabric Stock) were not available in the repository or the connected Google Drive when this was built. The mapping below comes from the fields described in the project brief plus standard practice for rope-and-fabric outdoor furniture production. Every column name is a placeholder until it is checked against the real sheets.
>
> **To verify:** export each sheet as CSV and compare its headers with the tables below. Then edit `config/import-mapping.json`, which is the only file that needs to change, and run `npm run import -- … --dry-run`. The importer prints exactly what it would create. Any column missing from this document is a gap to add, either as a process-specific Job Sheet field (Settings → Processes, no code change needed) or as a schema column.

## 1. How the sheets map to the model

```text
ORDER DETAILED SHEET ─┐
                      ├─► customers · orders · order_items · order_status_history · attachments
MASTER PRODUCTION ────┘        (master production becomes a computed VIEW, not stored data)

JOB SHEET ─────────────► jobs · job_updates · staff_assignments · material_requirements
                               (+ process-specific fields in jobs.specs_json, defined per process)

ROPE STOCK SHEET ──────┐
                       ├─► materials · inventory_transactions (opening / incoming / consumption / wastage)
FABRIC STOCK SHEET ────┘        (balances are a VIEW over the ledger; never typed in)
```

Every sheet repeats some columns (client, product, quantity, deadline). The rebuild stores each of these exactly once:

| Fact | Single source of truth | Shown in (derived, never re-entered) |
|---|---|---|
| Client name and contact | `customers` | Order, Master Production, Job Sheets, Dashboard, Dispatch, Search |
| Order ID | `orders.code` | Everywhere |
| Product, size, colour, finish | `order_items` → `products` | Order, Job Sheets, Master Production |
| Quantity | `order_items.quantity` (job quantity defaults to it) | Order card, Job Sheets, Dispatch |
| Deadline / Sky date | `orders.deadline`, `orders.sky_date` | Master Production, Job Sheets, Dashboard, alerts |
| Assigned staff | `jobs.assigned_to` (history in `staff_assignments`) | Order card, Master Production, My Jobs |
| Production % | **computed** from `jobs.completed_qty / quantity` | Order, Master Production, Dashboard |
| Current stage | `orders.stage` (history in `order_status_history`) | Pipeline, cards, timeline |
| Stock balance | **computed** from `inventory_transactions` | Inventory, Order material readiness, Job Sheet |

## 2. Field-by-field mapping

Legend: **Who enters**: A = Admin, S = Staff, Sys = system-calculated. **Edit**: who can change it later. *Assumed header* is the placeholder used in `config/import-mapping.json`.

### 2.1 Order Detailed Sheet

| Assumed header | Type | Purpose | New entity.field | Source of truth | Who enters | Edit | Appears in | Calculated? |
|---|---|---|---|---|---|---|---|---|
| Order ID | text `UM-####` | Order identity | `orders.code` | orders | Sys (next number) / import | — (immutable) | everywhere | Auto-numbered for new orders |
| Client Name | text | Customer | `customers.name` via `orders.customer_id` | customers | A | A (Settings → Clients) | everywhere | — |
| Contact Person | text | Who to call | `customers.contact_person` | customers | A | A | Order › Received, Dispatch | — |
| Contact Number | text | Phone | `customers.phone` | customers | A | A | Order › Received | — |
| Email | text | Email | `customers.email` | customers | A | A | Order › Received | — |
| Address / City | text | Delivery address | `customers.address`, `customers.city`; order-specific override `orders.delivery_address` | customers / orders | A | A | Order, Dispatch | — |
| PO Number | text | Client reference | `orders.po_number` | orders | A | A | Order header, search | — |
| Order Source | text | Lead channel | `orders.source` | orders | A | A | Order › Received, reports | — |
| Product | text | What is being made | `order_items.product_id` → `products` | products | A | A | everywhere | — |
| Quantity | int | Units ordered | `order_items.quantity` | order_items | A | A | everywhere | Job quantity copied from it |
| Size / Colour / Finish / Specifications | text | Variant details | `order_items.dimensions / color / finish / specifications` | order_items | A | A | Order, Job Sheets | Size defaults from product |
| Order Date | date | When received | `orders.order_date` | orders | A | A | Order, reports | — |
| Delivery Date | date | Client deadline | `orders.deadline` | orders | A | A (audited) | everywhere | Days left / risk computed |
| Priority | enum | Urgency | `orders.priority` (low/normal/high/urgent) | orders | A | A | cards, filters | — |
| Status | text | Where the order is | `orders.stage` + `order_status_history` | status engine | Sys / A (gated) | A via transitions only | everywhere | Auto-advances on job/QC/dispatch events |
| Remarks | text | Notes | `orders.notes`; later notes → `activity_logs` | orders | A/S | A | Order | — |
| *(attachments / drawings)* | file | POs, drawings, invoices | `attachments` | attachments | A/S | — | Order › Attachments | — |

### 2.2 Master Production Sheet

The Master Production Sheet is mostly a summary of other sheets, so it becomes a computed view (`/production`) and is not stored as its own table.

| Assumed header | Type | New home | Stored or derived | Notes |
|---|---|---|---|---|
| Order ID, Client, Product, Qty, Order Date | — | joined from orders/customers/items | Derived | Previously copied by hand, which caused **duplication and conflicts** |
| Sky Date | date | `orders.sky_date` | Stored | Internal target date ahead of the client deadline. Job due dates are planned inside it |
| Deadline | date | `orders.deadline` | Stored | **Conflict risk:** the Order Detailed sheet also has a delivery date. On import the Master value wins (it is usually the more current one) |
| Current Stage | text | `orders.stage` | Stored by status engine | Mapped through `status_map` |
| Iron Work / Rope Work / Fabric Work | text/% | `jobs` (one per process) | Derived from job sheets | Becomes progress bars with status icons |
| Overall Progress | % | — | **Derived** | Σ completed ÷ Σ quantity across jobs |
| Assigned Staff | text | `jobs.assigned_to` | Derived | Per process, not per order |
| Delay / Remarks | text | `jobs.delay_reason`, activity log | Derived + stored | Delay is computed (overdue, past sky date, job past due, marked delayed) |

### 2.3 Job Sheet

Common fields are columns on `jobs`. Process-specific fields live in `jobs.specs_json`. They are defined per process in `job_processes.fields_json` and can be edited in Settings → Processes without code changes.

| Assumed header | Type | New entity.field | Who enters | Edit | Calculated? |
|---|---|---|---|---|---|
| Job ID | text `JOB-###` | `jobs.code` | Sys | — | Auto |
| Order ID / Client / Product | — | via `jobs.order_id`, `order_item_id` | Sys | — | **Derived** (no re-entry) |
| Process | enum | `jobs.process_id` → `job_processes` | A | — | One job per item × process (unique) |
| Assigned To | user | `jobs.assigned_to` + `staff_assignments` history | A | A | — |
| Qty | int | `jobs.quantity` | Sys (from order) | A | Defaults to order quantity |
| Completed | int | `jobs.completed_qty`; every change → `job_updates` | S | S (up only) / A | Remaining and % derived |
| Start Date / Target Date | date | `jobs.start_date`, `jobs.due_date` | A | A | Pre-planned in the order wizard |
| (actual start / finish) | timestamp | `jobs.started_at`, `jobs.completed_at` | Sys | — | Set automatically from updates |
| Status | enum | `jobs.status` (not_started/in_progress/on_hold/completed/delayed) | S | S/A | Derived from qty unless On hold / Delayed |
| Delay reason | text | `jobs.delay_reason` | S | S/A | Required when Delayed |
| Material / Material Required | ref + qty | `material_requirements` (order × process × material) | A | A | Pre-filled = per-unit × qty × 1.05 |
| Material Used | qty | `inventory_transactions` type `consumption` (job + order linked) | S | — (ledger; corrections via adjustment) | Job/Order "consumed" and stock derived |
| Wastage | qty | `inventory_transactions` type `wastage` | S | — | Wastage % in reports |
| Notes | text | `jobs.notes` + `job_updates.note` | S/A | S/A | — |

**Process-specific fields (default set, assumed):**

| Iron Work | Rope Work | Fabric Work |
|---|---|---|
| Frame design / drawing ref | Rope type | Fabric type |
| Metal (MS / SS 304 / Aluminium / GI) | Rope colour | Fabric code / shade |
| Pipe / section size | Thickness (mm) | Cushion size |
| Frame dimensions | Weave pattern | Foam / filling |
| Welding type | Rope per unit (kg) | Cushion thickness (mm) |
| Finish, powder-coat colour | Weaver team / karigar | Fabric per unit (m) |
| Frame weight / unit | Piece rate (₹/unit) | Stitching, removable cover |
| Workshop / vendor | | Tailor |

### 2.4 Rope Stock Sheet and Fabric Stock Sheet

| Assumed header | Type | New entity.field | Who enters | Calculated? |
|---|---|---|---|---|
| Item Code | text | `materials.code` | A | — |
| Item / Type / Colour | text | `materials.name`, `variant`, `color` | A | — |
| Unit | kg / m | `materials.unit` | A | — |
| Current Stock | qty | **Not stored.** Imported once as an `opening` transaction | Sys | `on_hand` = opening + incoming ± adjustments − consumption − wastage |
| Received / Inward | qty + date | `inventory_transactions` type `incoming` (+ `material_incoming` while expected) | A/S | — |
| Issued / Used | qty + date | `inventory_transactions` type `consumption` with order and job | S (from job sheet) | — |
| Wastage | qty | `inventory_transactions` type `wastage` | S | — |
| Min Stock | qty | `materials.reorder_level` | A | Low-stock alert when available < reorder level |
| Supplier / Location | text | `materials.supplier`, `location` | A | — |
| Reserved for orders | — | `allocation` / `release` transactions | Sys (on Preparing) | `reserved`, `available` derived |

## 3. Issues the mapping resolves

**Duplicate fields:** client, product, quantity and deadline appear in 3–4 sheets. They are now stored once, and every other screen joins to them.

**Conflicting information:** the delivery date (Order sheet) and the deadline (Master sheet) can disagree, and so can status (Master) and per-process status (Job Sheet). The rebuild has one deadline. Status is driven by job data, which makes a status of "In Production" with all jobs at 100% impossible: the order moves to Quality Check automatically.

**Derived fields that should not be typed in:** overall progress, stock balance, days left, deadline risk, delayed flag, remaining quantity, material remaining.

**Missing relationships:** material usage was not linked to an order or job. Now every consumption row carries `order_id` and `job_id`, so the system can answer "what material did UM-1024 use?" Staff assignment history was also missing; it is now in `staff_assignments`.

**Fields that are now automated:**

| Field | How it is automated |
|---|---|
| Job creation | Generated from the order's product processes |
| Job start and completion timestamps | Set from staff updates |
| Order progress | Recalculated from the jobs |
| Stage changes | Production starts on the first job update. Quality Check starts when all jobs are done. Ready for Dispatch follows a passed QC. Dispatched follows a recorded dispatch |
| Material reservation | Made when the order enters Being Prepared, and re-run when stock arrives |
| Alerts | Overdue, due soon, shortage, low stock, job past due, job completed |
| Audit trail | Every change is logged |

## 4. Importer behaviour (`npm run import`)

1. Stock sheets → `materials` and an `opening` ledger entry for the current balance.
2. Order Detailed + Master Production (joined on Order ID) → customer (matched by name), product (matched by name, created if new), order, item, and one job per process found in the Job Sheet.
3. Job Sheet rows → assignee (matched by name; staff accounts are created if missing, with a random password), dates, completed qty, status, process-specific fields, material requirement, and material used (posted as `consumption`).
4. Sheet status → lifecycle stage via `status_map`, with a history entry noting the import.
5. The import runs in one transaction. `--dry-run` previews it, and any error rolls it back.

After importing orders that are already mid-production, open each order and press **Reserve stock**. The importer records what was consumed, but it does not reserve what is still to be used.
