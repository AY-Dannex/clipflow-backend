require('dotenv').config();
const { Worker } = require('bullmq');
const path = require('path');
const fs = require('fs');
const connection = require('./utils/redisConnection');
const { downloadVideo } = require('./utils/ytdlp');
const { trimVideo, ensureAacAudio } = require('./utils/ffmpeg');

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const MAX_ATTEMPTS = 5;

// Creates a throttled progress reporter that maps a 0-100 sub-progress
// (e.g. yt-dlp's own download percent) into a slice of our overall bar
// (e.g. 10-70%), without spamming Redis on every tiny update.
function makeStageReporter(job, { rangeStart, rangeEnd, stage, attempt, maxAttempts }) {
  let lastSent = -1;
  return (subPercent) => {
    const overall = Math.round(rangeStart + (subPercent / 100) * (rangeEnd - rangeStart));
    if (overall !== lastSent) {
      lastSent = overall;
      job.updateProgress({ stage, percent: overall, attempt, maxAttempts }).catch(() => {});
    }
  };
}

const worker = new Worker(
  'video-downloads',
  async (job) => {
    const { url, formatId, startTime, endTime, fileId, title, duration } = job.data;

    const rawPath = path.join(DOWNLOADS_DIR, `${fileId}-raw.mp4`);
    const finalPath = path.join(DOWNLOADS_DIR, `${fileId}-final.mp4`);
    const wantsTrim = Boolean(startTime || endTime);

    const attempt = job.attemptsMade + 1;

    if (attempt > 1) {
      await job.updateProgress({
        stage: 'reconnecting',
        percent: 0,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        weakConnection: true,
      });
    }

    // Download: 10% -> 70% of the overall bar, driven by yt-dlp's real progress
    const reportDownload = makeStageReporter(job, {
      rangeStart: 10, rangeEnd: 70, stage: 'downloading', attempt, maxAttempts: MAX_ATTEMPTS,
    });
    await job.updateProgress({ stage: 'downloading', percent: 10, attempt, maxAttempts: MAX_ATTEMPTS });
    await downloadVideo({ url, formatId, outputPath: rawPath, onProgress: reportDownload });

    // Trim/finalize: 70% -> 100%, driven by ffmpeg's real progress
    const reportFinal = makeStageReporter(job, {
      rangeStart: 70, rangeEnd: 99, stage: wantsTrim ? 'trimming' : 'finalizing', attempt, maxAttempts: MAX_ATTEMPTS,
    });

    if (wantsTrim) {
      await trimVideo({ inputPath: rawPath, outputPath: finalPath, startTime, endTime, onProgress: reportFinal });
    } else {
      await ensureAacAudio({ inputPath: rawPath, outputPath: finalPath, totalDurationSec: duration, onProgress: reportFinal });
    }

    fs.unlink(rawPath, () => {});
    await job.updateProgress({ stage: 'done', percent: 100, attempt, maxAttempts: MAX_ATTEMPTS });

    return { filePath: finalPath, title };
  },
  {
    connection,
    lockDuration: 10 * 60 * 1000,
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed (attempts: ${job.attemptsMade + 1})`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed after ${job ? job.attemptsMade + 1 : '?'} attempt(s):`, err.message);
});

worker.on('error', (err) => {
  console.error('[Worker] internal error:', err.message);
});

worker.on('stalled', (jobId) => {
  console.warn(`[Worker] job ${jobId} stalled`);
});

worker.on('active', (job) => {
  console.log(`[Worker] picked up job ${job.id}`);
});

console.log('Worker started, waiting for jobs...');