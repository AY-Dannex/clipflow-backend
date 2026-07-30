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

// This worker listens for jobs added to the 'video-downloads' queue
// and processes them one at a time in the background.
const worker = new Worker(
  'video-downloads',
  async (job) => {
    const { url, formatId, startTime, endTime, fileId, title } = job.data;

    const rawPath = path.join(DOWNLOADS_DIR, `${fileId}-raw.mp4`);
    const finalPath = path.join(DOWNLOADS_DIR, `${fileId}-final.mp4`);
    const wantsTrim = Boolean(startTime || endTime);

    // job.attemptsMade is 0 on the very first try, 1 after the first retry, etc.
    const attempt = job.attemptsMade + 1;

    if (attempt > 1) {
      // Let the frontend know this is a retry caused by a dropped
      // connection, not a fresh download, so the UI can explain it
      // instead of just silently jumping backward.
      await job.updateProgress({
        stage: 'reconnecting',
        percent: 0,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        weakConnection: true,
      });
    }

    await job.updateProgress({ stage: 'downloading', percent: 10, attempt, maxAttempts: MAX_ATTEMPTS });
    await downloadVideo({ url, formatId, outputPath: rawPath });

    if (wantsTrim) {
      await job.updateProgress({ stage: 'trimming', percent: 70, attempt, maxAttempts: MAX_ATTEMPTS });
      await trimVideo({ inputPath: rawPath, outputPath: finalPath, startTime, endTime });
    } else {
      await job.updateProgress({ stage: 'finalizing', percent: 70, attempt, maxAttempts: MAX_ATTEMPTS });
      await ensureAacAudio({ inputPath: rawPath, outputPath: finalPath });
    }

    fs.unlink(rawPath, () => {});
    await job.updateProgress({ stage: 'done', percent: 100, attempt, maxAttempts: MAX_ATTEMPTS });

    return { filePath: finalPath, title };
  },
  {
    connection,
    // Downloads can take a while, and on a shaky connection the worker's
    // "I'm still alive" signal to Redis can arrive late. A short lock
    // duration would make BullMQ wrongly assume the worker died and
    // restart the job from scratch. A generous lock (10 min) gives slow
    // connections room to breathe before that happens.
    lockDuration: 10 * 60 * 1000,
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed (attempts: ${job.attemptsMade + 1})`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed after ${job ? job.attemptsMade + 1 : '?'} attempt(s):`, err.message);
});

console.log('Worker started, waiting for jobs...');