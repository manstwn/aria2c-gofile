const cron = require('node-cron');
const axios = require('axios');
const db = require('./db');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getRandomDelayMs() {
  // Random delay between 2000ms (2s) and 7000ms (7s)
  return Math.floor(2000 + Math.random() * 5000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const logger = require('./logger');

/**
 * Ping a single file's download page to keep it active
 * @param {object} file File record object from database
 */
async function touchFileRecord(file) {
  if (!file || !file.download_url) {
    console.warn(`[TouchManager] Skipping invalid record:`, file);
    return false;
  }

  console.log(`[TouchManager] Pinging ${file.filename} (${file.download_url})...`);
  const token = (process.env.GOFILE_API_TOKEN || '').trim();
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json, text/html, */*'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Primary ping target: GoFile Contents API for instant non-blocking check
  let targetUrl = file.download_url;
  if (file.gofile_id) {
    targetUrl = `https://api.gofile.io/contents/${file.gofile_id}`;
  }

  logger.debug(`[TouchManager Debug] Target URL: ${targetUrl} | Auth Token Present: ${!!token}`);

  try {
    const response = await axios.get(targetUrl, {
      headers,
      timeout: 6000,
      validateStatus: status => status < 500
    });

    logger.debug(`[TouchManager Debug] Response Status: ${response.status} | Data:`, JSON.stringify(response.data || {}));

    const isOk = response.status === 200 && (response.data?.status === 'ok' || !response.data?.status);
    const isNotFound = response.status === 404 || response.data?.status === 'error-notFound';

    if (isOk) {
      const updated = db.updateFile(file.id, {
        last_touched: new Date().toISOString(),
        status: 'LIVE'
      });
      console.log(`[TouchManager] Touch SUCCESS (200 OK) for ${file.filename}. Updated last_touched.`);
      return { success: true, status: 'LIVE', file: updated };
    } else if (isNotFound) {
      const updated = db.updateFile(file.id, {
        status: 'DEAD'
      });
      console.warn(`[TouchManager] Touch FAILED (404 / Not Found) for ${file.filename}. Marked status as DEAD.`);
      return { success: false, status: 'DEAD', file: updated };
    } else {
      console.warn(`[TouchManager] Received HTTP ${response.status} for ${file.filename}. Leaving status untouched.`);
      return { success: false, status: file.status, file };
    }
  } catch (err) {
    // If API ping failed/timed out, try fallback GET on raw download_url
    if (targetUrl !== file.download_url) {
      try {
        const fallbackRes = await axios.get(file.download_url, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: 6000,
          validateStatus: status => status < 500
        });
        if (fallbackRes.status === 200) {
          const updated = db.updateFile(file.id, { last_touched: new Date().toISOString(), status: 'LIVE' });
          console.log(`[TouchManager] Touch SUCCESS via webpage fallback for ${file.filename}.`);
          return { success: true, status: 'LIVE', file: updated };
        }
      } catch (e) {}
    }

    console.error(`[TouchManager Warning] Ping error for ${file.filename}: ${err.message}`);
    if (err.response && err.response.status === 404) {
      const updated = db.updateFile(file.id, { status: 'DEAD' });
      return { success: false, status: 'DEAD', file: updated };
    }
    return { success: false, status: file.status, error: err.message, file };
  }
}

/**
 * Touch a single file by ID
 */
async function touchSingleFile(id) {
  const file = db.getFileById(id);
  if (!file) {
    throw new Error(`File record not found for ID: ${id}`);
  }
  return await touchFileRecord(file);
}

/**
 * Run Touch routine across all eligible LIVE files with rate limiting
 * @param {boolean} forceAll If true, touches all LIVE files regardless of last_touched timestamp
 */
async function runTouchRoutine(forceAll = false) {
  console.log(`[TouchManager] Starting ${forceAll ? 'manual' : 'scheduled'} touch routine...`);
  const files = db.getAllFiles();
  const now = Date.now();
  const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;

  const eligibleFiles = files.filter(file => {
    if (file.status !== 'LIVE') return false;
    if (forceAll) return true;

    const lastTouchedTime = new Date(file.last_touched).getTime();
    return (now - lastTouchedTime) >= TWENTY_THREE_HOURS_MS;
  });

  console.log(`[TouchManager] Found ${eligibleFiles.length} eligible LIVE file(s) to touch.`);

  const results = [];
  for (let i = 0; i < eligibleFiles.length; i++) {
    const file = eligibleFiles[i];

    // Introduce random 2-7s delay between pings to prevent rate limits
    if (i > 0) {
      const delay = getRandomDelayMs();
      console.log(`[TouchManager] Rate limiting: waiting ${(delay / 1000).toFixed(1)}s before next ping...`);
      await sleep(delay);
    }

    const res = await touchFileRecord(file);
    results.push(res);
  }

  console.log(`[TouchManager] Touch routine complete. Processed ${results.length} files.`);
  return results;
}

/**
 * Initialize daily cron job schedule (Executes every day at 00:00)
 */
function initScheduler() {
  console.log('[TouchManager] Initializing daily cron scheduler (0 0 * * *)...');
  // Runs every day at midnight
  cron.schedule('0 0 * * *', () => {
    runTouchRoutine(false).catch(err => {
      console.error('[TouchManager] Daily cron error:', err);
    });
  });
}

module.exports = {
  touchSingleFile,
  runTouchRoutine,
  initScheduler
};
