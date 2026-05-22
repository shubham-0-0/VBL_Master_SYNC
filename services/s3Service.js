const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const xlsx = require("xlsx");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const moment = require("moment");
const config = require("../config/config");
const { log } = require("../utils/logger");
const { cleanupDirectories } = require("../utils/fileCleanup");

// Initialize S3 client
const s3Client = new S3Client({
  region: config.aws.s3.region,
  credentials: {
    accessKeyId: config.aws.s3.accessKeyId,
    secretAccessKey: config.aws.s3.secretAccessKey
  }
});

function normalizeDay(value) {
  if (typeof value === "string") {
    const val = value.toLowerCase().trim();
    return val === "yes" || val === "1" ? 1 : 0;
  }
  return value == 1 ? 1 : 0;
}

function stripLeadingZeros(value) {
  if (typeof value === "string") return value.replace(/^0+/, "");
  if (typeof value === "number") return value.toString().replace(/^0+/, "");
  return value;
}

function transformRow(row, uploadType) {
  const transformed = {};

  for (let [key, value] of Object.entries(row)) {
    let normalizedKey = key.trim();
    let cleanValue =
      typeof value === "string" ? value.replace(/[^\w\s.*]/gi, "").trim() : value;

    const lowerKey = normalizedKey.toLowerCase();
    if (config.weekdayMap[lowerKey]) {
      normalizedKey = config.weekdayMap[lowerKey];
      cleanValue = normalizeDay(cleanValue);
    }

    switch (normalizedKey) {
      case "DIST_CD":
        normalizedKey = "Distributor_Code";
        cleanValue = stripLeadingZeros(cleanValue);
        break;
      case "DIST_NAME":
        normalizedKey = "DBR_Name";
        break;
      case "CUST_CD":
        normalizedKey = "Customer_Code";
        break;
      case "CUST_NAME":
        normalizedKey = "Customer_Name";
        break;
      case "ROUTE_CD":
        normalizedKey = "Route_Code";
        break;
      case "ADDR_1":
        normalizedKey = "Address";
        break;
      case "LATITUDE":
        normalizedKey = "Latitude";
        cleanValue = isNaN(parseFloat(cleanValue)) ? null : parseFloat(cleanValue);
        break;
      case "LONGITUDE":
        normalizedKey = "Longitude";
        cleanValue = isNaN(parseFloat(cleanValue)) ? null : parseFloat(cleanValue);
        break;
      case "VISIT_FREQUENCY":
        normalizedKey = "Visit_Frequency";
        break;
      case "CUST_STATUS":
        normalizedKey = "status";
        break;
      case "DISC_TYPE": 
        normalizedKey = "isHVO";
        cleanValue = cleanValue.toString().toLowerCase() === "f" ? 1 : 0;
        break;
      case "REGION":
        normalizedKey = "BusinessUnit";
        break;
    }

    if (config.keysToStore.includes(normalizedKey)) {
      transformed[normalizedKey] = cleanValue;
    }
  }

  transformed.upload_type = uploadType;
  const now = new Date();
  transformed.uploaded_at = now.toISOString().slice(0, 19).replace('T', ' ');

  for (const key of config.keysToStore) {
    if (!(key in transformed)) transformed[key] = null;
  }

  return transformed;
}

