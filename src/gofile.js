const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const metadata = require('./metadata');
const thumbnailsModule = require('./thumbnails');
const logger = require('./logger');
require('dotenv').config();

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch optimal GoFile upload server node with fallback list
 */
async function getUploadServer() {
  const token = (process.env.GOFILE_API_TOKEN || '').trim();
  const headers = {
    'User-Agent': USER_AGENT
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    console.log('[GoFile] Fetching optimal upload server from GoFile API...');
    const response = await axios.get('https://api.gofile.io/servers', {
      headers,
      timeout: 6000
    });

    logger.debug('[GoFile Debug] Servers API Response:', JSON.stringify(response.data || {}));

    if (response.data && response.data.status === 'ok' && response.data.data) {
      const data = response.data.data;
      let serverName = null;

      if (Array.isArray(data.servers) && data.servers.length > 0) {
        // Pick first available active server
        serverName = data.servers[0].name;
      } else if (typeof data.server === 'string') {
        serverName = data.server;
      }

      if (serverName) {
        console.log(`[GoFile] Selected upload server: ${serverName}`);
        return serverName;
      }
    }
  } catch (err) {
    console.warn(`[GoFile Warning] Could not fetch server list from API (${err.message}). Using fallback server pool...`);
  }

  // Fallback server candidates
  const fallbacks = ['store1', 'store2', 'store3', 'store4'];
  const randomFallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  console.log(`[GoFile] Using fallback server: ${randomFallback}`);
  return randomFallback;
}

/**
 * Upload a local file to GoFile with detailed diagnostics, live upload progress, and cleanup
 * @param {string} filePath Absolute path to completed download file
 * @param {string} overrideFilename Optional custom filename
 * @param {function} onProgress Optional progress callback
 * @param {string} sourceUrl Optional original remote URL
 */
async function uploadToGoFile(filePath, overrideFilename, onProgress = null, sourceUrl = '') {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found on disk for upload: ${filePath}`);
  }

  const filename = overrideFilename || path.basename(filePath);
  const token = (process.env.GOFILE_API_TOKEN || '').trim();
  const stats = fs.statSync(filePath);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`[GoFile] Preparing upload for ${filename} (${fileSizeMB} MB)...`);
  if (!token) {
    console.log(`[GoFile Info] No GOFILE_API_TOKEN configured in .env. Uploading as anonymous guest.`);
  }

  const server = await getUploadServer();
  const uploadUrl = `https://${server}.gofile.io/uploadFile`;

  const fileStream = fs.createReadStream(filePath);
  let loadedBytes = 0;
  let lastLoaded = 0;
  let lastTime = Date.now();

  fileStream.on('data', (chunk) => {
    loadedBytes += chunk.length;
    const currentTime = Date.now();
    const timeDiffSeconds = (currentTime - lastTime) / 1000;

    if (timeDiffSeconds >= 0.25 || loadedBytes >= stats.size) {
      const currentSpeed = timeDiffSeconds > 0 ? Math.max(0, (loadedBytes - lastLoaded) / timeDiffSeconds) : 0;
      lastLoaded = loadedBytes;
      lastTime = currentTime;

      const percent = stats.size > 0 ? parseFloat(((loadedBytes / stats.size) * 100).toFixed(1)) : 0;
      if (onProgress) {
        onProgress({
          uploadProgress: Math.min(99.9, percent),
          uploadLoaded: loadedBytes,
          uploadTotal: stats.size,
          uploadSpeed: currentSpeed
        });
      }
    }
  });

  const form = new FormData();
  form.append('file', fileStream, {
    filename,
    knownLength: stats.size
  });

  if (token) {
    form.append('token', token);
  }

  const headers = {
    ...form.getHeaders(),
    'User-Agent': USER_AGENT
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  console.log(`[GoFile] Streaming file (${metadata.formatBytes(stats.size)}) to ${uploadUrl}...`);

  try {
    const response = await axios.post(uploadUrl, form, {
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 0 // Unlimited timeout for file stream
    });

    if (onProgress) {
      onProgress({
        uploadProgress: 100,
        uploadLoaded: stats.size,
        uploadTotal: stats.size,
        uploadSpeed: 0
      });
    }

    const resData = response.data;

    if (!resData) {
      throw new Error(`Empty response received from GoFile server (${server}).`);
    }

    if (resData.status !== 'ok') {
      const errorMsg = resData.message || JSON.stringify(resData);
      if (resData.status === 'error-auth' || resData.status === 'error-token') {
        throw new Error(`GoFile Auth Error: ${errorMsg}. Please verify your GOFILE_API_TOKEN in .env.`);
      }
      throw new Error(`GoFile Upload Rejected [${resData.status}]: ${errorMsg}`);
    }

    const data = resData.data || {};
    const fileId = data.fileId || data.id || (data.file ? data.file.id : '');
    const downloadPage = data.downloadPage || (fileId ? `https://gofile.io/d/${fileId}` : '');
    const adminCode = data.adminCode || data.code || `adm_${Math.random().toString(36).substring(2, 8)}`;

    const fileMeta = metadata.extractMetadata(filePath, sourceUrl);
    console.log(`[Metadata Extracted] Category: ${fileMeta.category} | Size: ${fileMeta.size_formatted} ${fileMeta.resolution ? `| Res: ${fileMeta.resolution}` : ''}`);

    let originalFilename = path.basename(filePath);
    if (sourceUrl) {
      try {
        const parsedUrl = new URL(sourceUrl);
        const urlBasename = path.basename(parsedUrl.pathname);
        if (urlBasename && urlBasename.includes('.')) {
          originalFilename = urlBasename;
        }
      } catch (e) {}
    }

    const recordId = db.generateId();
    const thumbs = await thumbnailsModule.generateThumbnails(filePath, recordId, fileMeta);

    const now = new Date().toISOString();
    const record = db.addFile({
      id: recordId,
      filename: filename,
      custom_name: (filename && filename !== originalFilename) ? filename : '',
      original_filename: originalFilename,
      source_url: sourceUrl || '',
      gofile_id: fileId,
      download_url: downloadPage,
      admin_code: adminCode,
      created_at: now,
      last_touched: now,
      status: 'LIVE',
      metadata: fileMeta,
      thumbnails: thumbs
    });

    console.log(`[GoFile] ✅ Upload successful! Filename: ${filename} (Original: ${originalFilename}) | Download URL: ${downloadPage}`);
    return record;

  } catch (err) {
    let detailedError = err.message;
    if (err.response) {
      const status = err.response.status;
      const dataStr = typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : err.response.data;
      detailedError = `HTTP ${status}: ${dataStr || err.message}`;
    }
    console.error(`[GoFile Error Mitigation] Failed to upload ${filename}: ${detailedError}`);
    throw new Error(detailedError);

  } finally {
    // Guaranteed disk cleanup
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
        console.log(`[GoFile Cleanup] Temporary local file removed: ${filePath}`);
      }
      const aria2ControlFile = `${filePath}.aria2`;
      if (fs.existsSync(aria2ControlFile)) {
        fs.rmSync(aria2ControlFile, { force: true });
        console.log(`[GoFile Cleanup] Temporary control file removed: ${aria2ControlFile}`);
      }
    } catch (cleanupErr) {
      console.warn(`[GoFile Cleanup Warning] Error deleting temp files: ${cleanupErr.message}`);
    }
  }
}

module.exports = {
  getUploadServer,
  uploadToGoFile
};
