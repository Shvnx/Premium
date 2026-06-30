const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false
  }
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
        bound_ip VARCHAR(100) DEFAULT NULL,
        bound_device_id VARCHAR(255) DEFAULT NULL
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schedules (
        id BIGINT PRIMARY KEY,
        owner_key VARCHAR(255) DEFAULT NULL,
        name VARCHAR(255),
        link TEXT,
        api_url TEXT,
        api_key TEXT,
        services_json LONGTEXT,
        leg_duration INT,
        leg_duration_unit VARCHAR(20),
        mode VARCHAR(50),
        variance INT,
        max_orders INT DEFAULT 0,
        current_leg INT DEFAULT 0,
        active TINYINT(1) DEFAULT 1,
        next_run BIGINT,
        created BIGINT
      )
    `);
    // ✅ FIX: owner_key column ensure karo (purane DB ke liye)
    try {
      await conn.execute(`ALTER TABLE schedules ADD COLUMN owner_key VARCHAR(255) DEFAULT NULL`);
      console.log('✅ owner_key column added');
    } catch(e) {
      // Column already exists — ignore karo
    }
    // ✅ FIX: bound_device_id column ensure karo (purane DB ke liye — IP lock se device lock me migrate)
    try {
      await conn.execute(`ALTER TABLE licenses ADD COLUMN bound_device_id VARCHAR(255) DEFAULT NULL`);
      console.log('✅ bound_device_id column added');
    } catch(e) {
      // Column already exists — ignore karo
    }
    console.log('✅ DB connected & table ready');
  } catch(e) {
    console.error('❌ DB init error:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}

app.get('/', (req, res) => res.send('SPIDEY Backend Running ✅'));

app.post('/check_license.php', async (req, res) => {
  const { action, key, deviceId } = req.body || {};
  const keyCode = (key || '').trim();
  const devId = (deviceId || '').trim();
  const clientIP = getClientIP(req); // ab sirf logging/reference ke liye, lock isse nahi hota
  if (action !== 'verify') return res.json({ valid: false, reason: 'Unknown action' });
  if (!keyCode) return res.json({ valid: false, reason: 'No key provided' });
  if (!devId) return res.json({ valid: false, reason: 'No device ID provided — update app to latest version' });
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute('SELECT * FROM licenses WHERE key_code = ?', [keyCode]);
    if (!rows.length) return res.json({ valid: false, reason: 'Invalid key' });
    const row = rows[0];
    if (!row.is_active) return res.json({ valid: false, reason: 'Key revoked' });
    if (!row.activated_at) {
      // First-time activation — is device se hi lock ho jayega (IP/network kuch bhi badle, fark nahi padega)
      const expiresAt = new Date(Date.now() + row.duration_minutes * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      await conn.execute(
        'UPDATE licenses SET activated_at = NOW(), expires_at = ?, bound_ip = ?, bound_device_id = ? WHERE id = ?',
        [expiresAt, clientIP, devId, row.id]
      );
      return res.json({ valid: true, expires_at: expiresAt, message: 'Activated successfully' });
    }
    // Purani license jo IP-lock se ban chuki thi aur abhi tak koi device_id save nahi hua,
    // usko is pehle wale device se hi auto-bind kar do (taaki existing users break na ho).
    if (!row.bound_device_id) {
      await conn.execute('UPDATE licenses SET bound_device_id = ? WHERE id = ?', [devId, row.id]);
    } else if (row.bound_device_id !== devId) {
      return res.json({ valid: false, reason: 'License already activated on another device' });
    }
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

// Proxy route for CORS bypass
app.post('/proxy', async (req, res) => {
  const { url, params, _target, key, action, ...rest } = req.body || {};
  const targetUrl = url || _target;
  if (!targetUrl) return res.json({ error: 'No URL provided' });
  try {
    const fetch = (await import('node-fetch')).default;
    const forwardParams = params || { key, action, ...rest };
    const body = new URLSearchParams(forwardParams);
    const response = await fetch(targetUrl, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    try { res.json(JSON.parse(text)); } catch { res.send(text); }
  } catch(e) {
    res.json({ error: 'Proxy error: ' + e.message });
  }
});

// =========================================================
// SCHEDULES
// =========================================================

function rowToSchedule(row) {
  return {
    id: Number(row.id),
    ownerKey: row.owner_key || null,
    name: row.name,
    link: row.link,
    apiUrl: row.api_url,
    apiKey: row.api_key,
    services: JSON.parse(row.services_json || '[]'),
    legDuration: row.leg_duration,
    legDurationUnit: row.leg_duration_unit,
    mode: row.mode,
    variance: row.variance,
    maxOrders: row.max_orders,
    currentLeg: row.current_leg,
    active: !!row.active,
    nextRun: Number(row.next_run),
    created: Number(row.created)
  };
}

function getMs(amount, unit) {
  return amount * ({ minutes: 60000, hours: 3600000, days: 86400000 }[unit] || 3600000);
}

async function callPanelDirect(apiUrl, apiKey, params) {
  try {
    const fetch = (await import('node-fetch')).default;
    const body = new URLSearchParams({ key: apiKey, ...params });
    const response = await fetch(apiUrl, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { error: 'Invalid panel response' }; }
  } catch (e) {
    return { error: 'Network error: ' + e.message };
  }
}

async function executeScheduleLeg(schedule) {
  const legIdx = schedule.currentLeg || 0;
  const logsForThisRun = [];
  for (const svc of schedule.services) {
    if (legIdx >= svc.legs.length) continue;
    const qty = svc.legs[legIdx] || svc.legs[svc.legs.length - 1];
    const res = await callPanelDirect(schedule.apiUrl, schedule.apiKey, {
      action: 'add', service: svc.serviceId, link: schedule.link, quantity: qty
    });
    if (res.order) {
      svc.ordersPlaced = (svc.ordersPlaced || 0) + 1;
      logsForThisRun.push({ type: 'success', message: `Order #${res.order} | Leg ${legIdx + 1} — ${svc.serviceName || svc.type} — ${qty}` });
    } else {
      logsForThisRun.push({ type: 'error', message: `Failed (${svc.serviceName || svc.type}): ${JSON.stringify(res)}` });
    }
  }
  return logsForThisRun;
}

