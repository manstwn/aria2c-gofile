const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'gotouch_secret_key_change_in_production';
const ADMIN_PIN = process.env.ADMIN_PIN || '123456';

function verifyPin(pin) {
  return String(pin).trim() === String(ADMIN_PIN).trim();
}

function generateToken() {
  return jwt.sign({ role: 'admin', authAt: Date.now() }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  // Check cookie or authorization header
  const token = req.cookies?.gotouch_token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'PIN authentication required.' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Session expired or invalid PIN.' });
  }

  req.user = decoded;
  next();
}

module.exports = {
  verifyPin,
  generateToken,
  verifyToken,
  requireAuth
};
