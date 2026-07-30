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

/**
 * Trims a video to a specific start time + duration.
 * Using -ss (after -i) + -t (duration) instead of -ss + -to avoids
 * a known ffmpeg ambiguity where -to can be misinterpreted depending on option order.
 */
function trimVideo({ inputPath, outputPath, startTime, endTime }) {
  return new Promise((resolve, reject) => {
    const startSec = toSeconds(startTime) || 0;
    const endSec = toSeconds(endTime);

    const args = ['-y', '-i', inputPath];

    if (startSec > 0) {
      args.push('-ss', String(startSec));
    }

    if (endSec !== null) {
      const duration = endSec - startSec;
      if (duration <= 0) {
        reject(new Error('endTime must be after startTime'));
        return;
      }
      args.push('-t', String(duration));
    }

    args.push('-c:v', 'libx264', '-c:a', 'aac', outputPath);

    const proc = spawn(FFMPEG_PATH, args);

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

module.exports = { trimVideo };

/**
 * Re-encodes just the audio track to AAC while keeping the video untouched
 * ("copy" = no re-encoding, so this is fast). Used when no trimming is
 * requested, so we still guarantee AAC audio for player compatibility.
 */
function ensureAacAudio({ inputPath, outputPath }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath,
    ];

    const proc = spawn(FFMPEG_PATH, args);

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

module.exports.ensureAacAudio = ensureAacAudio;