async function saveScheduleRow(conn, schedule) {
  await conn.execute(
    `UPDATE schedules SET services_json=?, current_leg=?, active=?, next_run=? WHERE id=?`,
    [JSON.stringify(schedule.services), schedule.currentLeg, schedule.active ? 1 : 0, schedule.nextRun, schedule.id]
  );
}

// ✅ FIX: Schedule create karte waqt licenseKey bhi save karo
app.post('/schedules/create', async (req, res) => {
  const { name, link, apiUrl, apiKey, services, legDuration, legDurationUnit, mode, variance, maxOrders, licenseKey } = req.body || {};
  if (!apiUrl || !apiKey) return res.json({ success: false, reason: 'API not connected' });
  if (!services || !services.length) return res.json({ success: false, reason: 'No services provided' });
  const id = Date.now();
  const schedule = {
    id, name, link, apiUrl, apiKey,
    services, legDuration: legDuration || 30, legDurationUnit: legDurationUnit || 'minutes',
    mode: mode || 'custom', variance: variance || 22, maxOrders: maxOrders || 0,
    currentLeg: 0, active: true, nextRun: Date.now(), created: Date.now(),
    ownerKey: (licenseKey || '').trim().toUpperCase() || null  // ✅ license key se bind
  };
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    await conn.execute(
      `INSERT INTO schedules (id, owner_key, name, link, api_url, api_key, services_json, leg_duration, leg_duration_unit, mode, variance, max_orders, current_leg, active, next_run, created)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [schedule.id, schedule.ownerKey, schedule.name, schedule.link, schedule.apiUrl, schedule.apiKey,
       JSON.stringify(schedule.services), schedule.legDuration, schedule.legDurationUnit,
       schedule.mode, schedule.variance, schedule.maxOrders,
       schedule.currentLeg, schedule.active ? 1 : 0, schedule.nextRun, schedule.created]
    );
    return res.json({ success: true, schedule });
  } catch (e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// ✅ FIX: List schedules — license_key se filter karo, api_url se nahi
app.post('/schedules/list', async (req, res) => {
  const { licenseKey } = req.body || {};
  const ownerKey = (licenseKey || '').trim().toUpperCase();
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = ownerKey
      ? await conn.execute('SELECT * FROM schedules WHERE owner_key = ? ORDER BY created DESC', [ownerKey])
      : await conn.execute('SELECT * FROM schedules ORDER BY created DESC');
    return res.json({ success: true, schedules: rows.map(rowToSchedule) });
  } catch (e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// Schedule pause/resume
app.post('/schedules/toggle', async (req, res) => {
  const { id } = req.body || {};
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute('SELECT * FROM schedules WHERE id = ?', [id]);
    if (!rows.length) return res.json({ success: false, reason: 'Not found' });
    const schedule = rowToSchedule(rows[0]);
    schedule.active = !schedule.active;
    if (schedule.active) schedule.nextRun = Date.now() + getMs(schedule.legDuration, schedule.legDurationUnit);
    await saveScheduleRow(conn, schedule);
    return res.json({ success: true, schedule });
  } catch (e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// Schedule delete
app.post('/schedules/delete', async (req, res) => {
  const { id } = req.body || {};
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    await conn.execute('DELETE FROM schedules WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// Manual Run Now
app.post('/schedules/run_now', async (req, res) => {
  const { id } = req.body || {};
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute('SELECT * FROM schedules WHERE id = ?', [id]);
    if (!rows.length) return res.json({ success: false, reason: 'Not found' });
    const schedule = rowToSchedule(rows[0]);
    const logs = await executeScheduleLeg(schedule);
    schedule.currentLeg++;
    schedule.nextRun = Date.now() + getMs(schedule.legDuration, schedule.legDurationUnit);
    await saveScheduleRow(conn, schedule);
    return res.json({ success: true, schedule, logs });
  } catch (e) {
    return res.json({ success: false, reason: e.message });
  } finally {
    if (conn) await conn.end();
  }
});

// =========================================================
// BACKGROUND LOOP
// =========================================================
async function processDueSchedules() {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute('SELECT * FROM schedules WHERE active = 1 AND next_run <= ?', [Date.now()]);
    for (const row of rows) {
      const schedule = rowToSchedule(row);
      try {
        await executeScheduleLeg(schedule);
        schedule.currentLeg++;
        const maxLegs = Math.max(...schedule.services.map(s => s.legs.length));
        const done = schedule.currentLeg >= maxLegs || (schedule.maxOrders > 0 && schedule.currentLeg >= schedule.maxOrders);
        if (done) {
          schedule.active = false;
        } else {
          schedule.nextRun = Date.now() + getMs(schedule.legDuration, schedule.legDurationUnit);
        }
        await saveScheduleRow(conn, schedule);
        console.log(`✅ Processed leg for schedule ${schedule.id} (${schedule.name})`);
      } catch (e) {
        console.error(`❌ Error processing schedule ${schedule.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ processDueSchedules error:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}

setInterval(processDueSchedules, 60 * 1000);

initDB();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SPIDEY backend running on port', PORT));
