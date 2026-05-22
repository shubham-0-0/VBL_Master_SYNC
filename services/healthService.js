const getHealthStatus = async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString()
  };
};

module.exports = {
  getHealthStatus
}; 