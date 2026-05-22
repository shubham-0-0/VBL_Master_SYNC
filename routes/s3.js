const express = require('express');
const router = express.Router();
const { syncS3Data } = require('../controllers/s3Controller');
const { log } = require('../utils/logger');

router.post('/sync', async (req, res) => {
  try {
    const { date, startDate, endDate } = req.body;
    console.log('date', date, 'startDate', startDate, 'endDate', endDate);
    
    if (startDate && endDate) {
      log(`🔄 Starting S3 data sync for date range: ${startDate} to ${endDate}...`);
    } else {
      log(`🔄 Starting S3 data sync${date ? ` for date: ${date}` : ''}...`);
    }
    
    await syncS3Data(req, res);
    return; // Controller handles the response
  } catch (error) {
    log(`❌ S3 sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = router; 