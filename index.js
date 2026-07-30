require('dotenv').config();
const express = require('express');
const cors = require('cors');
const videoInfoRoute = require('./routes/videoInfo');
const downloadRoute = require('./routes/download');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Video downloader backend is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// TEMPORARY diagnostic route — safe to leave in briefly, doesn't expose
// cookie contents, only whether things are set up correctly. Remove once
// the cookies issue is resolved.
app.get('/debug/cookies-check', (req, res) => {
  const fs = require('fs');
  const envValue = process.env.YTDLP_COOKIES_FILE || null;
  let fileExists = false;
  let fileSize = null;
  let firstLine = null;

  if (envValue) {
    try {
      fileExists = fs.existsSync(envValue);
      if (fileExists) {
        const stats = fs.statSync(envValue);
        fileSize = stats.size;
        const content = fs.readFileSync(envValue, 'utf8');
        firstLine = content.split('\n')[0]; // just the comment header line, not sensitive
      }
    } catch (err) {
      firstLine = `Error reading file: ${err.message}`;
    }
  }

  res.json({
    envVarSet: Boolean(envValue),
    envVarValue: envValue,
    fileExists,
    fileSize,
    firstLine,
  });
});

app.use('/api', videoInfoRoute);
app.use('/api', downloadRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});