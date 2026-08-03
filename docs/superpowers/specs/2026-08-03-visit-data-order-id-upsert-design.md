# Visit-Data Sync: ORDER_NO Upsert Design

## Problem

`syncVisitDataToDatabase` currently deletes all existing rows for the incoming
batch's `VISIT_DT` values before inserting, so a re-sync of a date
replace-in-places that day's data wholesale. The source CSV will now include
an `ORDER_NO` column, and re-syncs should update existing rows by `ORDER_NO`
instead of wiping and reinserting the whole date.

## Changes

### 1. `config/config.js`

Add `'ORDER_NO'` to both `visitData.insertColumns` and `visitData.keysToStore`
(same position in both, per the existing "order must match" convention).

### 2. `services/visitDataService.js` — `syncVisitDataToDatabase`

- Remove the `DELETE FROM ${tempTable} WHERE VISIT_DT IN (?)` block. Syncs no
  longer truncate by date; they append/upsert.
- When building the row values array, convert a blank/empty `ORDER_NO` to
  `null` (instead of `''`).
- Change the insert statement from:
  `INSERT INTO ${tempTable} (${columns}) VALUES ?`
  to:
  `INSERT INTO ${tempTable} (${columns}) VALUES ? ON DUPLICATE KEY UPDATE <col>=VALUES(<col>), ...`
  listing every column except `ORDER_NO` in the update clause.
- Batching (5000 rows/query) and the surrounding transaction stay unchanged.

### 3. Database (handled by user, not this change)

`integration_visit_data_temp` needs an `ORDER_NO` column with a `UNIQUE KEY`.
MySQL unique keys allow multiple `NULL`s to coexist, so:
- Rows with a real `ORDER_NO` upsert in place on re-sync.
- Rows with a blank `ORDER_NO` (stored as `NULL`) always insert as new rows —
  no special-case code needed for this, it falls out of MySQL's NULL-uniqueness
  semantics.

## Out of scope

- No migration script is written; the user is applying the `ALTER TABLE`
  themselves.
- No changes to S3 fetch, CSV parsing/delimiter detection, or the
  controller/route layer.
