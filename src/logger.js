require('dotenv').config();

const isDebug = (process.env.DEBUG || '').toString().toLowerCase() === 'true';

/**
 * Log debug messages when DEBUG=true in .env
 */
function debug(...args) {
  if (isDebug) {
    const timestamp = new Date().toISOString();
    console.log(`\x1b[35m[DEBUG ${timestamp}]\x1b[0m`, ...args);
  }
}

/**
 * Standard info logging
 */
function info(...args) {
  console.log(...args);
}

/**
 * Warning logging
 */
function warn(...args) {
  console.warn(...args);
}

/**
 * Error logging
 */
function error(...args) {
  console.error(...args);
}

module.exports = {
  isDebug,
  debug,
  info,
  warn,
  error
};
