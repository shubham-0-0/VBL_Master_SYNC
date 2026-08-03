# Visit-Data ORDER_NO Upsert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop truncating `integration_visit_data_temp` by date on every visit-data sync; instead append rows and upsert by `ORDER_NO`, treating a blank `ORDER_NO` as always-insert.

**Architecture:** Add `ORDER_NO` to the configured column list. Replace the per-batch `DELETE FROM ... WHERE VISIT_DT IN (?)` step with a plain `INSERT ... ON DUPLICATE KEY UPDATE` that updates every column except `ORDER_NO`. Coerce blank `ORDER_NO` values to SQL `NULL` before insert so MySQL's unique-key-allows-multiple-NULLs semantics naturally make blank-`ORDER_NO` rows always insert as new rows instead of colliding.

**Tech Stack:** Node.js, `mysql2/promise`, Node's built-in `assert` module for tests (no test framework is configured in this repo).

## Global Constraints

- `config.visitData.insertColumns` and `config.visitData.keysToStore` must stay in the same order as each other (existing repo convention, see comments in `config/config.js:43,49`).
- The DB schema change (adding `ORDER_NO` column + `UNIQUE KEY` on `integration_visit_data_temp`) is being applied by the user directly — do not write a migration script for it.
- Do not touch S3 fetch, CSV parsing/delimiter detection, or the controller/route layer — out of scope per the approved spec.

---

### Task 1: Add ORDER_NO to config

**Files:**
- Modify: `config/config.js:44-48` (`insertColumns`) and `config/config.js:50-54` (`keysToStore`)

**Interfaces:**
- Produces: `config.visitData.insertColumns` and `config.visitData.keysToStore` both include `'ORDER_NO'` at the same array index in both lists.

- [ ] **Step 1: Add `'ORDER_NO'` to both arrays**

In `config/config.js`, change:

```js
    // Order MUST match keysToStore below.
    insertColumns: [
      'DIST_CD', 'SLSMAN_CD', 'VISIT_DT', 'CUST_CD', 'VISIT_ID', 'VISIT_KEY',
      'TIME_IN', 'TIME_OUT', 'TIME_SPENT', 'SLSORD_AMT', 'CSHORD_AMT',
      'VISIT_TYPE', 'VISIT_IND', 'HHT_SUBMIT_DT', 'TIME_OUT_LONG', 'TIME_OUT_LAT'
    ],
    // Order MUST match insertColumns above.
    keysToStore: [
      'DIST_CD', 'SLSMAN_CD', 'VISIT_DT', 'CUST_CD', 'VISIT_ID', 'VISIT_KEY',
      'TIME_IN', 'TIME_OUT', 'TIME_SPENT', 'SLSORD_AMT', 'CSHORD_AMT',
      'VISIT_TYPE', 'VISIT_IND', 'HHT_SUBMIT_DT', 'TIME_OUT_LONG', 'TIME_OUT_LAT'
    ]
```

to:

```js
    // Order MUST match keysToStore below.
    insertColumns: [
      'DIST_CD', 'SLSMAN_CD', 'VISIT_DT', 'CUST_CD', 'VISIT_ID', 'VISIT_KEY',
      'TIME_IN', 'TIME_OUT', 'TIME_SPENT', 'SLSORD_AMT', 'CSHORD_AMT',
      'VISIT_TYPE', 'VISIT_IND', 'HHT_SUBMIT_DT', 'TIME_OUT_LONG', 'TIME_OUT_LAT',
      'ORDER_NO'
    ],
    // Order MUST match insertColumns above.
    keysToStore: [
      'DIST_CD', 'SLSMAN_CD', 'VISIT_DT', 'CUST_CD', 'VISIT_ID', 'VISIT_KEY',
      'TIME_IN', 'TIME_OUT', 'TIME_SPENT', 'SLSORD_AMT', 'CSHORD_AMT',
      'VISIT_TYPE', 'VISIT_IND', 'HHT_SUBMIT_DT', 'TIME_OUT_LONG', 'TIME_OUT_LAT',
      'ORDER_NO'
    ]
```

- [ ] **Step 2: Verify with a quick node check**

