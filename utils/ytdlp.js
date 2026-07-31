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

// On cloud servers, YouTube's default web-client verification often flags
// the request as a bot regardless of valid cookies (datacenter IPs are
// heavily scrutinized) — WARP (see start.sh) is our main defense against
// that now. Requesting both "web" and "android" clients gives us the full
// quality range from web, with android as an automatic fallback if web
// alone gets blocked for a given request.
function addClientArgs(args) {
  args.push('--extractor-args', 'youtube:player_client=web,mweb');
  return args;
}

// Optional: route yt-dlp's traffic through a proxy (e.g. Cloudflare WARP's
// local SOCKS5 proxy at socks5://127.0.0.1:40000), set by start.sh if WARP
// connects successfully. If unset, requests go out normally.
function addProxyArgs(args) {
  if (process.env.PROXY_URL) {
    args.push('--proxy', process.env.PROXY_URL);
  }
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
        // Log warnings even on success — yt-dlp often silently drops
        // formats it can't fully verify and only mentions why via stderr
        // warnings, which we'd otherwise never see.
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
  const output = await runYtDlp(addProxyArgs(addClientArgs(['--dump-json', '--no-playlist', url])));
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
 * Returns the full path to the downloaded file.
 */
function downloadVideo({ url, formatId, outputPath }) {
  return new Promise((resolve, reject) => {
    const formatSelector = `${formatId}+bestaudio/best`;

    let args = [
      '--no-playlist',
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      url,
    ];

    if (process.env.FFMPEG_PATH) {
      args.push('--ffmpeg-location', process.env.FFMPEG_PATH);
    }

    args = addCookieArgs(args);
    args = addClientArgs(args);
    args = addProxyArgs(args);

    const proc = spawn(YTDLP_PATH, args);

    let stderr = '';

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