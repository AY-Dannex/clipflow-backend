// One-off cleanup script — run manually with: node cleanup.js
// Wipes ALL jobs from the queue (completed, failed, waiting, everything),
// giving you a clean slate. Safe to run anytime nothing is actively downloading.
require('dotenv').config();
const downloadQueue = require('./utils/downloadQueue');

async function main() {
  console.log('Clearing all jobs from the queue...');
  await downloadQueue.obliterate({ force: true });
  console.log('Done — queue is now empty.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});