const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const gofile = require('./gofile');
require('dotenv').config();

const ARIA2_RPC_URL = process.env.ARIA2_RPC_URL || 'http://127.0.0.1:6800/jsonrpc';
const ARIA2_RPC_SECRET = process.env.ARIA2_RPC_SECRET || '';
const AUTO_START_ARIA2 = process.env.AUTO_START_ARIA2 !== 'false'; // default true
const ARIA2_PATH_ENV = process.env.ARIA2_PATH || '';

// Track GIDs that are currently being processed or uploaded
const activeUploads = new Map(); // gid -> { filename, status, error, record }
const processedGids = new Set();
const taskSourceUrls = new Map(); // gid -> url

let rpcRequestId = 1;
let aria2Process = null;
let rpcErrorLogged = false;
let isStartingAria2 = false;

/**
 * Locate aria2c executable on local machine or system PATH
 */
function findAria2Executable() {
  const candidatePaths = [
    ARIA2_PATH_ENV,
    'C:\\Program Portable\\aria2c\\aria2c.exe',
    'C:\\aria2\\aria2c.exe',
    'aria2c'
  ];

  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to system command 'aria2c'
  return 'aria2c';
}

/**
 * Extract port number from ARIA2_RPC_URL
 */
function getRpcPort() {
  try {
    const url = new URL(ARIA2_RPC_URL);
    return url.port || '6800';
  } catch (err) {
    return '6800';
  }
}

/**
 * Auto-spawn aria2c background daemon if RPC connection is missing
 */
function ensureAria2Daemon() {
  if (!AUTO_START_ARIA2 || isStartingAria2 || aria2Process) return;

  const executable = findAria2Executable();
  const port = getRpcPort();
  const downloadsDir = path.resolve(db.DOWNLOADS_DIR);

  const args = [
    '--enable-rpc',
    `--rpc-listen-port=${port}`,
    '--rpc-listen-all=false',
    `--dir=${downloadsDir}`,
    '--max-connection-per-server=16',
    '--split=16',
    '--quiet=true'
  ];

  if (ARIA2_RPC_SECRET) {
    args.push(`--rpc-secret=${ARIA2_RPC_SECRET}`);
  }

  console.log(`[Aria2] Attempting to auto-start aria2c daemon (${executable} --rpc-listen-port=${port})...`);
  isStartingAria2 = true;

  try {
    aria2Process = spawn(executable, args, {
      windowsHide: true,
      stdio: 'ignore'
    });

    aria2Process.on('error', (err) => {
      console.warn(`[Aria2] Failed to auto-start aria2c process (${executable}): ${err.message}`);
      aria2Process = null;
      isStartingAria2 = false;
    });

    aria2Process.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.warn(`[Aria2] aria2c process exited with code ${code}`);
      }
      aria2Process = null;
      isStartingAria2 = false;
    });

    // Give it 1 second to bind
    setTimeout(() => {
      isStartingAria2 = false;
    }, 1000);

  } catch (err) {
    console.warn(`[Aria2] Exception starting aria2c process: ${err.message}`);
    isStartingAria2 = false;
  }
}

// Clean up child process on Node exit
process.on('exit', () => {
  if (aria2Process) {
    try { aria2Process.kill(); } catch (e) {}
  }
});
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

/**
 * Make JSON-RPC call to aria2c daemon
 */
async function rpcCall(method, params = []) {
  const fullParams = ARIA2_RPC_SECRET ? [`token:${ARIA2_RPC_SECRET}`, ...params] : params;

  const payload = {
    jsonrpc: '2.0',
    id: `gotouch_${rpcRequestId++}`,
    method,
    params: fullParams
  };

  const response = await axios.post(ARIA2_RPC_URL, payload, { timeout: 5000 });
  if (response.data.error) {
    throw new Error(`Aria2 RPC Error [${response.data.error.code}]: ${response.data.error.message}`);
  }
  return response.data.result;
}

/**
 * Test aria2 RPC connection
 */
