const healthService = require('../services/healthService');

const getHealthStatus = async (req, res) => {
  try {
    const status = await healthService.getHealthStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

module.exports = {
  getHealthStatus
}; 