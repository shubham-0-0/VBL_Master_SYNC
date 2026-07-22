# Visit Data Sync Service — Design

**Date:** 2026-07-22
**Status:** Approved

## Purpose

Add a new service that fetches sales **visit data** CSV files from S3, saves the
raw file to local disk, and syncs the parsed rows into a new database table via a
stored procedure. Supports single-date and date-range syncs, and runs
automatically each morning at 5:00 AM.

This mirrors the existing outlet-master S3 sync (`s3Service` →
`s3Controller` → `routes/s3.js` → `cron/jobs.js`) but is a **separate, parallel
flow** — different S3 path, different table, different stored procedure — so the
two are not coupled.

## S3 Source

- **Bucket:** reuse the existing `config.aws.s3.bucket` (`AWS_BUCKET_NAME`).
- **Key prefix:** `project-vega-hr/SPEED/VISIT_DATA/YYYY/MM/DD/`
  where `YYYY`/`MM`/`DD` are zero-padded numeric (e.g. `2026/07/22`).
- **Files:** `.csv`. When multiple files exist under the prefix, pick the one
  with the newest `LastModified`.

## Database Flow

Temp table + stored procedure (same shape as the outlet sync):

1. `TRUNCATE` the visit-data temp table.
2. Batch-insert parsed rows (batch size ~5000 to stay under
   `max_allowed_packet`).
3. `CALL` a stored procedure with an action payload to merge into the main
   reporting table.
4. Wrap in a transaction; commit on success, rollback on error.
5. Apply the same session timeouts / client-side query timeout guard used by the
   outlet sync (30 min) since the SP may process large volumes.

## Components

### `services/visitDataService.js`
- `buildPrefix(dateStr)` → `project-vega-hr/SPEED/VISIT_DATA/YYYY/MM/DD/`.
- `fetchAndSaveVisitData(dateStr)`:
  - List objects under the prefix; filter `.csv`; select newest by
    `LastModified`.
  - Download it; **save the raw file to local disk** under `upload/visit_data/`.
  - Stream-parse the CSV line-by-line (reuse the delimiter-detection + quoted-CSV
    parser from `s3Service`) into row objects.
  - Transform each row via `transformVisitRow()` (placeholder / light
    pass-through until the real mapping is known).
  - Return the array of transformed rows. Return `[]` (and log) if the prefix has
    no files.
- `syncVisitDataToDatabase(rows)`: temp-table truncate → batched insert → SP call,
  inside a transaction with timeouts. Table name, insert columns, SP name and
  action JSON are **placeholders marked `// TODO`**.
- `syncVisitData(dateStr)`: `fetchAndSaveVisitData` then `syncVisitDataToDatabase`
  (skip DB step if no rows).
- `syncVisitDataRange(startDate, endDate)`: validate dates (`YYYY-MM-DD`, end not
  before start); loop day-by-day calling `syncVisitData`; catch per-date errors
  and continue; return `{ startDate, endDate, totalDates, successful, failed,
  results }` — same summary shape as `syncS3DataRange`.
- `resolveLatestVisitDate()`: return today's date string if today's prefix
  contains files, otherwise yesterday's — used by the cron.

### `controllers/visitDataController.js`
- `syncVisitData(req, res)`: read `{ date, startDate, endDate }`; if
  `startDate`+`endDate` present use them, else `date` (default today); always
  delegate to `syncVisitDataRange`; return `{ status, message, summary }`.
  Mirrors `s3Controller`.

### `routes/visitData.js`
- `POST /sync` — body `{ date }` or `{ startDate, endDate }`; delegates to the
  controller.

## Modified Files

- **`config/config.js`** — add a `visitData` block:
  ```js
  visitData: {
    s3Prefix: 'project-vega-hr/SPEED/VISIT_DATA', // + /YYYY/MM/DD/
    tempTable: 'integration_visit_data_temp',     // TODO confirm
    rawDir: 'upload/visit_data',
    keysToStore: [ /* TODO real columns */ ]
  }
  ```
- **`cron/jobs.js`** — add a 5:00 AM daily job (`00 5 * * *`): call
  `resolveLatestVisitDate()`, then `syncVisitData(resolvedDate)`; log start/success/error.
  Update the "cron jobs initialized" summary log.
- **`server.js`** — `app.use('/visit-data', require('./routes/visitData'))`.

## Data Flow

```
cron 5AM / POST /visit-data/sync
        → visitDataController.syncVisitData
        → visitDataService.syncVisitDataRange(start, end)
            → per date: syncVisitData(date)
                → fetchAndSaveVisitData(date)   // S3 list → download → save raw → parse
                → syncVisitDataToDatabase(rows) // temp table → SP
```

Per-date errors are caught and recorded in the results summary without aborting
the whole range.

## Error Handling

- Invalid date format / end-before-start → throw before processing.
- Missing/empty S3 prefix for a date → log warning, return `[]`, skip DB step (not
  a fatal error for the range).
- DB errors → rollback transaction, log, rethrow (caught per-date by the range
  loop).

## Placeholders To Fill Later (marked `// TODO`)

1. Temp table name and its column list.
2. `INSERT` column list.
3. Stored procedure name and action JSON payload.
4. `transformVisitRow()` field mapping (CSV headers → DB columns). Until filled,
   it passes raw CSV columns through unchanged.

## Testing

- Manual: `POST /visit-data/sync` with a single `date` and with a
  `startDate`/`endDate` range; verify raw file saved under `upload/visit_data/`
  and the summary response.
- Verify `resolveLatestVisitDate()` falls back to yesterday when today's prefix is
  empty.
- Cron wiring verified via the initialization log line.
