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

// Copies a single local file into a dated folder under a blob-storage mount,
// e.g. <basePath>/<syncFolder>/<YYYY-MM-DD>/<fileName>. Never touches any
// other file already sitting in that mount, so older archived dates are
// never affected by a later run (including one that has archiving disabled).
function archiveFileToBlob(localPath, blobDir, fileName) {
  fs.mkdirSync(blobDir, { recursive: true });
  const destPath = path.join(blobDir, fileName);
  fs.copyFileSync(localPath, destPath);
  return destPath;
}

// Deletes exactly the one local file passed in - never a whole directory -
// so concurrent jobs sharing a parent folder can't clobber each other's
// in-flight files.
function deleteLocalFile(localPath) {
  try {
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      log(`🗑️ Deleted local temp file: ${localPath}`);
    }
  } catch (error) {
    log(`⚠️ Failed to delete local temp file ${localPath}: ${error.message}`);
  }
}

module.exports = {
  cleanupDirectories,
  archiveFileToBlob,
  deleteLocalFile
};
