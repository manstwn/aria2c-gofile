const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a fresh GoFile guest account token 'wt'
 */
async function getGoFileGuestToken() {
  try {
    const response = await axios.post('https://api.gofile.io/accounts', {}, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Origin': 'https://gofile.io',
        'Referer': 'https://gofile.io/'
      },
      timeout: 5000
    });
    if (response.data && response.data.status === 'ok' && response.data.data?.token) {
      return response.data.data.token;
    }
  } catch (err) {
    logger.debug(`[TouchManager Debug] Failed to fetch guest token: ${err.message}`);
  }
  return null;
}

/**
 * Perform 1 KB Micro-Download & Abort on a single GoFile record
 * @param {object} file File record object from database
 */
async function touchFileRecord(file) {
  if (!file || !file.download_url) {
    console.warn(`[TouchManager] Skipping invalid record:`, file);
    return false;
  }

  console.log(`[TouchManager] Pinging & 1KB micro-downloading ${file.filename} (${file.download_url})...`);

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': file.download_url
  };

  try {
    // Step 1: Obtain account/guest token
    let token = (process.env.GOFILE_API_TOKEN || '').trim();
    if (!token) {
      token = await getGoFileGuestToken() || '';
    }

    if (token) {
      headers['Cookie'] = `accountToken=${token}`;
    }

    // Step 2: Get contents and resolve direct download link
    let directLink = null;
    if (file.gofile_id) {
      const contentsUrl = `https://api.gofile.io/contents/${file.gofile_id}?wt=${token}`;
      logger.debug(`[TouchManager Debug] Fetching contents metadata from: ${contentsUrl}`);

      try {
        const contentsRes = await axios.get(contentsUrl, {
          headers,
          timeout: 6000
        });

        if (contentsRes.data && contentsRes.data.status === 'ok' && contentsRes.data.data) {
          const contentsData = contentsRes.data.data;
          const children = contentsData.children || {};
          const childKeys = Object.keys(children);
          if (childKeys.length > 0) {
            const firstChild = children[childKeys[0]];
            directLink = firstChild.link || firstChild.downloadPage || null;
          }
        }
      } catch (err) {
        logger.debug(`[TouchManager Debug] Contents resolution notice: ${err.message}`);
      }
    }

    // Fallback direct link to download page
    if (!directLink) {
      directLink = file.download_url;
    }

    logger.debug(`[TouchManager Debug] Target Direct Download Link: ${directLink}`);

    // Step 3: Trigger 1 KB Micro-Download with Range header
    const downloadHeaders = {
      ...headers,
      'Range': 'bytes=0-1024'
    };

    const response = await axios.get(directLink, {
      headers: downloadHeaders,
      timeout: 8000,
      responseType: 'stream',
      validateStatus: status => status < 500
    });

    const isOk = response.status === 200 || response.status === 206;
    const isNotFound = response.status === 404;

    if (isOk) {
      // Abort/destroy the download stream immediately after receiving 1KB
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }

      const updated = db.updateFile(file.id, {
        last_touched: new Date().toISOString(),
        status: 'LIVE'
      });
      console.log(`[TouchManager] ✅ Touch & 1KB Micro-Download SUCCESS (${response.status}) for ${file.filename}. Retention timer reset.`);
      return { success: true, status: 'LIVE', file: updated };

    } else if (isNotFound) {
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }

      const updated = db.updateFile(file.id, {
        status: 'DEAD'
      });
      console.warn(`[TouchManager] ❌ Touch FAILED (404 Not Found) for ${file.filename}. Marked status as DEAD.`);
      return { success: false, status: 'DEAD', file: updated };

    } else {
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }

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

  console.log(`[TouchManager] Batch touch process completed. Touched: ${touchedCount} | Marked Dead: ${deadCount} | Total: ${files.length}`);
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
