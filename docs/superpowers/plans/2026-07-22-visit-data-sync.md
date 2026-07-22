# Visit Data Sync Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone service that discovers and fetches sales visit-data CSVs from S3 (by dated prefix), saves the raw file locally, and syncs parsed rows into a new table via a stored procedure — with single-date, date-range, and a 5 AM cron entry point.

**Architecture:** A parallel flow mirroring the existing outlet sync (`s3Service → s3Controller → routes/s3.js → cron/jobs.js`), kept fully separate so the two do not couple. New `visitDataService` reuses the shared S3 client config and the CSV streaming/parse approach from `s3Service`; a new controller and route expose it over HTTP; `cron/jobs.js` gains a 5 AM job; `config.js` gains a `visitData` block; `server.js` mounts the route.

**Tech Stack:** Node.js, Express, `@aws-sdk/client-s3`, `mysql2/promise`, `moment`, `node-cron`. CommonJS modules.

## Global Constraints

- **No test framework exists** in this repo (the `npm test` script is a stub, zero test files). Do NOT add Jest/Mocha. Verification is by module-load checks (`node -e "require('./path')"`) and manual endpoint smoke tests, matching the existing codebase convention.
- **CommonJS only** (`require` / `module.exports`), matching every existing file.
- **Reuse existing shared config:** the S3 bucket/credentials come from `config.aws.s3` (do not add new bucket env vars — same bucket).
- **Logging:** use `const { log } = require('../utils/logger')` and the existing emoji-prefixed log style.
- **Placeholders** for unknown schema details (temp table name, insert columns, SP name + action JSON, `transformVisitRow` mapping) must be written as working code with a clearly-marked `// TODO` comment, never left blank. Default `transformVisitRow` is a pass-through of raw CSV columns so the code runs before the mapping is known.
- **S3 prefix format:** `project-vega-hr/SPEED/VISIT_DATA/YYYY/MM/DD/` with zero-padded numeric month/day. Filenames are discovered at runtime via `ListObjectsV2Command` — never hardcoded.

---

## File Structure

- Create `services/visitDataService.js` — S3 discovery/download/parse + DB sync + range loop + cron date resolver.
- Create `controllers/visitDataController.js` — HTTP entry: single date or range → range function.
- Create `routes/visitData.js` — `POST /sync`.
- Modify `config/config.js` — add `visitData` block.
- Modify `server.js` — mount `/visit-data` route.
- Modify `cron/jobs.js` — add 5 AM job.

---

### Task 1: Add `visitData` config block

**Files:**
- Modify: `config/config.js`

**Interfaces:**
- Produces: `config.visitData = { s3PrefixBase, tempTable, rawDir, insertColumns, keysToStore }` consumed by every part of `visitDataService`.

- [ ] **Step 1: Add the config block**

In `config/config.js`, add a new top-level key inside the exported object (place it after the `directories` block). Insert:

```js
  visitData: {
    // Fixed S3 key prefix base; the dated part /YYYY/MM/DD/ is appended at runtime.
    s3PrefixBase: 'project-vega-hr/SPEED/VISIT_DATA',
    // Local directory where the raw downloaded CSV is saved.
    rawDir: 'upload/visit_data',
    // TODO: confirm the real temp table name for visit data.
    tempTable: 'integration_visit_data_temp',
    // TODO: replace with the real DB column list for the temp table INSERT.
    // Order MUST match keysToStore below.
    insertColumns: ['raw_line_no', 'upload_type', 'uploaded_at'],
    // TODO: replace with the real transformed row keys. Order MUST match insertColumns.
    keysToStore: ['raw_line_no', 'upload_type', 'uploaded_at']
  },
```

- [ ] **Step 2: Verify the config loads and the block is present**

Run: `node -e "const c=require('./config/config'); console.log(c.visitData.s3PrefixBase, c.visitData.rawDir, c.visitData.tempTable, Array.isArray(c.visitData.insertColumns), Array.isArray(c.visitData.keysToStore))"`
Expected output: `project-vega-hr/SPEED/VISIT_DATA upload/visit_data integration_visit_data_temp true true`

- [ ] **Step 3: Commit**

```bash
git add config/config.js
git commit -m "Add visitData config block for visit data sync"
```

