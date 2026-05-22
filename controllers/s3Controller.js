const s3Service = require('../services/s3Service');
const { log } = require('../utils/logger');

const syncS3Data = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.body;
    
    let result;
    if (startDate && endDate) {
      log(`🔄 Starting S3 data sync for date range: ${startDate} to ${endDate}...`);
      result = await s3Service.syncS3DataRange(startDate, endDate);
      
      res.json({ 
        status: 'success', 
        message: `S3 data sync completed successfully for date range ${startDate} to ${endDate}`,
        summary: result
      });
    } else {
      log(`🔄 Starting S3 data sync${date ? ` for date: ${date}` : ''}...`);
      await s3Service.syncS3Data(date);
      
      res.json({ 
        status: 'success', 
        message: `S3 data sync completed successfully${date ? ` for date: ${date}` : ''}` 
      });
    }
  } catch (error) {
    log(`❌ S3 sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

module.exports = {
  syncS3Data
}; 