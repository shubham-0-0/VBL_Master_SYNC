const distributorService = require('../services/distributorService');
const { log } = require('../utils/logger');

const syncDistributorData = async (req, res) => {
  try {
    const { date } = req.body;
    log(`🔄 Starting distributor data sync${date ? ` for date: ${date}` : ''}...`);
    
    await distributorService.syncData(date);
    
    res.json({ 
      status: 'success', 
      message: `Distributor data sync completed successfully${date ? ` for date: ${date}` : ''}` 
    });
  } catch (error) {
    log(`❌ Distributor sync error: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
};

const syncDistributorDataRange = async (req, res) => {
  try {
    const { startDate, endDate, batchSize = 7 } = req.body;
    
    const result = await distributorService.syncDataRange(startDate, endDate, batchSize);
    
    res.json(result);
  } catch (error) {
    log(`❌ Distributor range sync error: ${error.message}`);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
};

module.exports = {
  syncDistributorData,
  syncDistributorDataRange
}; 