---

### Task 2: Create `visitDataService.js` — S3 discovery, download, save, parse

**Files:**
- Create: `services/visitDataService.js`

**Interfaces:**
- Consumes: `config.aws.s3`, `config.visitData` (Task 1), `utils/logger.log`.
- Produces:
  - `buildPrefix(dateStr) → string` (e.g. `'project-vega-hr/SPEED/VISIT_DATA/2026/07/22/'`)
  - `transformVisitRow(rowObj, lineNo) → object`
  - `async fetchAndSaveVisitData(dateStr) → Array<object>` (transformed rows; `[]` if no files)

- [ ] **Step 1: Write the module with S3 discovery + CSV parse**

Create `services/visitDataService.js` with exactly this content (DB sync, range, and cron resolver are added in later tasks; the `module.exports` here is temporary and extended later):

```js
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const moment = require('moment');
const config = require('../config/config');
const { log } = require('../utils/logger');

// Reuse the same S3 credentials/region/bucket as the outlet sync.
const s3Client = new S3Client({
  region: config.aws.s3.region,
  credentials: {
    accessKeyId: config.aws.s3.accessKeyId,
    secretAccessKey: config.aws.s3.secretAccessKey
  }
});

// Build the fixed dated key prefix. Month/day are zero-padded numeric.
// Filenames under this prefix are discovered at runtime, never hardcoded.
function buildPrefix(dateStr) {
  const d = moment(dateStr);
  return `${config.visitData.s3PrefixBase}/${d.format('YYYY')}/${d.format('MM')}/${d.format('DD')}/`;
}

// TODO: replace this pass-through with the real CSV-header -> DB-column mapping
// once the visit-data schema is known. Until then, keep raw columns plus metadata
// so the pipeline runs end-to-end.
function transformVisitRow(rowObj, lineNo) {
  const now = new Date();
  return {
    ...rowObj,
    raw_line_no: lineNo,
    upload_type: 'visit_data',
    uploaded_at: now.toISOString().slice(0, 19).replace('T', ' ')
  };
}

// Quoted-CSV line parser (mirrors s3Service).
function parseCsvLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map((s) => s.trim());
}

function detectDelimiter(headerLine) {
  const candidates = [',', '|', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = (headerLine.match(new RegExp(`\\${d}`, 'g')) || []).length;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

async function fetchAndSaveVisitData(dateStr) {
  const prefix = buildPrefix(dateStr);
  log(`🔎 Discovering visit-data files under: ${prefix}`);

  const { Contents } = await s3Client.send(new ListObjectsV2Command({
    Bucket: config.aws.s3.bucket,
    Prefix: prefix
  }));

  const files = (Contents || []).filter((f) => f.Key.endsWith('.csv'));
  if (files.length === 0) {
    log(`⚠️ No CSV files found under ${prefix}`);
    return [];
  }

  // Pick the newest file by LastModified.
  const latestFile = files.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))[0];
  log(`📄 Selected visit-data file: ${latestFile.Key}`);

  const fileObj = await s3Client.send(new GetObjectCommand({
    Bucket: config.aws.s3.bucket,
    Key: latestFile.Key
  }));

  // Save the raw file locally.
  fs.mkdirSync(config.visitData.rawDir, { recursive: true });
  const fileName = path.basename(latestFile.Key);
  const savePath = path.join(config.visitData.rawDir, `${dateStr}_${fileName}`);
  const fileBuffer = await fileObj.Body.transformToByteArray();
  fs.writeFileSync(savePath, Buffer.from(fileBuffer));
  log(`📥 Saved raw visit-data file to ${savePath}`);

  // Stream-parse the CSV line-by-line.
  const transformed = [];
  const CHUNK_SIZE = 10000;
  let processed = 0;
  let headers = null;
  let delimiter = ',';

  const rl = readline.createInterface({
    input: fs.createReadStream(savePath, { encoding: 'utf8' })
  });

  for await (const line of rl) {
    if (!headers) {
      delimiter = detectDelimiter(line);
      log(`🧭 Detected CSV delimiter '${delimiter === '\t' ? 'TAB' : delimiter}' for visit_data`);
      headers = parseCsvLine(line, delimiter);
      continue;
    }
    if (line.trim() === '') continue;
    const values = parseCsvLine(line, delimiter);
    const rowObj = {};
    for (let idx = 0; idx < headers.length; idx++) {
      rowObj[headers[idx]] = values[idx] ?? '';
    }
    transformed.push(transformVisitRow(rowObj, processed + 1));
    processed++;

    if (processed % CHUNK_SIZE === 0) {
      log(`⚙️ Parsed ${processed} visit-data rows (streaming CSV)`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  log(`✅ Parsed ${processed} visit-data rows from ${fileName}`);
  return transformed;
}

module.exports = {
  buildPrefix,
  transformVisitRow,
  fetchAndSaveVisitData
};
```

