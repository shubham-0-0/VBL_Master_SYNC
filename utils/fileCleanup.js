const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

async function cleanupDirectories(directories) {
  try {
    for (const dir of directories) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          fs.unlinkSync(filePath);
          log(`🗑️ Deleted file: ${filePath}`);
        }
        log(`✅ Cleaned up directory: ${dir}`);
      }
    }
  } catch (error) {
    log(`❌ Error during cleanup: ${error.message}`);
    throw error;
  }
}

module.exports = {
  cleanupDirectories
}; 