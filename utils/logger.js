const fs = require('fs');
const path = require('path');

const LOG_FILE = "log.txt";

function log(message) {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}`;
  console.log(fullMessage);
  fs.appendFileSync(LOG_FILE, fullMessage + "\n");
}

module.exports = { log }; 