const { spawn } = require('child_process');

// Path to the yt-dlp executable.
// On Windows, if yt-dlp isn't recognized in your terminal globally,
// set YTDLP_PATH in your .env file to the full path, e.g.:
// YTDLP_PATH=C:\Users\Daniel\AppData\Local\Python\pythoncore-3.14-64\Scripts\yt-dlp.exe
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

// Optional: name of a browser to borrow cookies from (e.g. "chrome", "edge", "firefox").
// Less reliable on Windows since Chromium browsers often lock their cookie file.
const COOKIES_BROWSER = process.env.YTDLP_COOKIES_BROWSER;

// Optional: path to an exported cookies.txt file (more reliable than COOKIES_BROWSER).
// If set, this takes priority.
const COOKIES_FILE = process.env.YTDLP_COOKIES_FILE;

function addCookieArgs(args) {
  if (COOKIES_FILE) {
    args.push('--cookies', COOKIES_FILE);
  } else if (COOKIES_BROWSER) {
    args.push('--cookies-from-browser', COOKIES_BROWSER);
  }
  return args;
}

// Optional: route yt-dlp's traffic through a proxy (Cloudflare WARP's local
// SOCKS5 proxy at socks5://127.0.0.1:40000), set by start.sh if WARP
// connects successfully on Render. Locally this stays unset.
function addProxyArgs(args) {
  if (process.env.PROXY_URL) {
    args.push('--proxy', process.env.PROXY_URL);
  }
  return args;
}

// Newer yt-dlp versions require explicit permission to download/use their
// updated JS-challenge-solving component — without this, it silently skips
// solving YouTube's challenges and most formats become unavailable, even
// with Deno already installed.
function addRemoteComponentArgs(args) {
  args.push('--remote-components', 'ejs:github');
  return args;
}

/**
 * Runs yt-dlp with the given arguments and returns stdout as a string.
 * Rejects with a readable error message if yt-dlp fails.
 */
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_PATH, addCookieArgs(args));

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      } else {
        if (stderr.trim()) {
          console.log('yt-dlp warnings:', stderr.trim());
        }
        resolve(stdout);
      }
    });
  });
}

/**
 * Fetches metadata + available formats for a given video URL.
 */
async function getVideoInfo(url) {
  const output = await runYtDlp(addRemoteComponentArgs(addProxyArgs(['--dump-json', '--no-playlist', url])));
  const data = JSON.parse(output);

  const formats = (data.formats || [])
    .filter((f) => f.vcodec !== 'none')
    .map((f) => ({
      format_id: f.format_id,
      quality: f.format_note || (f.height ? `${f.height}p` : 'unknown'),
      ext: f.ext,
      height: f.height || 0,
      filesize: f.filesize || f.filesize_approx || null,
    }))
    .filter((f, index, arr) => arr.findIndex((x) => x.quality === f.quality) === index)
    .sort((a, b) => b.height - a.height);

  return {
    title: data.title,
    thumbnail: data.thumbnail,
    duration: data.duration,
    isLive: data.is_live || false,
    uploader: data.uploader,
    formats,
  };
}

/**
 * Downloads a video to a local file using yt-dlp.
 * Calls onProgress(percent) with yt-dlp's real download progress (0-100)
 * as it happens, parsed from its stdout output.
 * Returns the full path to the downloaded file.
 */
function downloadVideo({ url, formatId, outputPath, onProgress }) {
  return new Promise((resolve, reject) => {
    const formatSelector = `${formatId}+bestaudio/best`;

    let args = [
      '--no-playlist',
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--newline', // forces one progress line per update instead of overwriting a single line, so we can read each one
      '-o', outputPath,
      url,
    ];

    if (process.env.FFMPEG_PATH) {
      args.push('--ffmpeg-location', process.env.FFMPEG_PATH);
    }

    args = addCookieArgs(args);
    args = addProxyArgs(args);
    args = addRemoteComponentArgs(args);

    const proc = spawn(YTDLP_PATH, args);

    let stderr = '';
    let stdoutBuffer = '';
    // yt-dlp prints lines like: [download]  45.2% of   10.00MiB at  1.20MiB/s ETA 00:04
    const progressPattern = /\[download\]\s+(\d+(?:\.\d+)?)%/;

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // keep the last, possibly incomplete line for next time

      if (onProgress) {
        for (const line of lines) {
          const match = line.match(progressPattern);
          if (match) {
            onProgress(parseFloat(match[1]));
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

module.exports = { runYtDlp, getVideoInfo, downloadVideo };