async function checkConnection() {
  try {
    const version = await rpcCall('aria2.getVersion');
    if (rpcErrorLogged) {
      console.log('[Aria2] Connected to aria2c RPC daemon successfully!');
      rpcErrorLogged = false;
    }
    return { online: true, version: version.version };
  } catch (err) {
    ensureAria2Daemon();
    return { online: false, error: err.message };
  }
}

/**
 * Submit a URL download to aria2c with strict 16-connection parameters and optional custom output filename
 */
async function addDownload(url, customFilename = '') {
  if (!url || typeof url !== 'string') {
    throw new Error('Valid download URL is required.');
  }

  const options = {
    dir: path.resolve(db.DOWNLOADS_DIR),
    'max-connection-per-server': '16',
    split: '16'
  };

  if (customFilename && typeof customFilename === 'string' && customFilename.trim().length > 0) {
    options.out = customFilename.trim();
  }

  const gid = await rpcCall('aria2.addUri', [[url.trim()], options]);
  taskSourceUrls.set(gid, url.trim());
  console.log(`[Aria2] Download task created with GID ${gid} for URL: ${url} ${options.out ? `(Custom name: ${options.out})` : ''}`);
  return gid;
}

/**
 * Get status of all active and waiting downloads from aria2 RPC
 */
async function getDownloadsStatus() {
  try {
    const active = await rpcCall('aria2.tellActive') || [];
    const waiting = await rpcCall('aria2.tellWaiting', [0, 50]) || [];
    const stopped = await rpcCall('aria2.tellStopped', [0, 20]) || [];

    if (rpcErrorLogged) {
      console.log('[Aria2] Reconnected to aria2c RPC daemon successfully!');
      rpcErrorLogged = false;
    }

    const allTasks = [...active, ...waiting, ...stopped];

    const formattedTasks = allTasks.map(task => {
      const completedLength = parseInt(task.completedLength || '0', 10);
      const totalLength = parseInt(task.totalLength || '0', 10);
      const downloadSpeed = parseInt(task.downloadSpeed || '0', 10);
      const progress = totalLength > 0 ? parseFloat(((completedLength / totalLength) * 100).toFixed(1)) : 0;

      let filename = 'Unknown';
      if (task.files && task.files[0] && task.files[0].path) {
        filename = path.basename(task.files[0].path);
      }

      const uploadInfo = activeUploads.get(task.gid);

      return {
        gid: task.gid,
        filename,
        status: uploadInfo ? uploadInfo.status : task.status,
        progress,
        downloadSpeed,
        completedLength,
        totalLength,
        uploadProgress: uploadInfo ? (uploadInfo.uploadProgress || 0) : 0,
        uploadLoaded: uploadInfo ? (uploadInfo.uploadLoaded || 0) : 0,
        uploadTotal: uploadInfo ? (uploadInfo.uploadTotal || 0) : 0,
        uploadSpeed: uploadInfo ? (uploadInfo.uploadSpeed || 0) : 0,
        errorMessage: task.errorMessage || (uploadInfo ? uploadInfo.error : '')
      };
    });

    return formattedTasks;
  } catch (err) {
    if (!rpcErrorLogged) {
      console.warn(`[Aria2] RPC daemon unreachable (${err.message}). ${AUTO_START_ARIA2 ? 'Attempting auto-start...' : 'Please start aria2c.'}`);
      rpcErrorLogged = true;
    }
    ensureAria2Daemon();
    return [];
  }
}

/**
 * Helper to delete all local download files and .aria2 control files associated with a task
 */
