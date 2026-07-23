const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Step 1: Mimic browser visiting GoFile page to establish session
 *   - Sends GET to https://gofile.io/d/{id} with full browser headers
 *   - Returns any set-cookie values from GoFile CDN
 */
async function visitGoFilePage(downloadUrl) {
  try {
    const res = await axios.get(downloadUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 6000,
      maxRedirects: 5,
      validateStatus: s => s < 500
    });
    // Return cookies if any
    return res.headers['set-cookie'] || [];
  } catch (err) {
    logger.debug(`[TouchManager Debug] Page visit notice: ${err.message}`);
    return [];
  }
}

/**
 * Step 2: Mimic browser SPA call — POST /accounts to get a fresh guest wt token
 *   - Must include Origin and Referer exactly like GoFile's own frontend JS does
 */
async function getGoFileGuestToken(refererUrl) {
  try {
    const res = await axios.post('https://api.gofile.io/accounts', {}, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': 'https://gofile.io',
        'Referer': refererUrl || 'https://gofile.io/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      },
      timeout: 5000
    });
    if (res.data?.status === 'ok' && res.data.data?.token) {
      logger.debug(`[TouchManager Debug] ✅ Guest wt token obtained: ${res.data.data.token.substring(0, 8)}...`);
      return res.data.data.token;
    }
    logger.debug(`[TouchManager Debug] Guest token response: ${JSON.stringify(res.data)}`);
  } catch (err) {
    logger.debug(`[TouchManager Debug] Guest token error: ${err.message}`);
  }
  return null;
}

/**
 * Step 3: Resolve actual CDN direct download link from GoFile contents API
 *   - Mimics exactly what GoFile SPA JS does after getting the wt token
 */
async function resolveDirectLink(contentShortCode, wt, refererUrl) {
  if (!contentShortCode || !wt) return null;

  const contentsUrl = `https://api.gofile.io/contents/${contentShortCode}?wt=${wt}`;
  logger.debug(`[TouchManager Debug] Resolving direct CDN link via: ${contentsUrl}`);

  try {
    const res = await axios.get(contentsUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://gofile.io',
        'Referer': refererUrl || 'https://gofile.io/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      },
      timeout: 8000
    });

    logger.debug(`[TouchManager Debug] Contents API response: ${JSON.stringify(res.data).substring(0, 300)}`);

    if (res.data?.status === 'ok' && res.data.data) {
      const data = res.data.data;

      // Folder with children (most common case)
      if (data.children) {
        const childKeys = Object.keys(data.children);
        for (const key of childKeys) {
          const child = data.children[key];
          if (child.link) {
            logger.debug(`[TouchManager Debug] ✅ Resolved direct link: ${child.link}`);
            return child.link;
          }
          if (child.directLink) {
            logger.debug(`[TouchManager Debug] ✅ Resolved direct link: ${child.directLink}`);
            return child.directLink;
          }
        }
      }

      // Direct file (not folder)
      if (data.link) return data.link;
      if (data.directLink) return data.directLink;
    }

    logger.debug(`[TouchManager Debug] Could not resolve direct link from contents. Status: ${res.data?.status}`);
  } catch (err) {
    logger.debug(`[TouchManager Debug] Contents API error: ${err.message}`);
  }
  return null;
}

/**
 * Main touch: Full browser-mimic 1 KB Micro-Download & Abort
 * @param {object} file File record object from database
 */
async function touchFileRecord(file) {
  if (!file || !file.download_url) {
    console.warn(`[TouchManager] Skipping invalid record:`, file);
    return false;
  }

  console.log(`[TouchManager] Pinging & 1KB micro-downloading ${file.filename} (${file.download_url})...`);

  try {
    // Step 1: Visit the GoFile page to establish a browser-like session
    logger.debug(`[TouchManager Debug] Step 1: Visiting GoFile page...`);
    const cookies = await visitGoFilePage(file.download_url);
    logger.debug(`[TouchManager Debug] Page cookies: ${cookies.length > 0 ? cookies.join('; ') : 'none'}`);

    // Step 2: Get fresh guest wt token exactly like GoFile SPA does
    logger.debug(`[TouchManager Debug] Step 2: Getting guest wt token...`);
    const wt = await getGoFileGuestToken(file.download_url);

    if (!wt) {
      console.warn(`[TouchManager] Could not obtain guest wt token for ${file.filename}. Falling back to page visit.`);
    }

    // Step 3: Resolve actual CDN direct download link
    // IMPORTANT: Must use the SHORT CODE from the download URL (e.g. "U7h3RA"),
    // NOT the file UUID stored as gofile_id. They are different!
    logger.debug(`[TouchManager Debug] Step 3: Resolving CDN direct link...`);
    let directLink = null;

    // Extract the content short code from download URL: https://gofile.io/d/U7h3RA → U7h3RA
    let contentShortCode = null;
    if (file.download_url) {
      const match = file.download_url.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        contentShortCode = match[1];
        logger.debug(`[TouchManager Debug] Extracted content short code: ${contentShortCode} (from ${file.download_url})`);
      }
    }

    if (wt && contentShortCode) {
      directLink = await resolveDirectLink(contentShortCode, wt, file.download_url);
    }

    // Fallback to GoFile page link
    if (!directLink) {
      directLink = file.download_url;
      logger.debug(`[TouchManager Debug] ⚠️  Falling back to GoFile page URL (no direct CDN link resolved)`);
    }

    logger.debug(`[TouchManager Debug] ─────────────────────────────────────────`);
    logger.debug(`[TouchManager Debug] 📄 File:           ${file.filename}`);
    logger.debug(`[TouchManager Debug] 🔗 GoFile Page:    ${file.download_url}`);
    logger.debug(`[TouchManager Debug] 🎯 Actual 1KB URL: ${directLink}`);
    logger.debug(`[TouchManager Debug] 🔑 wt Token:       ${wt ? wt.substring(0, 8) + '...' : 'none'}`);
    logger.debug(`[TouchManager Debug] 📦 Range Header:   bytes=0-1024`);

    // Step 4: 1 KB Micro-Download with Range header on the actual CDN link
    const downloadHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://gofile.io/',
      'Origin': 'https://gofile.io',
      'Range': 'bytes=0-1024',
      'Cookie': wt ? `accountToken=${wt}` : ''
    };

    const response = await axios.get(directLink, {
      headers: downloadHeaders,
      timeout: 10000,
      responseType: 'stream',
      validateStatus: s => s < 500
    });

    logger.debug(`[TouchManager Debug] ✉️  HTTP Response:   ${response.status} ${response.statusText || ''}`);
    logger.debug(`[TouchManager Debug] 📏 Content-Range:  ${response.headers?.['content-range'] || 'N/A'}`);
    logger.debug(`[TouchManager Debug] 🗂️  Content-Type:   ${response.headers?.['content-type'] || 'N/A'}`);
    logger.debug(`[TouchManager Debug] ─────────────────────────────────────────`);

    // Abort stream immediately after receipt
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
      console.log(`[TouchManager] ✅ Touch & 1KB Micro-Download SUCCESS (${response.status}) for ${file.filename}. Retention timer reset.`);
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
