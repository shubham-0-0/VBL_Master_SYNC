const express = require('express');
const router = express.Router();
const moment = require('moment');
const { syncDistributorData } = require('../services/axiosService');
const { log } = require('../utils/logger');

// Single date sync
router.post('/sync', async (req, res) => {
  try {
    const { date } = req.body;
    log(`🔄 Starting distributor data sync${date ? ` for date: ${date}` : ''}...`);
    
    await syncDistributorData(date);
    res.json({ 
      status: 'success', 
      message: `Distributor data sync completed successfully${date ? ` for date: ${date}` : ''}` 
    });
  } catch (error) {
    log(`❌ Distributor sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Date range sync - processes each date sequentially
router.post('/sync/range', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'startDate and endDate are required' 
      });
    }

    const start = moment(startDate);
    const end = moment(endDate);
    
    if (!start.isValid() || !end.isValid()) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid date format. Please use YYYY-MM-DD' 
      });
    }

    if (end.isBefore(start)) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'endDate must be after startDate' 
      });
    }

    log(`🔄 Starting distributor data sync for date range: ${startDate} to ${endDate}`);
    
    const results = [];
    const currentDate = start.clone();
    let totalProcessed = 0;
    let totalErrors = 0;

    // Process each date sequentially, one by one
    while (currentDate.isSameOrBefore(end)) {
      const dateStr = currentDate.format('YYYY-MM-DD');
      log(`📅 Processing date: ${dateStr}`);
      
      try {
        // Call sync function for this single date - it will fetch and sync to database
        await syncDistributorData(dateStr);
        totalProcessed++;
        results.push({
          date: dateStr,
          status: 'success',
          message: `Successfully synced data for ${dateStr}`
        });
        log(`✅ Successfully processed date: ${dateStr}`);
      } catch (error) {
        totalErrors++;
        results.push({
          date: dateStr,
          status: 'error',
          message: error.message
        });
        log(`❌ Error processing date ${dateStr}: ${error.message}`);
        // Continue with next date even if one fails
      }
      
      // Move to next date
      currentDate.add(1, 'days');
    }

    log(`✅ Date range sync completed. Processed: ${totalProcessed}, Errors: ${totalErrors}`);
    
    res.json({
      status: 'success',
      message: `Distributor data sync completed for date range ${startDate} to ${endDate}`,
      summary: {
        startDate,
        endDate,
        totalDates: results.length,
        successful: totalProcessed,
        failed: totalErrors,
        results
      }
    });
  } catch (error) {
    log(`❌ Distributor range sync error: ${error.message}`);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

module.exports = router; 