Run:
```bash
node -e "const c = require('./config/config'); console.log(c.visitData.insertColumns.includes('ORDER_NO'), c.visitData.keysToStore.includes('ORDER_NO'), c.visitData.insertColumns.length === c.visitData.keysToStore.length)"
```
Expected output: `true true true`

- [ ] **Step 3: Commit**

```bash
git add config/config.js
git commit -m "Add ORDER_NO to visit-data insert columns"
```

---

### Task 2: Add pure helper functions with tests

**Files:**
- Modify: `services/visitDataService.js` (add helpers near the top, after `detectDelimiter`)
- Test: `test/visitDataService.upsert.test.js` (new file, run directly with `node`, no framework)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `normalizeOrderId(value)` — exported from `services/visitDataService.js`. Takes any value; returns `null` if the value is `undefined`, `null`, or (after trimming) an empty string; otherwise returns the value unchanged.
  - `buildUpsertUpdateClause(columns, excludeColumn)` — exported from `services/visitDataService.js`. Takes an array of column-name strings and a column name to exclude (e.g. `'ORDER_NO'`); returns a comma-joined string of `` `col`=VALUES(`col`) `` for every column except the excluded one, preserving input order.

- [ ] **Step 1: Write the failing test**

Create `test/visitDataService.upsert.test.js`:

