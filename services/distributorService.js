const mysql = require('mysql2/promise');
const moment = require('moment');
const { log } = require('../utils/logger');
const config = require('../config/config');
const axiosService = require('./axiosService');

const syncData = async (date) => {
  return await axiosService.syncDistributorData(date);
};

const syncDataRange = async (startDate, endDate, batchSize = 7) => {
  const start = moment(startDate);
  const end = moment(endDate);
  
  if (!start.isValid() || !end.isValid()) {
    throw new Error('Invalid date format. Please use YYYY-MM-DD');
  }

  if (end.isBefore(start)) {
    throw new Error('endDate must be after startDate');
  }

  log(`🔄 Starting distributor data sync for date range: ${startDate} to ${endDate}`);
  
  const allData = [];
  const currentDate = start.clone();
  
  while (currentDate.isSameOrBefore(end)) {
    const batchEndDate = moment.min(currentDate.clone().add(batchSize - 1, 'days'), end);
    
    log(`📅 Processing batch: ${currentDate.format('YYYY-MM-DD')} to ${batchEndDate.format('YYYY-MM-DD')}`);
    
    const dateRange = {
      start: currentDate.format('YYYY-MM-DD'),
      end: batchEndDate.format('YYYY-MM-DD')
    };
    const batchData = await axiosService.syncDistributorData(dateRange);
    allData.push(...batchData);
    
    currentDate.add(batchSize, 'days');
  }

  if (allData.length > 0) {
    const connection = await mysql.createConnection(config.mysql);
    try {
      await connection.beginTransaction();
      
      await connection.query("TRUNCATE TABLE integration_outlet_s3_temp");
      log("🗑️ Cleared temporary table before processing batch data");

      const insertQuery = `
        INSERT INTO integration_outlet_s3_temp (
          Distributor_Code, DBR_Name, Address, Latitude, Longitude,
          upload_type, uploaded_at
        )
        VALUES ?
      `;

      const values = allData.map(row => [
        row.Distributor_Code,
        row.DBR_Name,
        row.Address,
        row.Latitude,
        row.Longitude,
        row.upload_type,
        row.uploaded_at
      ]);

      await connection.query(insertQuery, [values]);
      log(`✅ Inserted ${values.length} distributor records into integration_outlet_s3_temp`);

      const syncProcedure = `
        CALL sp_sync_distributor_data(
          @total_records,
          @inserted_count,
          @updated_count,
          @error_count,
          @error_message
        );
        SELECT 
          @total_records as total_records,
          @inserted_count as inserted_count,
          @updated_count as updated_count,
          @error_count as error_count,
          @error_message as error_message;
      `;

      const [procedureResults] = await connection.query(syncProcedure);
      const stats = procedureResults[1][0];

      await connection.commit();
      
      return {
        status: 'success',
        message: `Distributor data sync completed for date range ${startDate} to ${endDate}`,
        statistics: {
          totalRecords: stats.total_records,
          inserted: stats.inserted_count,
          updated: stats.updated_count,
          errors: stats.error_count,
          errorMessage: stats.error_message
        }
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  } else {
    return {
      status: 'success',
      message: 'No data found for the specified date range',
      statistics: {
        totalRecords: 0,
        inserted: 0,
        updated: 0,
        errors: 0
      }
    };
  }
};

module.exports = {
  syncData,
  syncDataRange
}; 