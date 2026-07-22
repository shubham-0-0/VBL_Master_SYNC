const express = require('express');
const router = express.Router();
const { syncVisitData } = require('../controllers/visitDataController');
const { log } = require('../utils/logger');

// Single date OR date range in the body. The controller normalizes both.
router.post('/sync', async (req, res) => {
  const { date, startDate, endDate } = req.body || {};
  if (startDate && endDate) {
    log(`🔄 Starting visit-data sync for date range: ${startDate} to ${endDate}...`);
  } else {
    log(`🔄 Starting visit-data sync${date ? ` for date: ${date}` : ''}...`);
  }
  await syncVisitData(req, res);
});

module.exports = router;
