const moment = require('moment');
const s3Service = require('../services/s3Service');
const { log } = require('../utils/logger');

const syncS3Data = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.body;

    // Always go through the date-range function.
    // For a single date (or no date), startDate === endDate.
    let rangeStart, rangeEnd;
    if (startDate && endDate) {
      rangeStart = startDate;
      rangeEnd = endDate;
    } else {
      rangeStart = rangeEnd = date || moment().format('YYYY-MM-DD');
    }

    log(`🔄 Starting S3 data sync for date range: ${rangeStart} to ${rangeEnd}...`);
    const result = await s3Service.syncS3DataRange(rangeStart, rangeEnd);

    res.json({
      status: 'success',
      message: `S3 data sync completed successfully for date range ${rangeStart} to ${rangeEnd}`,
      summary: result
    });
  } catch (error) {
    log(`❌ S3 sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

module.exports = {
  syncS3Data
};
