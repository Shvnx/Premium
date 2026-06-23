const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  host: 'sql306.byetcluster.com',
  user: 'if0_42250740',
  password: 'Shovan7131',
  database: 'if0_42250740_licenses'
};

function getClientIP(req) {
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '0.0.0.0';
}

app.get('/', (req, res) => res.send('SPIDEY Backend Running ✅'));

app.post('/check_license.php', async (req, res) => {
  const { action, key } = req.body || {};
  const keyCode = (key || '').trim();
  const clientIP = getClientIP(req);

  if (action !== 'verify') return res.json({ valid: false, reason: 'Unknown action' });
  if (!keyCode) return res.json({ valid: false, reason: 'No key provided' });

  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute('SELECT * FROM licenses WHERE key_code = ?', [keyCode]);

    if (!rows.length) return res.json({ valid: false, reason: 'Invalid key' });

    const row = rows[0];

    if (!row.is_active) return res.json({ valid: false, reason: 'Key revoked' });

    if (!row.activated_at) {
      const expiresAt = new Date(Date.now() + row.duration_minutes * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      await conn.execute(
        'UPDATE licenses SET activated_at = NOW(), expires_at = ?, bound_ip = ? WHERE id = ?',
        [expiresAt, clientIP, row.id]
      );
      return res.json({ valid: true, expires_at: expiresAt, message: 'Activated successfully' });
    }

    if (row.bound_ip !== clientIP) return res.json({ valid: false, reason: 'This key is locked to another device/IP' });
    if (new Date(row.expires_at) < new Date()) return res.json({ valid: false, reason: 'Key expired' });

    return res.json({ valid: true, expires_at: row.expires_at, message: 'Valid' });

  } catch (e) {
    console.error('DB Error:', e.message);
    return res.json({ valid: false, reason: 'Server error: ' + e.message });
  } finally {
    if (conn) await conn.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SPIDEY backend running on port', PORT));
