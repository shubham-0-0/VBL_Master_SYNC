const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const moment = require('moment');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { archiveFileToBlob, deleteLocalFile } = require('../utils/fileCleanup');

// Reuse the same S3 credentials/region/bucket as the outlet sync.
const s3Client = new S3Client({
  region: config.aws.s3.region,
  credentials: {
    accessKeyId: config.aws.s3.accessKeyId,
    secretAccessKey: config.aws.s3.secretAccessKey
  }
});

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

// Blank ORDER_NO must become SQL NULL, not '', for consistent storage.
function normalizeOrderId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

async function listVisitDataEntries(basePrefix) {
  const normalizedBasePrefix = `${basePrefix.replace(/\/$/, '')}/`;
  const allObjects = [];
  let continuationToken;

  do {
    // List the full VISIT_DATA tree so the debug output is not tied to a specific date folder.
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: config.aws.s3.bucket,
      Prefix: normalizedBasePrefix,
      ContinuationToken: continuationToken
    }));
    allObjects.push(...(response.Contents || []));
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  const folderNames = Array.from(new Set(
    allObjects
      .map((item) => item.Key || '')
      .filter((key) => key.startsWith(normalizedBasePrefix) && key !== normalizedBasePrefix)
      .map((key) => key.slice(normalizedBasePrefix.length))
      .filter(Boolean)
      .flatMap((relativeKey) => {
        const parts = relativeKey.split('/').slice(0, -1);
        const folders = [];
        let currentPath = '';
        for (const part of parts) {
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          folders.push(currentPath);
        }
        return folders;
      })
  )).sort();

  const fileNames = allObjects
    .map((item) => item.Key || '')
    .filter((key) => key.startsWith(normalizedBasePrefix) && key !== normalizedBasePrefix && !key.endsWith('/'))
    .map((key) => key.slice(normalizedBasePrefix.length))
    .filter(Boolean)
    .sort();

  return {
    folderNames,
    fileNames,
    objects: allObjects
  };
}

// Builds the dated S3 prefix for a given YYYY-MM-DD date, e.g. SPEED/VISIT_DATA/2026/07/29
function buildVisitDataPrefix(dateStr) {
  const parsed = moment(dateStr, 'YYYY-MM-DD', true);
  if (!parsed.isValid()) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYY-MM-DD.`);
  }
  return `${config.visitData.s3PrefixBase}/${parsed.format('YYYY/MM/DD')}`;
}

async function fetchAndSaveVisitData(dateStr) {
  const datePrefix = buildVisitDataPrefix(dateStr);
  log(`🔎 Listing visit-data entries under: ${datePrefix}/`);
  const { fileNames, objects } = await listVisitDataEntries(datePrefix);
  console.log(`VISIT_DATA filenames for ${dateStr}:`, fileNames);
  const files = (objects || []).filter((f) => (f.Key || '').toLowerCase().endsWith('.csv'));

  if (files.length === 0) {
    log(`⚠️ No CSV files found under ${datePrefix}/ for date ${dateStr}`);
    return { rows: [], fileKey: null, fileName: null, dateStr };
  }

  // Multiple files can land in the same day's folder; pick the newest by LastModified.
  const latestFile = files.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))[0];
  log(`📄 Selected visit-data file for ${dateStr}: ${latestFile.Key}`);

  const fileObj = await s3Client.send(new GetObjectCommand({
    Bucket: config.aws.s3.bucket,
    Key: latestFile.Key
  }));

  // Save the raw file locally.
  fs.mkdirSync(config.visitData.rawDir, { recursive: true });
  const fileName = path.basename(latestFile.Key);
  const savePath = path.join(config.visitData.rawDir, `${Date.now()}_${fileName}`);
  const fileBuffer = await fileObj.Body.transformToByteArray();
  fs.writeFileSync(savePath, Buffer.from(fileBuffer));
  log(`📥 Saved raw visit-data file to ${savePath}`);

  // Stream-parse the CSV line-by-line.
  const transformed = [];
  const CHUNK_SIZE = 10000;
  let processed = 0;
  let headers = null;
  let delimiter = ',';

  try {
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
  } finally {
    // Archive the raw file to blob storage (if enabled) before removing the local
    // working copy - flipping the flag off later never touches earlier archives,
    // since only this exact local path is ever deleted.
    if (config.storage.visitData.enabled) {
      const blobDir = path.join(config.storage.basePath, config.storage.visitData.folder, dateStr);
      try {
        const archivedPath = archiveFileToBlob(savePath, blobDir, fileName);
        log(`📦 Archived visit-data file to ${archivedPath}`);
      } catch (archiveError) {
        log(`⚠️ Failed to archive visit-data file: ${archiveError.message}`);
      }
    }
    deleteLocalFile(savePath);
  }

  return {
    rows: transformed,
    fileKey: latestFile.Key,
    fileName
  };
}

// integration_visit_data_temp is the reporting table itself (not a staging table
// for a stored procedure), so syncs must append/replace-in-place rather than wipe it.
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

    const columns = config.visitData.insertColumns;
    const tempTable = config.visitData.tempTable;

    // Plain append insert: ORDER_NO carries no unique key, so re-syncing the
    // same rows inserts them again rather than updating in place.
    const insertQuery = `INSERT INTO ${tempTable} (${columns.join(', ')}) VALUES ?`;
    const values = rows.map((row) => config.visitData.keysToStore.map((key) => {
      const value = row[key] ?? null;
      return key === 'ORDER_NO' ? normalizeOrderId(value) : value;
    }));

    const INSERT_BATCH_SIZE = 5000;
    for (let i = 0; i < values.length; i += INSERT_BATCH_SIZE) {
      const batch = values.slice(i, i + INSERT_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop
      await connection.query(insertQuery, [batch]);
      log(`🗃️ Inserted ${Math.min(i + batch.length, values.length)}/${values.length} rows into ${tempTable}`);
    }

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

async function syncVisitData(dateStr) {
  const targetDate = dateStr || moment().format('YYYY-MM-DD');
  try {
    const { rows, fileKey, fileName } = await fetchAndSaveVisitData(targetDate);
    if (rows.length > 0) {
      await syncVisitDataToDatabase(rows);
      return {
        date: targetDate,
        selectedFile: fileKey,
        fileName,
        rowCount: rows.length
      };
    } else {
      log(`⚠️ No visit data to insert for ${targetDate}; skipping DB sync.`);
      return {
        date: targetDate,
        selectedFile: null,
        fileName: null,
        rowCount: 0
      };
    }
  } catch (error) {
    log(`❌ Error in visit-data sync for ${targetDate}: ${error.message}`);
    throw error;
  }
}

async function syncVisitDataRange(startDate, endDate) {
  const start = moment(startDate, 'YYYY-MM-DD', true);
  const end = moment(endDate, 'YYYY-MM-DD', true);

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
      const summary = await syncVisitData(dateStr);
      totalProcessed++;
      results.push({ date: dateStr, status: 'success', ...summary });
      log(`✅ Successfully processed visit-data date: ${dateStr}`);
    } catch (error) {
      totalErrors++;
      results.push({ date: dateStr, status: 'error', message: error.message });
      log(`❌ Error processing visit-data date ${dateStr}: ${error.message}`);
      // Continue with next date even if one fails
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

module.exports = {
  transformVisitRow,
  listVisitDataEntries,
  buildVisitDataPrefix,
  fetchAndSaveVisitData,
  syncVisitDataToDatabase,
  syncVisitData,
  syncVisitDataRange,
  normalizeOrderId
};
