const moment = require('moment');
const visitDataService = require('../services/visitDataService');
const { log } = require('../utils/logger');

const syncVisitData = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.body || {};

    let result;
    if (startDate && endDate) {
      result = await visitDataService.syncVisitDataRange(startDate, endDate);
    } else {
      const targetDate = date || moment().format('YYYY-MM-DD');
      result = await visitDataService.syncVisitDataRange(targetDate, targetDate);
    }

    res.json({
      status: 'success',
      message: 'Visit-data sync completed',
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
