const express = require('express');
const { log } = require('./utils/logger');
const { initializeCronJobs } = require('./cron/jobs');

// Import routes
const healthRoutes = require('./routes/health');
const s3Routes = require('./routes/s3');
const distributorRoutes = require('./routes/distributor');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(express.json());

// Routes
app.use('/health', healthRoutes);
app.use('/s3', s3Routes);
app.use('/distributor', distributorRoutes);

// Start server
app.listen(port, () => {
  log(`🚀 Server running on port ${port}`);
  // Initialize cron jobs
  initializeCronJobs();
}); 