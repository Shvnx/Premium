const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  host: 'sql12.freesqldatabase.com',
  user: 'sql12831389',
  password: 'D8QfVPcSJD',
  database: 'sql12831389',
  port: 3306
};

function getClientIP(req) {
  return req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '0.0.0.0';
}

async function initDB() {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS licenses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        key_code VARCHAR(255) NOT NULL UNIQUE,
        is_active TINYINT(1) DEFAULT 1,
        duration_minutes INT DEFAULT 43200,
        activated_at DATETIME DEFAULT NULL,
        expires_at DATETIME DEFAULT NULL,
        bound_ip VARCHAR(100) DEFAULT NULL
      )
    `);
    console.log('✅ DB connected & table ready');
  } catch(e) {
    console.error('❌ DB init error:', e.message);
  } finally {
    if (conn) await conn.end();
  }
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
    if (row.bound_ip !== clientIP) return res.json({ valid: false, reason: 'IP locked to another device' });
    if (new Date(row.expires_at) < new Date()) return res.json({ valid: false, reason: 'Key expired' });
    return res.json({ valid: true, expires_at: row.expires_at, message: 'Valid' });
  } catch (e) {
    return res.json({ valid: false, reason: 'Server error: ' + e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// Add license
app.post('/add_license', async (req, res) => {
  const { key, duration_minutes, admin_secret } = req.body || {};
  if (admin_secret !== 'spidey_admin_2024') return res.json({ success: false, reason: 'Unauthorized' });
  if (!key) return res.json({ success: false, reason: 'No key provided' });
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    await conn.execute(
      'INSERT INTO licenses (key_code, duration_minutes) VALUES (?, ?)',
      [key.trim().toUpperCase(), duration_minutes || 43200]
    );
    return res.json({ success: true, message: 'License added: ' + key });
  } catch(e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// List all licenses
app.post('/list_licenses', async (req, res) => {
  const { admin_secret } = req.body || {};
  if (admin_secret !== 'spidey_admin_2024') return res.json({ success: false, reason: 'Unauthorized' });
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute('SELECT * FROM licenses ORDER BY id DESC');
    return res.json({ success: true, licenses: rows });
  } catch(e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// Delete license
app.post('/delete_license', async (req, res) => {
  const { id, admin_secret } = req.body || {};
  if (admin_secret !== 'spidey_admin_2024') return res.json({ success: false, reason: 'Unauthorized' });
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    await conn.execute('DELETE FROM licenses WHERE id = ?', [id]);
    return res.json({ success: true, message: 'Deleted' });
  } catch(e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

initDB();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SPIDEY backend running on port', PORT));
