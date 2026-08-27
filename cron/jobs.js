const cron = require('node-cron');
const moment = require('moment');
const { syncS3DataRange } = require('../services/s3Service');
const { syncDataRange } = require('../services/distributorService');
const { syncVisitDataRange } = require('../services/visitDataService');
const { log } = require('../utils/logger');

function initializeCronJobs() {
  // Schedule Distributor sync at 7:00 AM daily
  cron.schedule('00 7 * * *', async () => {
    try {
      log('🕖 Running scheduled Distributor sync at 7:00 AM');
      // Sync previous date through current date.
      const previousDate = moment().subtract(1, 'days').format('YYYY-MM-DD');
      const currentDate = moment().format('YYYY-MM-DD');
      await syncDataRange(previousDate, currentDate);
      log('✅ Scheduled Distributor sync completed successfully');
    } catch (error) {
      log(`❌ Scheduled Distributor sync error: ${error.message}`);
    }
  });

  // Schedule Route (S3) sync at 7:15 AM daily
  cron.schedule('15 7 * * *', async () => {
    try {
      log('🕖 Running scheduled Route sync at 7:15 AM');
      // Sync previous date through current date.
      const previousDate = moment().subtract(1, 'days').format('YYYY-MM-DD');
      const currentDate = moment().format('YYYY-MM-DD');
      await syncS3DataRange(previousDate, currentDate);
      log('✅ Scheduled Route sync completed successfully');
    } catch (error) {
      log(`❌ Scheduled Route sync error: ${error.message}`);
    }
  });

  // Schedule Visit Data sync at 8:00 AM daily
  cron.schedule('00 8 * * *', async () => {
    try {
      log('🕗 Running scheduled Visit Data sync at 8:00 AM');
      // Sync current date only (startDate === endDate).
      const currentDate = moment().format('YYYY-MM-DD');
      await syncVisitDataRange(currentDate, currentDate);
      log('✅ Scheduled Visit Data sync completed successfully');
    } catch (error) {
      log(`❌ Scheduled Visit Data sync error: ${error.message}`);
    }
  });

  log('⏰ Cron jobs initialized:');
  log('   - Distributor Sync: Daily at 7:00 AM (previous date to current date)');
  log('   - Route Sync: Daily at 7:15 AM (previous date to current date)');
  log('   - Visit Data Sync: Daily at 8:00 AM (current date only)');
}

module.exports = {
  initializeCronJobs
};