async function processAndReturnData(folder, tag, targetDateStr) {
  try {
    // List objects in the folder
    const listCommand = new ListObjectsV2Command({
      Bucket: config.aws.s3.bucket,
      Prefix: folder
    });

    const { Contents } = await s3Client.send(listCommand);
    const files = Contents.filter(
      (file) => file.Key.endsWith(".xlsx") || file.Key.endsWith(".csv")
    );

    if (files.length === 0) {
      log(`❌ No Excel/CSV files found in folder: ${folder}`);
      return [];
    }

    let candidateFiles = files;

    // If a target date is provided, filter files by that date
    if (targetDateStr) {
      let targetDate = new Date(targetDateStr);
      if (isNaN(targetDate.getTime())) {
        log(`⚠️ Invalid date provided: ${targetDateStr}. Falling back to latest file.`);
      } else {
        const dd = String(targetDate.getDate()).padStart(2, '0');
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const yyyy = String(targetDate.getFullYear());

        // Common date tokens used in filenames
        const nameTokens = [
          `${dd}_${mm}_${yyyy}`,
          `${dd}-${mm}-${yyyy}`,
          `${yyyy}-${mm}-${dd}`,
          `${yyyy}_${mm}_${dd}`
        ];

        const byName = files.filter(f => nameTokens.some(t => f.Key.includes(t)));

        // Fallback: match by LastModified calendar date (UTC)
        const byLastModified = files.filter(f => {
          const lm = new Date(f.LastModified);
          return lm.getUTCFullYear() === targetDate.getUTCFullYear() &&
                 lm.getUTCMonth() === targetDate.getUTCMonth() &&
                 lm.getUTCDate() === targetDate.getUTCDate();
        });

        candidateFiles = byName.length > 0 ? byName : byLastModified;

        if (candidateFiles.length === 0) {
          log(`⚠️ No files found for date ${targetDateStr} in ${folder}.`);
          return [];
        }
      }
    }

    const latestFile = candidateFiles.sort(
      (a, b) => new Date(b.LastModified) - new Date(a.LastModified)
    )[0];

    // Get the file object
    const getCommand = new GetObjectCommand({
      Bucket: config.aws.s3.bucket,
      Key: latestFile.Key
    });

    const fileObj = await s3Client.send(getCommand);
    const fileName = path.basename(latestFile.Key);
    const uploadPath = path.join(config.directories.upload, `${tag}_${fileName}`);

    // Convert stream to buffer
    const fileBuffer = await fileObj.Body.transformToByteArray();
    
    // Save file
    fs.writeFileSync(uploadPath, Buffer.from(fileBuffer));
    log(`📥 Saved ${tag} file to ${uploadPath}`);

    // If Excel, use existing xlsx parsing with chunked transformation
    if (fileName.endsWith(".xlsx")) {
      let rawData = [];
      const workbook = xlsx.read(Buffer.from(fileBuffer), { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rawData = xlsx.utils.sheet_to_json(sheet);

      log(`📦 Rows parsed: ${rawData.length} from ${fileName}`);

      if (rawData.length === 0) {
        log(`⚠️ Empty file skipped: ${fileName}`);
        return [];
      }

      const transformed = [];
      const CHUNK_SIZE = 5000;
      for (let i = 0; i < rawData.length; i += CHUNK_SIZE) {
        const upper = Math.min(i + CHUNK_SIZE, rawData.length);
        for (let j = i; j < upper; j++) {
          const row = rawData[j];
          if (i === 0 && j === 0) console.log(`🔍 First row from ${tag}:`, row);
          transformed.push(transformRow(row, tag));
        }
        log(`⚙️ Processed ${upper}/${rawData.length} rows for ${tag}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
      }

      log(`✅ Processed ${transformed.length} rows from ${tag}`);
      return transformed;
    }

    // CSV: stream line-by-line to keep memory bounded
    const parseCsvLine = (line, delimiter) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { // escaped quote
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
      return result.map(s => s.trim());
    };

    const detectDelimiter = (headerLine) => {
      const candidates = [',', '|', ';', '\t'];
      let best = ',';
      let bestCount = -1;
      for (const d of candidates) {
        const count = (headerLine.match(new RegExp(`\\${d}`, 'g')) || []).length;
        if (count > bestCount) {
          best = d === '\\t' ? '\t' : d;
          bestCount = count;
        }
      }
      return best;
    };

    const transformed = [];
    const CHUNK_SIZE = 10000;
    let processed = 0;
    let headers = null;
    let delimiter = ',';

    const rl = readline.createInterface({
      input: fs.createReadStream(uploadPath, { encoding: 'utf8' })
    });

    for await (const line of rl) {
      if (!headers) {
        delimiter = detectDelimiter(line);
        log(`🧭 Detected CSV delimiter '${delimiter === '\t' ? 'TAB' : delimiter}' for ${tag}`);
        headers = parseCsvLine(line, delimiter);
        continue;
      }
      const values = parseCsvLine(line, delimiter);
      const rowObj = {};
      for (let idx = 0; idx < headers.length; idx++) {
        rowObj[headers[idx]] = values[idx] ?? '';
      }
      if (processed === 0) console.log(`🔍 First row from ${tag}:`, rowObj);
      transformed.push(transformRow(rowObj, tag));
      processed++;

      if (processed % CHUNK_SIZE === 0) {
        log(`⚙️ Processed ${processed} rows for ${tag} (streaming CSV)`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    log(`✅ Processed ${processed} rows from ${tag}`);
    return transformed;
  } catch (error) {
    log(`❌ Error processing ${tag} data: ${error.message}`);
    throw error;
  }
}

// Allow plenty of time for the stored procedure to chew through a
// multi-million-row temp table before either side gives up.
const SYNC_QUERY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function syncDataToDatabase(data) {
  const connection = await mysql.createConnection({
    ...config.mysql,
    // Fail fast if the server is unreachable, but be patient once connected.
    connectTimeout: 30 * 1000
  });

  try {
    // Keep the server from dropping the connection while the stored
    // procedure works through a multi-million-row temp table.
    const sessionTimeoutSecs = Math.ceil(SYNC_QUERY_TIMEOUT_MS / 1000);
    await connection.query(
      `SET SESSION wait_timeout = ${sessionTimeoutSecs},
                   net_read_timeout = ${sessionTimeoutSecs},
                   net_write_timeout = ${sessionTimeoutSecs}`
    );

    // Start transaction
    await connection.beginTransaction();

    // Truncate temporary table before inserting new data
    await connection.query("TRUNCATE TABLE integration_outlet_s3_temp");
    log("🗑️ Cleared temporary table before processing new data");

    // Insert data into temporary table
    const insertQuery = `
      INSERT INTO integration_outlet_s3_temp (
        Distributor_Code, DBR_Name, Customer_Code, Customer_Name, Route_Code,
        Address, Latitude, Longitude, Visit_Frequency,
        Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday,
        upload_type, uploaded_at,status,isHVO,businessunit_name
      )
      VALUES ?
    `;

    const values = data.map((row) =>
      config.keysToStore.map((key) => row[key])
    );

    // Insert in batches to stay under MySQL's max_allowed_packet limit.
    // A single INSERT with >1M rows produces a packet too large for the
    // server, which then drops the connection mid-query.
    const INSERT_BATCH_SIZE = 5000;
    for (let i = 0; i < values.length; i += INSERT_BATCH_SIZE) {
      const batch = values.slice(i, i + INSERT_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop
      await connection.query(insertQuery, [batch]);
      log(`🗃️ Inserted ${Math.min(i + batch.length, values.length)}/${values.length} rows into integration_outlet_s3_temp`);
    }

    // Call stored procedure to sync data to main tables
    let obj = {
      action: "CUST_MASTER"
    };
    const syncProcedure = `
    CALL sp_sync_attendance_master('${JSON.stringify(obj)}');
  `;

    // Client-side timeout guard: aborts (and destroys) the connection if
    // the procedure runs longer than expected, instead of hanging forever.
    const [procedureResults] = await connection.query({
      sql: syncProcedure,
      timeout: SYNC_QUERY_TIMEOUT_MS
    });
    console.log('procedureResults',procedureResults);
   
    // Log sync statistics
      // Commit transaction
    await connection.commit();
    log('✅ Transaction committed successfully');

  } catch (err) {
    // Rollback transaction on error
    await connection.rollback();
    log(`❌ Database error: ${err.message}. Transaction rolled back.`);
    throw err;
  } finally {
    await connection.end();
  }
}

async function syncS3Data(targetDateStr) {
  try {
    const samnaData = []//await processAndReturnData("SAMNA/", "samna", targetDateStr);
    const speedData = await processAndReturnData("SPEED/", "speed", targetDateStr);

    const combinedData = [...samnaData, ...speedData];

    if (combinedData.length > 0) {
      await syncDataToDatabase(combinedData);

      // const timestamp = (targetDateStr ? new Date(targetDateStr) : new Date()).toISOString().replace(/[:.]/g, "-");
      // const outputFileName = `combined_${timestamp}.csv`;
      // const outputPath = path.join(config.directories.upload, outputFileName);

      // const worksheet = xlsx.utils.json_to_sheet(combinedData);
      // const csvBuffer = xlsx.write(
      //   { Sheets: { data: worksheet }, SheetNames: ["data"] },
      //   { type: "buffer", bookType: "csv" }
      // );

      // fs.writeFileSync(outputPath, csvBuffer);
      // log(`✅ Final combined CSV saved at ${outputPath}`);

      // Clean up files after successful sync
      // await cleanupDirectories([config.directories.upload]);
    } else {
      log("⚠️ No data to process or insert.");
    }
  } catch (error) {
    log(`❌ Error in S3 sync: ${error.message}`);
    throw error;
  }
}

async function syncS3DataRange(startDate, endDate ) {
  const start = moment(startDate);
  const end = moment(endDate);
  
  if (!start.isValid() || !end.isValid()) {
    throw new Error('Invalid date format. Please use YYYY-MM-DD');
  }

  if (end.isBefore(start)) {
    throw new Error('endDate must be after startDate');
  }

  log(`🔄 Starting S3 data sync for date range: ${startDate} to ${endDate}`);
  
  const results = [];
  const currentDate = start.clone();
  let totalProcessed = 0;
  let totalErrors = 0;

  while (currentDate.isSameOrBefore(end)) {
    const dateStr = currentDate.format('YYYY-MM-DD');
    log(`📅 Processing date: ${dateStr}`);
    
    try {
      await syncS3Data(dateStr);
      totalProcessed++;
      results.push({
        date: dateStr,
        status: 'success',
        message: `Successfully synced data for ${dateStr}`
      });
      log(`✅ Successfully processed date: ${dateStr}`);
    } catch (error) {
      totalErrors++;
      results.push({
        date: dateStr,
        status: 'error',
        message: error.message
      });
      log(`❌ Error processing date ${dateStr}: ${error.message}`);
      // Continue with next date even if one fails
    }
    
    currentDate.add(1, 'days');
  }

  log(`✅ Date range sync completed. Processed: ${totalProcessed}, Errors: ${totalErrors}`);
  
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
  syncS3Data,
  syncS3DataRange
}; 