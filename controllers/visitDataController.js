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
