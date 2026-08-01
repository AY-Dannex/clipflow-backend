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
 * Trims a video to a specific start time + duration.
 * Calls onProgress(percent 0-100) as ffmpeg works, if provided.
 */
function trimVideo({ inputPath, outputPath, startTime, endTime, onProgress }) {
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
    args.push('-c:v', 'libx264', '-c:a', 'aac');
    args.push('-progress', 'pipe:1', '-nostats');
    args.push(outputPath);

    const proc = spawn(FFMPEG_PATH, args);
    watchFfmpegProgress(proc, clipDuration, onProgress);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

/**
 * Re-encodes just the audio track to AAC while keeping the video untouched
 * ("copy" = no re-encoding, so this is fast). Used when no trimming is
 * requested, so we still guarantee AAC audio for player compatibility.
 * Calls onProgress(percent 0-100) as ffmpeg works, if provided.
 */
function ensureAacAudio({ inputPath, outputPath, totalDurationSec, onProgress }) {
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
    watchFfmpegProgress(proc, totalDurationSec, onProgress);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

module.exports = { trimVideo, ensureAacAudio };