const fs = require('fs');
const express = require('express');
const { log } = require('./utils/logger');
const { initializeCronJobs } = require('./cron/jobs');
const config = require('./config/config');

// Import routes
const healthRoutes = require('./routes/health');
const s3Routes = require('./routes/s3');
const distributorRoutes = require('./routes/distributor');
const visitDataRoutes = require('./routes/visitData');

const app = express();
const port = process.env.PORT || 3001;

// Ensure directories the sync jobs write to exist up front, so a fresh
// deployment doesn't depend on one job's incidental mkdir (visit-data)
// happening to create 'upload/' before distributor/route sync needs it.
[
  config.directories.upload,
  config.directories.distributor,
  config.directories.route,
  config.visitData.rawDir
].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
  log(`📁 Ensured directory exists: ${dir}`);
});

// Middleware
app.use(express.json());

// Routes
app.use('/health', healthRoutes);
app.use('/s3', s3Routes);
app.use('/distributor', distributorRoutes);
app.use('/visit-data', visitDataRoutes);

// Start server
app.listen(port, () => {
  log(`🚀 Server running on port ${port}`);
  // Initialize cron jobs
  initializeCronJobs();
}); 