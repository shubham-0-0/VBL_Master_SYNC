const visitDataService = require('../services/visitDataService');
const { log } = require('../utils/logger');

const syncVisitData = async (req, res) => {
  try {
    const result = await visitDataService.syncVisitData();

    res.json({
      status: 'success',
      message: 'Visit-data sync completed using the latest discovered CSV file',
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
