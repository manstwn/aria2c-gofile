const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config();

const db = require('./src/db');
const auth = require('./src/auth');
const aria2 = require('./src/aria2');
const touchManager = require('./src/touchManager');

const app = express();
const PORT = process.env.PORT || 6258;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static UI assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Serve generated thumbnails from data/image directory
app.use('/data/image', express.static(path.join(__dirname, 'data/image')));

/* ==========================================================================
   PUBLIC AUTH ROUTES
   ========================================================================== */

app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'PIN is required' });
  }

  if (auth.verifyPin(pin)) {
    const token = auth.generateToken();
    res.cookie('gotouch_token', token, {
      httpOnly: true,
      secure: false, // Localhost/http supported; set true in HTTPS reverse proxy
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    return res.json({ success: true, message: 'Authentication successful', token });
  } else {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies?.gotouch_token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  const decoded = auth.verifyToken(token);
  if (decoded) {
    return res.json({ authenticated: true });
  } else {
    return res.status(401).json({ authenticated: false });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('gotouch_token');
  res.json({ success: true, message: 'Logged out' });
});

/* ==========================================================================
   REAL-TIME SERVER-SENT EVENTS (SSE) STREAMING
   ========================================================================== */

app.get('/api/stream', (req, res) => {
  const token = req.cookies?.gotouch_token || req.query.token;
  const decoded = auth.verifyToken(token);
  if (!decoded) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const sendUpdate = async () => {
    try {
      const downloads = await aria2.getDownloadsStatus();
      const conn = await aria2.checkConnection();
      const files = db.getAllFiles();
      res.write(`data: ${JSON.stringify({ downloads, conn, files })}\n\n`);
    } catch (err) {}
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

/* ==========================================================================
   PROTECTED API ROUTES (Require PIN Authentication)
   ========================================================================== */

// Download Orchestration Routes
app.get('/api/downloads', auth.requireAuth, async (req, res) => {
  try {
    const status = await aria2.getDownloadsStatus();
    const conn = await aria2.checkConnection();
    res.json({ aria2Connection: conn, downloads: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/downloads', auth.requireAuth, async (req, res) => {
  try {
    const { url, filename, customFilename } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required.' });
    }

    const conn = await aria2.checkConnection();
    if (!conn.online) {
      return res.status(503).json({
        error: 'Aria2 RPC daemon is offline.',
        details: 'Make sure aria2c is running with RPC enabled at ' + (process.env.ARIA2_RPC_URL || 'http://127.0.0.1:6800/jsonrpc')
      });
    }

    const chosenName = filename || customFilename || '';
    const gid = await aria2.addDownload(url, chosenName);
    res.json({ success: true, gid, message: 'Download task submitted successfully with 16 connections enforced.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/downloads/:gid', auth.requireAuth, async (req, res) => {
  try {
    const { gid } = req.params;
    await aria2.removeDownload(gid);
    res.json({ success: true, message: 'Download task cancelled.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File Ledger Routes
app.get('/api/files', auth.requireAuth, (req, res) => {
  try {
    const files = db.getAllFiles();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/:id/touch', auth.requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await touchManager.touchSingleFile(id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/files/touch-all', auth.requireAuth, async (req, res) => {
  try {
    // Force touch on all LIVE files on demand
    const results = await touchManager.runTouchRoutine(true);
    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/files/:id', auth.requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const deleted = db.deleteFile(id);
    if (deleted) {
      res.json({ success: true, message: 'Record deleted from ledger.' });
    } else {
      res.status(404).json({ error: 'Record not found.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve SPA fallback for HTML requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Background Services & Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  GoTouch Manager Server running on http://localhost:${PORT}`);
  console.log(`  Target Audience: Single-user / Self-hosted Admin`);
  console.log(`=======================================================`);

  // Initialize Background Daemon Monitors
  aria2.startMonitor();
  touchManager.initScheduler();
});
