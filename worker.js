require('dotenv').config();
const { Worker, UnrecoverableError } = require('bullmq');
const path = require('path');
const fs = require('fs');
const connection = require('./utils/redisConnection');
const { downloadCombined, downloadSingleFormat, downloadBestAudio } = require('./utils/ytdlp');
const { trimStream, mergeStreams, ensureAacAudio } = require('./utils/ffmpeg');

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const MAX_ATTEMPTS = 5;

// Platforms with a documented history of audio problems in downloaded
// files. For these, we spend a little extra time re-encoding just the
// audio track to guarantee it's valid AAC. Everything else skips this
// step entirely for speed, since we have no evidence it's needed there.
function needsAudioSafety(url) {
  return /youtube\.com|youtu\.be|tiktok\.com/i.test(url);
}

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

// Deletes a file if it exists, silently ignoring errors (e.g. already gone).
function safeUnlink(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}

const worker = new Worker(
  'video-downloads',
  async (job) => {
    const { url, formatId, hasAudio, startTime, endTime, fileId, title, duration } = job.data;

    const wantsTrim = Boolean(startTime || endTime);
    const audioCodec = needsAudioSafety(url) ? 'aac' : 'copy';
    const attempt = job.attemptsMade + 1;

    // --- Cancellation setup ---
    // A "please stop" flag lives in Redis at cancel:<jobId>. We poll for it
    // every couple seconds and, if set, kill whatever process is currently
    // running and unwind the job as cancelled (not a failure, no retry).
    let cancelled = false;
    const currentProcess = { current: null };
    const cancelCheckInterval = setInterval(async () => {
      try {
        const flag = await connection.get(`cancel:${job.id}`);
        if (flag) {
          cancelled = true;
          if (currentProcess.current) {
            currentProcess.current.kill('SIGKILL');
          }
        }
      } catch {
        // Ignore transient Redis errors here — not worth failing the job over.
      }
    }, 2000);

    function throwIfCancelled() {
      if (cancelled) {
        throw new UnrecoverableError('Job was cancelled by user');
      }
    }

    // Every temp file this job might create, tracked so we can always
    // clean up fully regardless of which path succeeds or fails.
    const tempFiles = [];
    const rawPath = path.join(DOWNLOADS_DIR, `${fileId}-raw.mp4`);
    const videoOnlyPath = path.join(DOWNLOADS_DIR, `${fileId}-video.mp4`);
    const audioOnlyPath = path.join(DOWNLOADS_DIR, `${fileId}-audio.m4a`);
    const trimmedVideoPath = path.join(DOWNLOADS_DIR, `${fileId}-video-trimmed.mp4`);
    const trimmedAudioPath = path.join(DOWNLOADS_DIR, `${fileId}-audio-trimmed.m4a`);
    const finalPath = path.join(DOWNLOADS_DIR, `${fileId}-final.mp4`);

    try {
      if (attempt > 1) {
        await job.updateProgress({
          stage: 'reconnecting', percent: 0, attempt, maxAttempts: MAX_ATTEMPTS, weakConnection: true,
        });
      }

      if (!wantsTrim) {
        // ---------- NO TRIM: download (merging if needed), optionally fix audio ----------
        tempFiles.push(rawPath);
        const reportDownload = makeStageReporter(job, {
          rangeStart: 10, rangeEnd: 70, stage: 'downloading', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        await job.updateProgress({ stage: 'downloading', percent: 10, attempt, maxAttempts: MAX_ATTEMPTS });
        await downloadCombined({ url, formatId, hasAudio, outputPath: rawPath, onProgress: reportDownload, processRef: currentProcess });
        throwIfCancelled();

        if (needsAudioSafety(url)) {
          tempFiles.push(finalPath);
          const reportFinal = makeStageReporter(job, {
            rangeStart: 70, rangeEnd: 99, stage: 'finalizing', attempt, maxAttempts: MAX_ATTEMPTS,
          });
          await ensureAacAudio({ inputPath: rawPath, outputPath: finalPath, totalDurationSec: duration, onProgress: reportFinal, processRef: currentProcess });
          throwIfCancelled();
          safeUnlink(rawPath);
        } else {
          // No known audio risk on this platform — the raw download IS the final file.
          fs.renameSync(rawPath, finalPath);
        }
      } else if (hasAudio) {
        // ---------- TRIM, single combined stream: download -> trim by copy ----------
        tempFiles.push(rawPath, finalPath);
        const reportDownload = makeStageReporter(job, {
          rangeStart: 10, rangeEnd: 60, stage: 'downloading', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        await job.updateProgress({ stage: 'downloading', percent: 10, attempt, maxAttempts: MAX_ATTEMPTS });
        await downloadSingleFormat({ url, formatId, outputPath: rawPath, onProgress: reportDownload, processRef: currentProcess });
        throwIfCancelled();

        const reportTrim = makeStageReporter(job, {
          rangeStart: 60, rangeEnd: 99, stage: 'trimming', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        await trimStream({
          inputPath: rawPath, outputPath: finalPath, startTime, endTime,
          videoCodec: 'copy', audioCodec, onProgress: reportTrim, processRef: currentProcess,
        });
        throwIfCancelled();
        safeUnlink(rawPath);
      } else {
        // ---------- TRIM, separate video+audio streams: download both, trim both, merge ----------
        tempFiles.push(videoOnlyPath, audioOnlyPath, trimmedVideoPath, trimmedAudioPath, finalPath);

        const reportVideoDl = makeStageReporter(job, {
          rangeStart: 10, rangeEnd: 35, stage: 'downloading video', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        await job.updateProgress({ stage: 'downloading video', percent: 10, attempt, maxAttempts: MAX_ATTEMPTS });
        await downloadSingleFormat({ url, formatId, outputPath: videoOnlyPath, onProgress: reportVideoDl, processRef: currentProcess });
        throwIfCancelled();

        const reportAudioDl = makeStageReporter(job, {
          rangeStart: 35, rangeEnd: 50, stage: 'downloading audio', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        await downloadBestAudio({ url, outputPath: audioOnlyPath, onProgress: reportAudioDl, processRef: currentProcess });
        throwIfCancelled();

        const reportVideoTrim = makeStageReporter(job, {
          rangeStart: 50, rangeEnd: 65, stage: 'trimming video', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        await trimStream({
          inputPath: videoOnlyPath, outputPath: trimmedVideoPath, startTime, endTime,
          videoCodec: 'copy', audioCodec: 'copy', onProgress: reportVideoTrim, processRef: currentProcess,
        });
        throwIfCancelled();
        safeUnlink(videoOnlyPath);

        const reportAudioTrim = makeStageReporter(job, {
          rangeStart: 65, rangeEnd: 80, stage: 'trimming audio', attempt, maxAttempts: MAX_ATTEMPTS,
        });
        // Audio-only input: videoCodec is irrelevant here (no video stream present).
        await trimStream({
          inputPath: audioOnlyPath, outputPath: trimmedAudioPath, startTime, endTime,
          videoCodec: 'copy', audioCodec, onProgress: reportAudioTrim, processRef: currentProcess,
        });
        throwIfCancelled();
        safeUnlink(audioOnlyPath);

        await job.updateProgress({ stage: 'merging', percent: 90, attempt, maxAttempts: MAX_ATTEMPTS });
        await mergeStreams({ videoPath: trimmedVideoPath, audioPath: trimmedAudioPath, outputPath: finalPath, processRef: currentProcess });
        throwIfCancelled();
        safeUnlink(trimmedVideoPath);
        safeUnlink(trimmedAudioPath);
      }

      await job.updateProgress({ stage: 'done', percent: 100, attempt, maxAttempts: MAX_ATTEMPTS });
      return { filePath: finalPath, title };
    } catch (err) {
      // Clean up every temp file this attempt might have created, whether
      // it failed, was cancelled, or partially completed.
      for (const f of tempFiles) safeUnlink(f);

      if (cancelled || err instanceof UnrecoverableError) {
        throw new UnrecoverableError('Job was cancelled by user');
      }
      if (err.message === 'PROCESS_KILLED') {
        // A process was killed but not due to our own cancellation flag —
        // treat as a normal failure so the retry system still handles it.
        throw new Error('A processing step was interrupted unexpectedly');
      }
      throw err;
    } finally {
      clearInterval(cancelCheckInterval);
    }
  },
  {
    connection,
    lockDuration: 10 * 60 * 1000,
    // Dropped to 1 after an out-of-memory crash on Render's free tier
    // (512MB), to isolate whether concurrency was the cause before
    // considering bigger architectural changes.
    concurrency: 1,
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