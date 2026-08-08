const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // run this check once an hour

function cleanupOldFiles() {
  fs.readdir(DOWNLOADS_DIR, (err, files) => {
    if (err) return; // folder might not exist yet on a fresh deploy — nothing to clean

    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(DOWNLOADS_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (statErr) return;
        if (now - stats.mtimeMs > MAX_AGE_MS) {
          fs.unlink(filePath, () => {
            console.log(`[Cleanup] Removed old file: ${file}`);
          });
        }
      });
    }
  });
}

// Starts the recurring cleanup. Independent of any individual download
// attempt succeeding or failing — this is a safety net that guarantees
// files never sit around forever, no matter what else happens to them.
function startCleanupScheduler() {
  cleanupOldFiles(); // run once immediately on startup too
  setInterval(cleanupOldFiles, CHECK_INTERVAL_MS);
  console.log('[Cleanup] Scheduler started — checking for files older than 24h, every hour.');
}

module.exports = { startCleanupScheduler };