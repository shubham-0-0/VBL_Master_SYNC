const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
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

async function checkPrefixEntries(prefix) {
  const normalizedPrefix = `${prefix.replace(/\/$/, '')}/`;
  const { CommonPrefixes, Contents } = await s3Client.send(new ListObjectsV2Command({
    Bucket: config.aws.s3.bucket,
    Prefix: normalizedPrefix,
    Delimiter: '/'
  }));

  const folderNames = (CommonPrefixes || [])
    .map((item) => item.Prefix || '')
    .map((itemPrefix) => itemPrefix.slice(normalizedPrefix.length).replace(/\/$/, ''))
    .filter(Boolean)
    .sort();

  const fileNames = (Contents || [])
    .map((item) => item.Key || '')
    .filter((key) => key && key !== normalizedPrefix)
    .map((key) => key.slice(normalizedPrefix.length))
    .filter(Boolean)
    .sort();

  return {
    exists: folderNames.length > 0 || fileNames.length > 0,
    folderNames,
    fileNames
  };
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

async function logVisitDataEntries(basePrefix) {
  const { folderNames, fileNames, objects } = await listVisitDataEntries(basePrefix);
  console.log('VISIT_DATA folder names:', folderNames);
  console.log('VISIT_DATA filenames:', fileNames);
  return objects;
}

async function fetchAndSaveVisitData() {
  const speedPrefix = 'SPEED';
  log(`🔎 Checking S3 bucket/prefix: ${config.aws.s3.bucket}/${speedPrefix}/`);
  const speedEntries = await checkPrefixEntries(speedPrefix);
  log(`📂 ${speedPrefix}/ exists in bucket ${config.aws.s3.bucket}: ${speedEntries.exists}`);
  console.log('SPEED folder names:', speedEntries.folderNames);
  console.log('SPEED filenames:', speedEntries.fileNames);

  log(`🔎 Listing visit-data entries under: ${config.visitData.s3PrefixBase}/`);
  const objects = await logVisitDataEntries(config.visitData.s3PrefixBase);
  const files = (objects || []).filter((f) => (f.Key || '').toLowerCase().endsWith('.csv'));

  if (files.length === 0) {
    log(`⚠️ No CSV files found under ${config.visitData.s3PrefixBase}/`);
    return { rows: [], fileKey: null, fileName: null };
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
  return {
    rows: transformed,
    fileKey: latestFile.Key,
    fileName
  };
}

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

async function syncVisitData() {
  try {
    const { rows, fileKey, fileName } = await fetchAndSaveVisitData();
    if (rows.length > 0) {
      await syncVisitDataToDatabase(rows);
      return {
        selectedFile: fileKey,
        fileName,
        rowCount: rows.length
      };
    } else {
      log('⚠️ No visit data to insert; skipping DB sync.');
      return {
        selectedFile: null,
        fileName: null,
        rowCount: 0
      };
    }
  } catch (error) {
    log(`❌ Error in visit-data sync: ${error.message}`);
    throw error;
  }
}

async function syncVisitDataRange(startDate, endDate) {
  log(`⚠️ Date range arguments (${startDate} to ${endDate}) are ignored for visit-data sync right now.`);
  return syncVisitData();
}

module.exports = {
  transformVisitRow,
  listVisitDataEntries,
  fetchAndSaveVisitData,
  syncVisitDataToDatabase,
  syncVisitData,
  syncVisitDataRange
};
