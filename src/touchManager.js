const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the direct GoFile CDN download URL from stored record data.
 * Format: https://{cdn_server}.gofile.io/download/web/{gofile_id}/{filename}
 *
 * This is what the browser resolves to after visiting the GoFile page.
 * No API calls or tokens required — pure CDN direct link.
 */
function buildDirectCdnUrl(file) {
  const server = file.cdn_server;
  const fileId = file.gofile_id;
  const filename = file.original_filename || file.filename;

  if (server && fileId && filename) {
    return `https://${server}.gofile.io/download/web/${fileId}/${encodeURIComponent(filename)}`;
  }
  return null;
}

/**
 * Perform 1 KB Micro-Download & Abort on a single GoFile record.
 * Mimics browser download: hits CDN directly with Range header, aborts immediately.
 * @param {object} file File record object from database
 */
async function touchFileRecord(file) {
  if (!file || !file.download_url) {
    console.warn(`[TouchManager] Skipping invalid record:`, file);
    return false;
  }

  console.log(`[TouchManager] Pinging & 1KB micro-downloading ${file.filename} (${file.download_url})...`);

  // Build direct CDN URL from stored server + gofile_id + filename
  const directCdnUrl = buildDirectCdnUrl(file);

  logger.debug(`[TouchManager Debug] ─────────────────────────────────────────`);
  logger.debug(`[TouchManager Debug] 📄 File:           ${file.filename}`);
  logger.debug(`[TouchManager Debug] 🔗 GoFile Page:    ${file.download_url}`);
  logger.debug(`[TouchManager Debug] 🖥️  CDN Server:     ${file.cdn_server || 'unknown (not stored)'}`);
  logger.debug(`[TouchManager Debug] 🆔 GoFile ID:      ${file.gofile_id || 'unknown'}`);

  if (!directCdnUrl) {
    // Fallback: no cdn_server stored (old records uploaded before this fix)
    logger.debug(`[TouchManager Debug] ⚠️  No cdn_server stored for this file. Falling back to GoFile page URL.`);
    logger.debug(`[TouchManager Debug] ℹ️  Re-upload the file to enable direct CDN touching.`);
    logger.debug(`[TouchManager Debug] 🎯 Fallback URL:   ${file.download_url}`);
    logger.debug(`[TouchManager Debug] ─────────────────────────────────────────`);
  } else {
    logger.debug(`[TouchManager Debug] 🎯 Direct CDN URL: ${directCdnUrl}`);
    logger.debug(`[TouchManager Debug] 📦 Range Header:  bytes=0-1024`);
    logger.debug(`[TouchManager Debug] ─────────────────────────────────────────`);
  }

  const targetUrl = directCdnUrl || file.download_url;

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://gofile.io/',
        'Origin': 'https://gofile.io',
        'Range': 'bytes=0-1024'
      },
      timeout: 10000,
      responseType: 'stream',
      validateStatus: s => s < 500
    });

    logger.debug(`[TouchManager Debug] ✉️  HTTP Response:   ${response.status} ${response.statusText || ''}`);
    logger.debug(`[TouchManager Debug] 📏 Content-Range:  ${response.headers?.['content-range'] || 'N/A'}`);
    logger.debug(`[TouchManager Debug] 🗂️  Content-Type:   ${response.headers?.['content-type'] || 'N/A'}`);
    logger.debug(`[TouchManager Debug] ─────────────────────────────────────────`);

    // Abort the stream immediately — we only needed to register the download
    if (response.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }

    const isOk = response.status === 200 || response.status === 206;
    const isNotFound = response.status === 404;

    if (isOk) {
      const updated = db.updateFile(file.id, {
        last_touched: new Date().toISOString(),
        status: 'LIVE'
      });
      const statusNote = response.status === 206 ? '✅ 206 Partial (real file download counted!)' : '⚠️  200 OK (may be HTML page — check CDN URL)';
      console.log(`[TouchManager] ${statusNote} — ${file.filename}. Retention timer reset.`);
      return { success: true, status: 'LIVE', file: updated };

    } else if (isNotFound) {
      const updated = db.updateFile(file.id, { status: 'DEAD' });
      console.warn(`[TouchManager] ❌ Touch FAILED (404) for ${file.filename}. Marked DEAD.`);
      return { success: false, status: 'DEAD', file: updated };

    } else {
      console.warn(`[TouchManager] Received HTTP ${response.status} for ${file.filename}. Leaving status untouched.`);
      return { success: false, status: file.status, file };
    }

  } catch (err) {
    console.warn(`[TouchManager Warning] Micro-download error for ${file.filename}: ${err.message}`);
    return { success: false, status: file.status, file };
  }
}

/**
 * Touch all files in database sequentially with randomized delay
 */
async function touchAllFiles() {
  const files = db.getAllFiles();
  console.log(`[TouchManager] Starting batch touch process for ${files.length} records...`);

  let touchedCount = 0;
  let deadCount = 0;

  for (const file of files) {
    const result = await touchFileRecord(file);
    if (result && result.success) {
      touchedCount++;
    } else if (result && result.status === 'DEAD') {
      deadCount++;
    }

    // 1-3 second randomized delay between pings to prevent rate-limiting
    const delay = Math.floor(Math.random() * 2000) + 1000;
    await sleep(delay);
  }

  console.log(`[TouchManager] Batch touch complete. Touched: ${touchedCount} | Dead: ${deadCount} | Total: ${files.length}`);
  return { touchedCount, deadCount, total: files.length };
}

/**
 * Initialize daily cron scheduler (Runs every day at midnight 00:00)
 */
function initScheduler() {
  console.log('[TouchManager] Initializing daily cron scheduler (0 0 * * *)...');
  cron.schedule('0 0 * * *', async () => {
    console.log('[TouchManager] Daily cron triggered! Running batch file touch...');
    try {
      await touchAllFiles();
    } catch (err) {
      console.error('[TouchManager Error] Cron execution failed:', err);
    }
  });
}

module.exports = {
  touchFileRecord,
  touchAllFiles,
  initScheduler
};
