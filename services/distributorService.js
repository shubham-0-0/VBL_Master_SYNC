const moment = require('moment');
const { log } = require('../utils/logger');
const axiosService = require('./axiosService');

const syncData = async (date) => {
  return await axiosService.syncDistributorData(date);
};

const syncDataRange = async (startDate, endDate) => {
  const start = moment(startDate);
  const end = moment(endDate);

  if (!start.isValid() || !end.isValid()) {
    throw new Error('Invalid date format. Please use YYYY-MM-DD');
  }

  if (end.isBefore(start)) {
    throw new Error('endDate must be after startDate');
  }

  log(`🔄 Starting distributor data sync for date range: ${startDate} to ${endDate}`);

  const results = [];
  const currentDate = start.clone();
  let totalProcessed = 0;
  let totalErrors = 0;

  // Process each date sequentially, one day at a time using the single-day logic
  while (currentDate.isSameOrBefore(end)) {
    const dateStr = currentDate.format('YYYY-MM-DD');
    log(`📅 Processing date: ${dateStr}`);

    try {
      await axiosService.syncDistributorData(dateStr);
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
};

module.exports = {
  syncData,
  syncDataRange
};
