const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || './data';
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const FILES_JSON_PATH = path.join(DATA_DIR, 'files.json');

// Ensure required directories and files exist
function initStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(FILES_JSON_PATH)) {
    fs.writeFileSync(FILES_JSON_PATH, JSON.stringify([], null, 2), 'utf8');
  }
}

const metadataModule = require('./metadata');

function getAllFiles() {
  initStorage();
  try {
    const data = fs.readFileSync(FILES_JSON_PATH, 'utf8');
    const files = JSON.parse(data || '[]');

    return files.map(file => {
      if (!file.metadata) {
        const ext = path.extname(file.filename || '').replace('.', '').toLowerCase();
        const category = metadataModule.getCategory(ext);
        file.metadata = {
          size_bytes: 0,
          size_formatted: 'N/A',
          category: category,
          extension: ext || 'file',
          source_url: file.source_url || '',
          resolution: '',
          width: null,
          height: null,
          duration_formatted: ''
        };
      }
      return file;
    });
  } catch (err) {
    console.error('Error reading files.json:', err);
    return [];
  }
}

function saveAllFiles(files) {
  initStorage();
  fs.writeFileSync(FILES_JSON_PATH, JSON.stringify(files, null, 2), 'utf8');
}

function getFileById(id) {
  const files = getAllFiles();
  return files.find(f => f.id === id);
}

function generateId() {
  const timestamp = Date.now();
  const random = Math.floor(100 + Math.random() * 900);
  return `gt_${timestamp}_${random}`;
}

function addFile(record) {
  const files = getAllFiles();
  const now = new Date().toISOString();
  const newRecord = {
    id: record.id || generateId(),
    filename: record.filename || record.original_filename || 'unknown_file',
    custom_name: record.custom_name || '',
    original_filename: record.original_filename || record.filename || '',
    source_url: record.source_url || '',
    gofile_id: record.gofile_id || '',
    download_url: record.download_url || '',
    admin_code: record.admin_code || '',
    created_at: record.created_at || now,
    last_touched: record.last_touched || now,
    status: record.status || 'LIVE',
    metadata: record.metadata || null
  };

  files.unshift(newRecord);
  saveAllFiles(files);
  return newRecord;
}

function updateFile(id, updates) {
  const files = getAllFiles();
  const index = files.findIndex(f => f.id === id);
  if (index === -1) return null;

  files[index] = {
    ...files[index],
    ...updates
  };
  saveAllFiles(files);
  return files[index];
}

function deleteFile(id) {
  const files = getAllFiles();
  const filtered = files.filter(f => f.id !== id);
  if (filtered.length !== files.length) {
    saveAllFiles(filtered);
    return true;
  }
  return false;
}

initStorage();

module.exports = {
  DATA_DIR,
  DOWNLOADS_DIR,
  FILES_JSON_PATH,
  getAllFiles,
  getFileById,
  addFile,
  updateFile,
  deleteFile
};