- [ ] **Step 2: Verify the module loads and `buildPrefix` is correct**

Run: `node -e "const s=require('./services/visitDataService'); console.log(s.buildPrefix('2026-07-22')); console.log(JSON.stringify(s.transformVisitRow({A:'1',B:'2'}, 5)))"`
Expected: first line is `project-vega-hr/SPEED/VISIT_DATA/2026/07/22/`; second line is a JSON object containing `"A":"1","B":"2","raw_line_no":5,"upload_type":"visit_data"` and an `uploaded_at` field.

- [ ] **Step 3: Commit**

```bash
git add services/visitDataService.js
git commit -m "Add visitDataService S3 discovery, download, and CSV parse"
```

---

### Task 3: Add DB sync (temp table + stored procedure) to `visitDataService.js`

**Files:**
- Modify: `services/visitDataService.js`

**Interfaces:**
- Consumes: `config.mysql`, `config.visitData.tempTable`, `config.visitData.insertColumns`, `config.visitData.keysToStore`.
- Produces: `async syncVisitDataToDatabase(rows) → void`

- [ ] **Step 1: Add the DB sync function and export it**

In `services/visitDataService.js`, add this constant and function **above** the `module.exports`:

```js
// Allow the stored procedure plenty of time on large volumes (mirrors s3Service).
const SYNC_QUERY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function syncVisitDataToDatabase(rows) {
  const connection = await mysql.createConnection({
    ...config.mysql,
    connectTimeout: 30 * 1000
  });

  try {
    const sessionTimeoutSecs = Math.ceil(SYNC_QUERY_TIMEOUT_MS / 1000);
    await connection.query(
      `SET SESSION wait_timeout = ${sessionTimeoutSecs},
                   net_read_timeout = ${sessionTimeoutSecs},
                   net_write_timeout = ${sessionTimeoutSecs}`
    );

    await connection.beginTransaction();

    // TODO: confirm tempTable name in config.visitData.tempTable.
    await connection.query(`TRUNCATE TABLE ${config.visitData.tempTable}`);
    log(`🗑️ Cleared ${config.visitData.tempTable} before inserting new visit data`);

    // TODO: insertColumns / keysToStore in config must match the real table schema.
    const columns = config.visitData.insertColumns;
    const insertQuery = `INSERT INTO ${config.visitData.tempTable} (${columns.join(', ')}) VALUES ?`;
    const values = rows.map((row) => config.visitData.keysToStore.map((key) => row[key] ?? null));

    const INSERT_BATCH_SIZE = 5000;
    for (let i = 0; i < values.length; i += INSERT_BATCH_SIZE) {
      const batch = values.slice(i, i + INSERT_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop
      await connection.query(insertQuery, [batch]);
      log(`🗃️ Inserted ${Math.min(i + batch.length, values.length)}/${values.length} rows into ${config.visitData.tempTable}`);
    }

    // TODO: replace with the real stored procedure name and action payload for visit data.
    const obj = { action: 'VISIT_DATA' };
    const [procedureResults] = await connection.query({
      sql: `CALL sp_sync_attendance_master('${JSON.stringify(obj)}')`,
      timeout: SYNC_QUERY_TIMEOUT_MS
    });
    log(`📊 Visit-data stored procedure result: ${JSON.stringify(procedureResults)}`);

    await connection.commit();
    log('✅ Visit-data transaction committed successfully');
  } catch (err) {
    await connection.rollback();
    log(`❌ Visit-data DB error: ${err.message}. Transaction rolled back.`);
    throw err;
  } finally {
    await connection.end();
  }
}
```

