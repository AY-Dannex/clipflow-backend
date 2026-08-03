const { spawn } = require('child_process');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * Converts "HH:MM:SS", "MM:SS", or a plain number of seconds into total seconds.
 */
function toSeconds(time) {
  if (time === undefined || time === null || time === '') return null;
  if (typeof time === 'number') return time;

  const parts = String(time).split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return m * 60 + s;
  }
  return parts[0];
}

// Parses ffmpeg's "-progress pipe:1" machine-readable output (key=value
// lines) and reports percent complete based on the known total duration.
function watchFfmpegProgress(proc, totalDurationSec, onProgress) {
  if (!onProgress || !totalDurationSec) return;

  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const match = line.match(/out_time_ms=(\d+)/);
      if (match) {
        const elapsedSec = parseInt(match[1], 10) / 1_000_000; // out_time_ms is actually microseconds
        const percent = Math.min(100, (elapsedSec / totalDurationSec) * 100);
        onProgress(percent);
      }
    }
  });
}

/**
 * Trims a file to a specific start time + duration. Works for video,
 * audio-only, or combined files — whatever streams exist get copied.
 * videoCodec/audioCodec default to 'copy' (fast, no re-encoding). Pass
 * audioCodec: 'aac' when the source audio needs converting for compatibility
 * (used for YouTube and TikTok specifically — see worker.js).
 */
function trimStream({ inputPath, outputPath, startTime, endTime, videoCodec = 'copy', audioCodec = 'copy', processRef, onProgress }) {
  return new Promise((resolve, reject) => {
    const startSec = toSeconds(startTime) || 0;
    const endSec = toSeconds(endTime);

    if (endSec === null || endSec - startSec <= 0) {
      reject(new Error('endTime must be after startTime'));
      return;
    }
    const clipDuration = endSec - startSec;

    const args = ['-y', '-i', inputPath];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-t', String(clipDuration));
    args.push('-c:v', videoCodec, '-c:a', audioCodec);
    if (audioCodec === 'aac') args.push('-b:a', '192k');
    args.push('-progress', 'pipe:1', '-nostats');
    args.push(outputPath);

    const proc = spawn(FFMPEG_PATH, args);
    if (processRef) processRef.current = proc;
    watchFfmpegProgress(proc, clipDuration, onProgress);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (processRef) processRef.current = null;
      if (signal === 'SIGKILL') {
        reject(new Error('PROCESS_KILLED'));
      } else if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

/**
 * Merges a separately-trimmed video file and audio file into one final
 * file, using fast stream copy (no re-encoding).
 */
function mergeStreams({ videoPath, audioPath, outputPath, processRef }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      outputPath,
    ];

    const proc = spawn(FFMPEG_PATH, args);
    if (processRef) processRef.current = proc;

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (processRef) processRef.current = null;
      if (signal === 'SIGKILL') {
        reject(new Error('PROCESS_KILLED'));
      } else if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

/**
 * Re-encodes just the audio track to AAC while keeping the video untouched
 * ("copy" = no re-encoding, so this is fast). Used for the no-trim path on
 * platforms where the source audio format is known to cause playback
 * issues (YouTube's Opus tracks, TikTok's occasional audio problems).
 */
function ensureAacAudio({ inputPath, outputPath, totalDurationSec, processRef, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-progress', 'pipe:1', '-nostats',
      outputPath,
    ];

    const proc = spawn(FFMPEG_PATH, args);
    if (processRef) processRef.current = proc;
    watchFfmpegProgress(proc, totalDurationSec, onProgress);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (processRef) processRef.current = null;
      if (signal === 'SIGKILL') {
        reject(new Error('PROCESS_KILLED'));
      } else if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

module.exports = { trimStream, mergeStreams, ensureAacAudio, toSeconds };