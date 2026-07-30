const express = require('express');
const { getVideoInfo } = require('../utils/ytdlp');

const router = express.Router();

// POST /api/video-info
// Body: { "url": "https://..." }
router.post('/video-info', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  try {
    const info = await getVideoInfo(url);
    res.json(info);
  } catch (err) {
    console.error('Error fetching video info:', err.message);
    res.status(500).json({ error: 'Could not fetch video info', details: err.message });
  }
});

module.exports = router;