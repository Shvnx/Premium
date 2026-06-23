const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory store ──
let schedules = [];
let licenses = {
  "SPIDEY-1234-ABCD": { expires_at: "2099-12-31", active: true },
  "SPIDEY-5678-EFGH": { expires_at: "2099-12-31", active: true }
};

// ── License verify ──
app.post('/check_license.php', (req, res) => {
  const { action, key } = req.body;
  if (action === 'verify') {
    const lic = licenses[key];
    if (lic && lic.active) {
      res.json({ valid: true, expires_at: lic.expires_at });
    } else {
      res.json({ valid: false, reason: 'Invalid or expired key' });
    }
  }
});

// ── SMM API proxy ──
app.post('/api/smm', async (req, res) => {
  try {
    const response = await axios.post(req.body.apiUrl, new URLSearchParams({
      key: req.body.apiKey,
      ...req.body.params
    }));
    res.json(response.data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Schedule run ──
app.post('/api/schedule/add', (req, res) => {
  const s = req.body;
  s.id = Date.now();
  s.currentLeg = 0;
  s.active = true;
  s.nextRun = Date.now() + (s.intervalMs || 3600000);
  schedules.push(s);
  res.json({ success: true, id: s.id });
});

app.get('/api/schedule/list', (req, res) => {
  res.json(schedules);
});

app.post('/api/schedule/delete', (req, res) => {
  schedules = schedules.filter(s => s.id != req.body.id);
  res.json({ success: true });
});

// ── Cron: every minute check schedules ──
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  for (const s of schedules) {
    if (!s.active || now < s.nextRun) continue;
    if (s.currentLeg >= s.totalLegs) { s.active = false; continue; }
    try {
      await axios.post(s.apiUrl, new URLSearchParams({
        key: s.apiKey,
        action: 'add',
        service: s.serviceId,
        link: s.link,
        quantity: s.quantity
      }));
      s.currentLeg++;
      s.nextRun = now + (s.intervalMs || 3600000);
    } catch(e) {
      console.log('Order error:', e.message);
    }
  }
});

// ── Keep alive ──
app.get('/', (req, res) => res.send('SPIDEY Backend Running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
