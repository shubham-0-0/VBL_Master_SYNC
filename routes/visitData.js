const express = require('express');
const router = express.Router();
const { syncVisitData } = require('../controllers/visitDataController');
const { log } = require('../utils/logger');

router.post('/sync', async (req, res) => {
  log('🔄 Starting visit-data sync using the latest discovered CSV file...');
  await syncVisitData(req, res);
});

module.exports = router;