Then update `module.exports` to include the new function:

```js
module.exports = {
  buildPrefix,
  transformVisitRow,
  fetchAndSaveVisitData,
  syncVisitDataToDatabase
};
```

- [ ] **Step 2: Verify the module still loads and the export exists**

Run: `node -e "const s=require('./services/visitDataService'); console.log(typeof s.syncVisitDataToDatabase)"`
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add services/visitDataService.js
git commit -m "Add visit-data DB sync via temp table and stored procedure"
```

---

### Task 4: Add `syncVisitData`, `syncVisitDataRange`, and `resolveLatestVisitDate`

**Files:**
- Modify: `services/visitDataService.js`

**Interfaces:**
- Consumes: `fetchAndSaveVisitData` (Task 2), `syncVisitDataToDatabase` (Task 3), `buildPrefix` (Task 2), `s3Client`, `config`.
- Produces:
  - `async syncVisitData(dateStr) → void`
  - `async syncVisitDataRange(startDate, endDate) → { startDate, endDate, totalDates, successful, failed, results }`
  - `async resolveLatestVisitDate() → string` (`YYYY-MM-DD`)

- [ ] **Step 1: Add the three functions and export them**

In `services/visitDataService.js`, add above `module.exports`:

```js
async function syncVisitData(dateStr) {
  try {
    const rows = await fetchAndSaveVisitData(dateStr);
    if (rows.length > 0) {
      await syncVisitDataToDatabase(rows);
    } else {
      log('⚠️ No visit data to insert; skipping DB sync.');
    }
  } catch (error) {
    log(`❌ Error in visit-data sync for ${dateStr}: ${error.message}`);
    throw error;
  }
}

async function syncVisitDataRange(startDate, endDate) {
  const start = moment(startDate);
  const end = moment(endDate);

  if (!start.isValid() || !end.isValid()) {
    throw new Error('Invalid date format. Please use YYYY-MM-DD');
  }
  if (end.isBefore(start)) {
    throw new Error('endDate must be after startDate');
  }

  log(`🔄 Starting visit-data sync for date range: ${startDate} to ${endDate}`);

  const results = [];
  const currentDate = start.clone();
  let totalProcessed = 0;
  let totalErrors = 0;

  while (currentDate.isSameOrBefore(end)) {
    const dateStr = currentDate.format('YYYY-MM-DD');
    log(`📅 Processing visit-data date: ${dateStr}`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await syncVisitData(dateStr);
      totalProcessed++;
      results.push({ date: dateStr, status: 'success', message: `Successfully synced visit data for ${dateStr}` });
      log(`✅ Successfully processed visit-data date: ${dateStr}`);
    } catch (error) {
      totalErrors++;
      results.push({ date: dateStr, status: 'error', message: error.message });
      log(`❌ Error processing visit-data date ${dateStr}: ${error.message}`);
    }
    currentDate.add(1, 'days');
  }

  log(`✅ Visit-data range sync completed. Processed: ${totalProcessed}, Errors: ${totalErrors}`);

  return {
    startDate,
    endDate,
    totalDates: results.length,
    successful: totalProcessed,
    failed: totalErrors,
    results
  };
}

