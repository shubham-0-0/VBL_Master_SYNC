const express = require('express');
const router = express.Router();
const moment = require('moment');
const distributorService = require('../services/distributorService');
const { log } = require('../utils/logger');

// Single date sync - delegates to the date-range function with startDate === endDate
router.post('/sync', async (req, res) => {
  try {
    const { date } = req.body;
    const targetDate = date || moment().format('YYYY-MM-DD');
    log(`🔄 Starting distributor data sync for date: ${targetDate}...`);

    const result = await distributorService.syncDataRange(targetDate, targetDate);
    res.json(result);
  } catch (error) {
    log(`❌ Distributor sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Date range sync - delegates to the date-range function
router.post('/sync/range', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        status: 'error',
        message: 'startDate and endDate are required'
      });
    }

    const result = await distributorService.syncDataRange(startDate, endDate);
    res.json(result);
  } catch (error) {
    log(`❌ Distributor range sync error: ${error.message}`);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;