```js
const assert = require('assert');
const { normalizeOrderId, buildUpsertUpdateClause } = require('../services/visitDataService');

// normalizeOrderId
assert.strictEqual(normalizeOrderId('ORD123'), 'ORD123', 'real value passes through');
assert.strictEqual(normalizeOrderId(''), null, 'empty string becomes null');
assert.strictEqual(normalizeOrderId('   '), null, 'whitespace-only becomes null');
assert.strictEqual(normalizeOrderId(undefined), null, 'undefined becomes null');
assert.strictEqual(normalizeOrderId(null), null, 'null stays null');
assert.strictEqual(normalizeOrderId(0), 0, 'falsy non-string value passes through unchanged');

// buildUpsertUpdateClause
const columns = ['DIST_CD', 'VISIT_ID', 'ORDER_NO'];
const clause = buildUpsertUpdateClause(columns, 'ORDER_NO');
assert.strictEqual(
  clause,
  '`DIST_CD`=VALUES(`DIST_CD`), `VISIT_ID`=VALUES(`VISIT_ID`)',
  'excludes ORDER_NO and formats remaining columns'
);

const clauseNoExclusion = buildUpsertUpdateClause(['A', 'B'], 'NOT_PRESENT');
assert.strictEqual(
  clauseNoExclusion,
  '`A`=VALUES(`A`), `B`=VALUES(`B`)',
  'excluding a column not in the list changes nothing'
);

console.log('All visitDataService upsert helper tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/visitDataService.upsert.test.js`
Expected: `TypeError: normalizeOrderId is not a function` (or similar — the functions don't exist yet)

- [ ] **Step 3: Implement the helpers**

In `services/visitDataService.js`, add after the `detectDelimiter` function (currently ending at line 69):

```js
// Blank ORDER_NO must become SQL NULL, not '', so MySQL's unique-key-allows-
// multiple-NULLs semantics make blank-ORDER_NO rows always insert as new
// rows instead of colliding with each other on the ORDER_NO unique key.
function normalizeOrderId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

// Builds the "col=VALUES(col), ..." clause for ON DUPLICATE KEY UPDATE,
// skipping the unique-key column itself.
function buildUpsertUpdateClause(columns, excludeColumn) {
  return columns
    .filter((col) => col !== excludeColumn)
    .map((col) => `\`${col}\`=VALUES(\`${col}\`)`)
    .join(', ');
}
```

Then add both functions to the `module.exports` block at the bottom of the file (currently lines 333-341):

```js
module.exports = {
  transformVisitRow,
  listVisitDataEntries,
  buildVisitDataPrefix,
  fetchAndSaveVisitData,
  syncVisitDataToDatabase,
  syncVisitData,
  syncVisitDataRange,
  normalizeOrderId,
  buildUpsertUpdateClause
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/visitDataService.upsert.test.js`
Expected: `All visitDataService upsert helper tests passed` printed, exit code 0

- [ ] **Step 5: Commit**

```bash
git add services/visitDataService.js test/visitDataService.upsert.test.js
git commit -m "Add normalizeOrderId and buildUpsertUpdateClause helpers"
```

---

### Task 3: Wire upsert-by-ORDER_NO into syncVisitDataToDatabase

**Files:**
- Modify: `services/visitDataService.js:203-254` (`syncVisitDataToDatabase`)

**Interfaces:**
- Consumes: `normalizeOrderId(value)` and `buildUpsertUpdateClause(columns, excludeColumn)` from Task 2.
- Produces: `syncVisitDataToDatabase(rows)` (signature unchanged) no longer deletes by `VISIT_DT`; it appends and upserts by `ORDER_NO`.

- [ ] **Step 1: Remove the delete-by-VISIT_DT block and change value-building**

In `services/visitDataService.js`, replace:

```js
    await connection.beginTransaction();

    const columns = config.visitData.insertColumns;
    const tempTable = config.visitData.tempTable;

    // Re-syncing a date should replace just that date's rows, not the whole table.
    // Delete by the exact VISIT_DT values present in this batch (whatever format the
    // source CSV uses) rather than a date we format ourselves, so it can't mismatch.
    const visitDates = Array.from(new Set(rows.map((row) => row.VISIT_DT).filter((v) => v !== undefined && v !== null && v !== '')));
    if (visitDates.length > 0) {
      const [deleteResult] = await connection.query(
        `DELETE FROM ${tempTable} WHERE VISIT_DT IN (?)`,
        [visitDates]
      );
      log(`🗑️ Removed ${deleteResult.affectedRows} existing ${tempTable} rows for VISIT_DT in [${visitDates.join(', ')}] before re-insert`);
    }

    const insertQuery = `INSERT INTO ${tempTable} (${columns.join(', ')}) VALUES ?`;
    const values = rows.map((row) => config.visitData.keysToStore.map((key) => row[key] ?? null));
```

with:

```js
    await connection.beginTransaction();

    const columns = config.visitData.insertColumns;
    const tempTable = config.visitData.tempTable;

    // Syncs append/upsert by ORDER_NO rather than truncating by date: a real
    // ORDER_NO updates its existing row on re-sync, while a blank ORDER_NO
    // (stored as NULL) always inserts as a new row, since MySQL unique keys
    // allow multiple NULLs to coexist.
    const updateClause = buildUpsertUpdateClause(columns, 'ORDER_NO');
    const insertQuery = `INSERT INTO ${tempTable} (${columns.join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ${updateClause}`;
    const values = rows.map((row) => config.visitData.keysToStore.map((key) => {
      const value = row[key] ?? null;
      return key === 'ORDER_NO' ? normalizeOrderId(value) : value;
    }));
```

- [ ] **Step 2: Update the per-batch log line to drop delete-specific wording**

The existing loop logs `🗃️ Inserted ${...}/${...} rows into ${tempTable}`; this wording is already accurate for an upsert (it doesn't claim insert-only), so leave it unchanged.

- [ ] **Step 3: Manually verify the generated SQL shape**

Run:
```bash
node -e "
const config = require('./config/config');
const { buildUpsertUpdateClause, normalizeOrderId } = require('./services/visitDataService');
const columns = config.visitData.insertColumns;
const clause = buildUpsertUpdateClause(columns, 'ORDER_NO');
console.log('INSERT INTO ' + config.visitData.tempTable + ' (' + columns.join(', ') + ') VALUES ? ON DUPLICATE KEY UPDATE ' + clause);
console.log('blank ->', normalizeOrderId(''));
console.log('real ->', normalizeOrderId('ORD-9'));
"
```
Expected: prints a single `INSERT ... ON DUPLICATE KEY UPDATE ...` statement whose update clause lists every column except `ORDER_NO`, followed by `blank -> null` and `real -> ORD-9`.

- [ ] **Step 4: Commit**

```bash
git add services/visitDataService.js
git commit -m "Upsert visit-data rows by ORDER_NO instead of truncating by VISIT_DT"
```

---

## Post-plan note (not a task)

Before running a real sync against `integration_visit_data_temp`, the user must apply the schema change described in the spec: add an `ORDER_NO` column and a `UNIQUE KEY` on it. Until that's done, the `ON DUPLICATE KEY UPDATE` clause will insert-only (no unique key to trigger on), which will silently reintroduce duplicate rows on re-sync.