// Prefer today's date if its S3 prefix contains files, else fall back to yesterday.
async function resolveLatestVisitDate() {
  const today = moment().format('YYYY-MM-DD');
  const yesterday = moment().subtract(1, 'days').format('YYYY-MM-DD');
  try {
    const { Contents } = await s3Client.send(new ListObjectsV2Command({
      Bucket: config.aws.s3.bucket,
      Prefix: buildPrefix(today)
    }));
    const hasToday = (Contents || []).some((f) => f.Key.endsWith('.csv'));
    if (hasToday) {
      log(`🗓️ Visit-data: today's folder (${today}) has files; using ${today}`);
      return today;
    }
    log(`🗓️ Visit-data: today's folder (${today}) empty; falling back to ${yesterday}`);
    return yesterday;
  } catch (error) {
    log(`⚠️ Visit-data: could not check today's folder (${error.message}); falling back to ${yesterday}`);
    return yesterday;
  }
}
```

Then replace `module.exports` with:

```js
module.exports = {
  buildPrefix,
  transformVisitRow,
  fetchAndSaveVisitData,
  syncVisitDataToDatabase,
  syncVisitData,
  syncVisitDataRange,
  resolveLatestVisitDate
};
```

- [ ] **Step 2: Verify all exports are present and range validation works**

Run: `node -e "const s=require('./services/visitDataService'); console.log(['syncVisitData','syncVisitDataRange','resolveLatestVisitDate'].map(k=>typeof s[k]).join(',')); s.syncVisitDataRange('2026-07-10','2026-07-01').then(()=>console.log('no-throw')).catch(e=>console.log('threw:',e.message))"`
Expected output: `function,function,function` then `threw: endDate must be after startDate`

- [ ] **Step 3: Commit**

```bash
git add services/visitDataService.js
git commit -m "Add visit-data single, range, and cron date-resolver functions"
```

---

### Task 5: Create the controller

**Files:**
- Create: `controllers/visitDataController.js`

**Interfaces:**
- Consumes: `visitDataService.syncVisitDataRange` (Task 4), `moment`, `log`.
- Produces: `syncVisitData(req, res)` Express handler.

- [ ] **Step 1: Write the controller**

Create `controllers/visitDataController.js`:

```js
const moment = require('moment');
const visitDataService = require('../services/visitDataService');
const { log } = require('../utils/logger');

