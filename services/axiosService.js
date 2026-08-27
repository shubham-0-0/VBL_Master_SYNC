const axios = require('axios');
const mysql = require('mysql2/promise');
const moment = require('moment');
const config = require('../config/config');
const { log } = require('../utils/logger');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path'); 
const { archiveFileToBlob, deleteLocalFile } = require('../utils/fileCleanup');

async function requestWithRetry(url, headers, maxAttempts = 3) {
  let attempt = 0;
  let lastError;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await axios.get(url, { headers });
    } catch (error) {
      const status = error?.response?.status;
      lastError = error;
      if (status === 502 && attempt < maxAttempts) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        log(`⚠️ 502 from distributor API (attempt ${attempt}/${maxAttempts - 1}). Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function getApiUrl(dateOrRange) {
  const FromChangedDate = moment().format('YYYYMMDD');
  const ToChangedDate = moment().format('YYYYMMDD');

  // Allow explicit date or date range override
  if (dateOrRange) {
    if (typeof dateOrRange === 'string' || dateOrRange instanceof Date) {
      const d = moment(dateOrRange).format('YYYYMMDD');
      return `${config.vbl.api.baseUrl}/DISTMAST?$filter=` +
        `CompanyCode eq '${config.vbl.api.companyCode}' and ` +
        `FromDate eq '' and ToDate eq '' and ` +
        `FromDivision eq '${config.vbl.api.division}' and ` +
        `ToDivision eq '${config.vbl.api.division}' and ` +
        `FromDistchannel eq '${config.vbl.api.distChannel}' and ` +
        `ToDistchannel eq '${config.vbl.api.distChannel}' and ` +
        `Custgrp eq '${config.vbl.api.custGroup}' and ` +
        `FromCustacctgrp eq '' and ToCustacctgrp eq '' and ` +
        `FromChangedDate eq '${d}' and ` +
        `ToChangedDate eq '${d}'`;
    }
    if (typeof dateOrRange === 'object' && dateOrRange.start && dateOrRange.end) {
      const start = moment(dateOrRange.start).format('YYYYMMDD');
      const end = moment(dateOrRange.end).format('YYYYMMDD');
      return `${config.vbl.api.baseUrl}/DISTMAST?$filter=` +
        `CompanyCode eq '${config.vbl.api.companyCode}' and ` +
        `FromDate eq '' and ToDate eq '' and ` +
        `FromDivision eq '${config.vbl.api.division}' and ` +
        `ToDivision eq '${config.vbl.api.division}' and ` +
        `FromDistchannel eq '${config.vbl.api.distChannel}' and ` +
        `ToDistchannel eq '${config.vbl.api.distChannel}' and ` +
        `Custgrp eq '${config.vbl.api.custGroup}' and ` +
        `FromCustacctgrp eq '' and ToCustacctgrp eq '' and ` +
        `FromChangedDate eq '${start}' and ` +
        `ToChangedDate eq '${end}'`;
    }
  }

  return `${config.vbl.api.baseUrl}/DISTMAST?$filter=` +
    `CompanyCode eq '${config.vbl.api.companyCode}' and ` +
    `FromDate eq '' and ToDate eq '' and ` +
    `FromDivision eq '${config.vbl.api.division}' and ` +
    `ToDivision eq '${config.vbl.api.division}' and ` +
    `FromDistchannel eq '${config.vbl.api.distChannel}' and ` +
    `ToDistchannel eq '${config.vbl.api.distChannel}' and ` +
    `Custgrp eq '${config.vbl.api.custGroup}' and ` +
    `FromCustacctgrp eq '' and ToCustacctgrp eq '' and ` +
    `FromChangedDate eq '${FromChangedDate}' and ` +
    `ToChangedDate eq '${ToChangedDate}'`;
}


function getAuthHeader() {
  const auth = Buffer.from(`${config.vbl.auth.clientId}:${config.vbl.auth.clientSecret}`).toString('base64');
  return `Basic ${auth}`;
}

async function fetchDistributorData(dateOrRange) {
  try {
    console.time("fetchDistributorData");
    
    let apiUrl = getApiUrl(dateOrRange);
    console.log('DBR URL',apiUrl)
    const response = await requestWithRetry(apiUrl, {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json'
    }, 3);

    let rows = response?.data?.d?.results?.length ? response.data.d.results : [];
    console.timeEnd("fetchDistributorData");

    const timestamp = (dateOrRange ? new Date(dateOrRange) : new Date()).toISOString().replace(/[:.]/g, "-");
    const outputFileName = `DBR${timestamp}.csv`;
    const outputPath = path.join(config.directories.upload, outputFileName);

      const worksheet = xlsx.utils.json_to_sheet(rows);
      const csvBuffer = xlsx.write(
            { Sheets: { data: worksheet }, SheetNames: ["data"] },
            { type: "buffer", bookType: "csv" }
          );

          fs.writeFileSync(outputPath, csvBuffer);
          log(`✅ Final combined CSV saved at ${outputPath}`);

          // Archive to blob storage (if enabled), then always delete the local
          // temp copy - this file is never read back, so it can go immediately.
          if (config.storage.distributor.enabled) {
            const archiveDateStr = moment(dateOrRange || undefined).format('YYYY-MM-DD');
            const blobDir = path.join(config.storage.basePath, config.storage.distributor.folder, archiveDateStr);
            try {
              const archivedPath = archiveFileToBlob(outputPath, blobDir, outputFileName);
              log(`📦 Archived distributor file to ${archivedPath}`);
            } catch (archiveError) {
              log(`⚠️ Failed to archive distributor file: ${archiveError.message}`);
            }
          }
          deleteLocalFile(outputPath);

    // Transform the data to match our required format
    return rows.map(row => ({
      Distributor_Code: row.customerCode,
      DBR_Name: row.customerName1,
      Address: `${row.street || ''} ${row.customerCity || ''} ${row.district || ''} ${row.postalCode || ''}`.trim(),
      Latitude: row.latitude || null,
      Longitude: row.longitude || null,
      status:row.customergrp3Des,
      Distributor_Type:row.customerattribute3Desc,
      BusinessUnit:row.customerattribute10Desc,
      MUGM:row.salesdistrictDesc,
      COO:'', // Assuming COO is not provided in the API response
      upload_type: 'vbl',
      uploaded_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    }));
  } catch (error) {
    log(`❌ Error fetching distributor data: ${error.message}`);
    throw error;
  }
}

async function syncDistributorDataToDatabase(data) {
  const connection = await mysql.createConnection(config.mysql);

  try {
    // Start transaction
    await connection.beginTransaction();

    // Truncate temporary table before inserting new data
    await connection.query("TRUNCATE TABLE integration_dbr");
    log("🗑️ Cleared temporary table before processing new data");

    if (data.length > 0) {
      const insertQuery = `
        INSERT INTO integration_dbr (
          Distributor_Code, DBR_Name, Address, Latitude, Longitude,
          status, Distributor_Type, upload_type, uploaded_at,
          businessunit_name,COO,MUGM
        )
        VALUES ?
      `;

      const values = data.map(row => [
        row.Distributor_Code,
        row.DBR_Name,
        row.Address,
        row.Latitude,
        row.Longitude,
        row.status,
        row.Distributor_Type,
        row.upload_type,
        row.uploaded_at,
        row.BusinessUnit,
        row.COO,
        row.MUGM
      ]);

      await connection.query(insertQuery, [values]);
      log(`✅ Inserted ${values.length} distributor records into integration_outlet_s3_temp`);

      // Call stored procedure to sync distributor data
      let obj = {
        action: "DBR_MASTER"
      };
      const syncProcedure = `
        CALL sp_sync_attendance_master('${JSON.stringify(obj)}');
      `;

      const [procedureResults] = await connection.query(syncProcedure);      // Commit transaction
      await connection.commit();
      log('✅ Transaction committed successfully');
    } else {
      log("⚠️ No distributor data to insert");
    }
  } catch (err) {
    // Rollback transaction on error
    await connection.rollback();
    log(`❌ Database error while syncing distributor data: ${err.message}. Transaction rolled back.`);
    throw err;
  } finally {
    await connection.end();
  }
}

async function syncDistributorData(dateOrRange) {
  try {
    const distributorData = await fetchDistributorData(dateOrRange);
    await syncDistributorDataToDatabase(distributorData);
    log('✅ Distributor data sync completed successfully');
  } catch (error) {
    log(`❌ Error in distributor data sync: ${error.message}`);
    throw error;
  }
}

module.exports = {
  syncDistributorData
};
