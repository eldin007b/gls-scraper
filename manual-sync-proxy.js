// manual-sync-proxy.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// === Postavi svoj GitHub personal access token ===
const GITHUB_TOKEN = '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'; // <-- tvoj token ovdje!
const GITHUB_REPO = 'eldin007b/gls-scraper'; // user/repo
const WORKFLOW_FILE = 'scraper.yml'; // naziv workflow fajla

app.use(express.json());

// === Health endpoint (opcionalno) ===
app.get('/', (req, res) => {
  res.send('Manual Sync Proxy radi!');
});

// === Glavna ruta za ručni sync ===
app.post('/pokreni-scraper', async (req, res) => {
  try {
    await axios.post(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      { ref: 'main' }, // ili "master" ako je glavna grana master!
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    res.json({ success: true, message: 'Sinhronizacija pokrenuta u cloudu!' });
  } catch (err) {
    console.error('Greška prilikom dispatch-a:', err?.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Nešto nije u redu. Pokušaj ponovo.' });
  }
});

// === PORT: koristi Render-ov ili 4050 lokalno ===
const PORT = process.env.PORT || 4050;
app.listen(PORT, () => console.log(`Manual Sync Proxy running on ${PORT}`));