const syncVisitData = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.body || {};

    let rangeStart;
    let rangeEnd;
    if (startDate && endDate) {
      rangeStart = startDate;
      rangeEnd = endDate;
    } else {
      rangeStart = rangeEnd = date || moment().format('YYYY-MM-DD');
    }

    log(`🔄 Starting visit-data sync for date range: ${rangeStart} to ${rangeEnd}...`);
    const result = await visitDataService.syncVisitDataRange(rangeStart, rangeEnd);

    res.json({
      status: 'success',
      message: `Visit-data sync completed for date range ${rangeStart} to ${rangeEnd}`,
      summary: result
    });
  } catch (error) {
    log(`❌ Visit-data sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

module.exports = {
  syncVisitData
};
```

- [ ] **Step 2: Verify the controller loads**

Run: `node -e "const c=require('./controllers/visitDataController'); console.log(typeof c.syncVisitData)"`
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add controllers/visitDataController.js
git commit -m "Add visit-data controller"
```

---

### Task 6: Create the route

**Files:**
- Create: `routes/visitData.js`

**Interfaces:**
- Consumes: `visitDataController.syncVisitData` (Task 5).
- Produces: an Express router with `POST /sync`.

- [ ] **Step 1: Write the route**

Create `routes/visitData.js`:

```js
const express = require('express');
const router = express.Router();
const { syncVisitData } = require('../controllers/visitDataController');
const { log } = require('../utils/logger');

// Single date OR date range in the body. The controller normalizes both.
router.post('/sync', async (req, res) => {
  const { date, startDate, endDate } = req.body || {};
  if (startDate && endDate) {
    log(`🔄 Starting visit-data sync for date range: ${startDate} to ${endDate}...`);
  } else {
    log(`🔄 Starting visit-data sync${date ? ` for date: ${date}` : ''}...`);
  }
  await syncVisitData(req, res);
});

module.exports = router;
```

- [ ] **Step 2: Verify the route loads**

Run: `node -e "const r=require('./routes/visitData'); console.log(typeof r)"`
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add routes/visitData.js
git commit -m "Add visit-data route"
```

---

### Task 7: Mount the route in `server.js`

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `routes/visitData.js` (Task 6).

- [ ] **Step 1: Import and mount the route**

In `server.js`, after the line `const distributorRoutes = require('./routes/distributor');` add:

```js
const visitDataRoutes = require('./routes/visitData');
```

And after the line `app.use('/distributor', distributorRoutes);` add:

```js
app.use('/visit-data', visitDataRoutes);
```

- [ ] **Step 2: Verify server module parses without runtime errors**

Run: `node -e "require('./routes/visitData'); require('./routes/distributor'); require('./routes/s3'); require('./routes/health'); console.log('routes ok')"`
Expected output: `routes ok`

(Note: do not `require('./server.js')` directly — it calls `app.listen` and binds a port. The route-load check above is sufficient to confirm the wiring imports resolve.)

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Mount /visit-data route in server"
```

---

### Task 8: Add the 5 AM cron job

**Files:**
- Modify: `cron/jobs.js`

**Interfaces:**
- Consumes: `visitDataService.syncVisitData` and `visitDataService.resolveLatestVisitDate` (Task 4).

- [ ] **Step 1: Import the visit-data functions**

In `cron/jobs.js`, after the line `const { syncDataRange } = require('../services/distributorService');` add:

```js
const { syncVisitData, resolveLatestVisitDate } = require('../services/visitDataService');
```

- [ ] **Step 2: Add the 5 AM job**

In `cron/jobs.js`, inside `initializeCronJobs()`, after the Distributor `cron.schedule('30 06 * * *', ...)` block and before the `log('⏰ Cron jobs initialized:')` line, add:

```js
  // Schedule Visit Data sync at 5 AM daily.
  cron.schedule('00 5 * * *', async () => {
    try {
      log('🕔 Running scheduled Visit Data sync at 5 AM');
      // Prefer today's data if available, else yesterday's (whichever is latest).
      const targetDate = await resolveLatestVisitDate();
      await syncVisitData(targetDate);
      log(`✅ Scheduled Visit Data sync completed successfully for ${targetDate}`);
    } catch (error) {
      log(`❌ Scheduled Visit Data sync error: ${error.message}`);
    }
  });
```

- [ ] **Step 3: Update the initialization summary log**

In `cron/jobs.js`, change the summary log block from:

```js
  log('⏰ Cron jobs initialized:');
  log('   - S3 Sync: Daily at 7:00 AM');
  log('   - Distributor Sync: Daily at 6:30 AM');
```

to:

```js
  log('⏰ Cron jobs initialized:');
  log('   - S3 Sync: Daily at 7:00 AM');
  log('   - Distributor Sync: Daily at 6:30 AM');
  log('   - Visit Data Sync: Daily at 5:00 AM');
```

- [ ] **Step 4: Verify the cron module loads**

Run: `node -e "const { initializeCronJobs } = require('./cron/jobs'); console.log(typeof initializeCronJobs)"`
Expected output: `function`

- [ ] **Step 5: Commit**

```bash
git add cron/jobs.js
git commit -m "Add 5 AM visit-data sync cron job"
```

---

## Final Verification (manual smoke test)

These require live AWS/DB credentials and are run by the user, not in CI:

1. Start the server: `npm run dev`. Confirm the log shows `- Visit Data Sync: Daily at 5:00 AM`.
2. Single date: `curl -X POST localhost:3001/visit-data/sync -H 'Content-Type: application/json' -d '{"date":"2026-07-22"}'`. Confirm a raw file appears under `upload/visit_data/` and the JSON response has a `summary`.
3. Date range: `curl -X POST localhost:3001/visit-data/sync -H 'Content-Type: application/json' -d '{"startDate":"2026-07-20","endDate":"2026-07-22"}'`. Confirm the summary lists three dates.
4. Fill in the `// TODO` placeholders (temp table name, `insertColumns`, `keysToStore`, SP name/action, `transformVisitRow` mapping) once the real visit-data schema is known.

---

## Self-Review Notes

- **Spec coverage:** S3 discovery by dated prefix (Task 2) ✓; save raw locally (Task 2) ✓; temp-table + SP sync (Task 3) ✓; single date + range (Tasks 4–6) ✓; 5 AM cron with today→yesterday fallback (Tasks 4, 8) ✓; config block (Task 1) ✓; route mount (Task 7) ✓; placeholders marked (Tasks 1–3) ✓.
- **Type consistency:** `insertColumns`/`keysToStore` used consistently between config (Task 1) and DB sync (Task 3); function names (`syncVisitData`, `syncVisitDataRange`, `resolveLatestVisitDate`, `fetchAndSaveVisitData`, `syncVisitDataToDatabase`) consistent across service, controller, and cron.
- **No test framework:** verification uses module-load + manual smoke tests per repo convention (stated in Global Constraints).