async function cleanUpTaskFiles(gid, taskDetails = null) {
  try {
    let task = taskDetails;
    if (!task) {
      try {
        task = await rpcCall('aria2.tellStatus', [gid]);
      } catch (e) {}
    }

    if (task && task.files && Array.isArray(task.files)) {
      for (const file of task.files) {
        if (file.path) {
          const filePath = file.path;
          if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
            console.log(`[Aria2 Cleanup] Removed downloaded file: ${filePath}`);
          }
          const controlFile = `${filePath}.aria2`;
          if (fs.existsSync(controlFile)) {
            fs.rmSync(controlFile, { force: true });
            console.log(`[Aria2 Cleanup] Removed control file: ${controlFile}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Aria2 Cleanup] Error removing files for GID ${gid}:`, err.message);
  }
}

/**
 * Poll aria2c stopped downloads to trigger GoFile upload for completed tasks or clean up failed tasks
 */
async function pollCompletedDownloads() {
  try {
    const stopped = await rpcCall('aria2.tellStopped', [0, 50]) || [];
    for (const task of stopped) {
      if (task.status === 'complete' && !processedGids.has(task.gid)) {
        processedGids.add(task.gid);

        const filePath = task.files && task.files[0] && task.files[0].path;
        if (!filePath || !fs.existsSync(filePath)) {
          console.warn(`[Aria2] Download completed for GID ${task.gid} but file not found on disk.`);
          continue;
        }

        const filename = path.basename(filePath);
        const sourceUrl = taskSourceUrls.get(task.gid) || '';
        console.log(`[Aria2] Task ${task.gid} completed downloading (${filename}). Triggering GoFile upload...`);

        activeUploads.set(task.gid, {
          filename,
          status: 'UPLOADING',
          error: null,
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadTotal: 0,
          uploadSpeed: 0
        });

        // Trigger asynchronous GoFile upload pipeline with live upload progress tracking and metadata extraction
        gofile.uploadToGoFile(filePath, filename, (progressData) => {
          const current = activeUploads.get(task.gid) || {};
          activeUploads.set(task.gid, {
            ...current,
            ...progressData,
            status: 'UPLOADING'
          });
        }, sourceUrl)
          .then(record => {
            activeUploads.set(task.gid, { filename, status: 'UPLOADED', record, uploadProgress: 100 });
            setTimeout(() => {
              activeUploads.delete(task.gid);
              try { rpcCall('aria2.removeDownloadResult', [task.gid]); } catch (e) {}
            }, 2000);
          })
          .catch(err => {
            console.error(`[Aria2] GoFile upload failed for task ${task.gid}:`, err.message);
            activeUploads.set(task.gid, { filename, status: 'UPLOAD_FAILED', error: err.message });
          });
      } else if (task.status === 'error' && !processedGids.has(task.gid)) {
        processedGids.add(task.gid);
        console.warn(`[Aria2] Task ${task.gid} failed with error (${task.errorMessage || 'unknown'}). Cleaning up temporary files...`);
        await cleanUpTaskFiles(task.gid, task);
        try {
          await rpcCall('aria2.removeDownloadResult', [task.gid]);
        } catch (e) {}
      }
    }
  } catch (err) {
    // Suppress polling errors when RPC is down
  }
}

// Start continuous background status monitoring every 3 seconds
let monitorInterval = null;
function startMonitor() {
  if (!monitorInterval) {
    monitorInterval = setInterval(pollCompletedDownloads, 3000);
  }
}

/**
 * Cancel/remove a download task by GID and clean up disk files
 */
async function removeDownload(gid) {
  if (!gid) throw new Error('Valid GID is required.');
  try {
    let task = null;
    try {
      task = await rpcCall('aria2.tellStatus', [gid]);
    } catch (e) {}

    try {
      await rpcCall('aria2.remove', [gid]);
    } catch (e1) {
      try {
        await rpcCall('aria2.forceRemove', [gid]);
      } catch (e2) {
        await rpcCall('aria2.removeDownloadResult', [gid]);
      }
    }

    // Clean up local download file and .aria2 control file
    await cleanUpTaskFiles(gid, task);

    activeUploads.delete(gid);
    processedGids.add(gid);
    console.log(`[Aria2] Download task GID ${gid} cancelled and local files deleted.`);
    return true;
  } catch (err) {
    console.error(`[Aria2] Failed to remove download task GID ${gid}:`, err.message);
    throw err;
  }
}

module.exports = {
  checkConnection,
  addDownload,
  removeDownload,
  getDownloadsStatus,
  startMonitor
};


