const cron = require('node-cron');
const moment = require('moment');
const { syncS3DataRange } = require('../services/s3Service');
const { syncDataRange } = require('../services/distributorService');
const { log } = require('../utils/logger');

function initializeCronJobs() {
  // Schedule S3 sync at 7 AM daily
  cron.schedule('00 7 * * *', async () => {
    try {
      log('🕕 Running scheduled S3 sync at 7 AM');
      // Sync yesterday's data via the date-range function (startDate === endDate).
      const yesterday = moment().subtract(1, 'days').format('YYYY-MM-DD');
      await syncS3DataRange(yesterday, yesterday);
      log('✅ Scheduled S3 sync completed successfully');
    } catch (error) {
      log(`❌ Scheduled S3 sync error: ${error.message}`);
    }
  });

  // Schedule Distributor sync at 6:30 AM daily
  cron.schedule('30 06 * * *', async () => {
    try {
      log('🕖 Running scheduled Distributor sync at 6:30 AM');
      // Sync yesterday's data via the date-range function (startDate === endDate).
      const yesterday = moment().subtract(1, 'days').format('YYYY-MM-DD');
      await syncDataRange(yesterday, yesterday);
      log('✅ Scheduled Distributor sync completed successfully');
    } catch (error) {
      log(`❌ Scheduled Distributor sync error: ${error.message}`);
    }
  });

  log('⏰ Cron jobs initialized:');
  log('   - S3 Sync: Daily at 7:00 AM');
  log('   - Distributor Sync: Daily at 6:30 AM');
}

module.exports = {
  initializeCronJobs
};
