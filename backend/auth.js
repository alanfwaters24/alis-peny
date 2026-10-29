// auth.js — handles logins for PENY. Everything here runs on your own
// server: passwords are hashed with bcrypt, 2FA uses standard TOTP (the
// same protocol as Google Authenticator / Authy / Bitwarden), and there's
// no third-party auth service involved at all.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

// This secret signs your login sessions. Set JWT_SECRET in your .env file
// for full control, or leave it unset and P.E.N.Y will generate one the
// first time it runs and remember it in your data folder — either way,
// it stays the same across restarts so you don't get logged out every
// time you reopen the app.
function loadOrCreateJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const fs = require('fs');
  const path = require('path');
  const dataDir = process.env.PENY_DATA_DIR || '/data';
  const secretPath = path.join(dataDir, '.jwt-secret');
  try {
    if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
    const generated = require('crypto').randomBytes(32).toString('hex');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Fall back to a per-run secret if the data folder isn't writable for some reason
    return require('crypto').randomBytes(32).toString('hex');
  }
}
const JWT_SECRET = loadOrCreateJwtSecret();
const TOKEN_EXPIRY = '30d';   // how long you stay logged in on a device

function registerUser(db, email, password) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new Error('An account with that email already exists');
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = bcrypt.hashSync(recoveryCode, 12);
  db.prepare('INSERT INTO users (id, email, password_hash, recovery_code_hash) VALUES (?,?,?,?)').run(id, email, hash, recoveryHash);
  // Shown to the user exactly once — P.E.N.Y doesn't store it anywhere in readable form.
  return { id, email, recoveryCode };
}

// Groups of 4 characters, easy to write down accurately: e.g. XQ7K-9P2M-4R8T-J3WZ
function generateRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid transcription errors
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) group += chars[Math.floor(Math.random() * chars.length)];
    groups.push(group);
  }
  return groups.join('-');
}

// Resets a forgotten password using the recovery code shown at signup.
// Also switches off 2FA, since losing the password often means losing
// access to the authenticator app too — they can turn it back on after.
function resetPassword(db, email, recoveryCode, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.recovery_code_hash) throw new Error('Incorrect email or recovery code');
  const valid = bcrypt.compareSync((recoveryCode || '').trim().toUpperCase(), user.recovery_code_hash);
  if (!valid) throw new Error('Incorrect email or recovery code');
  if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');
  const newHash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(newHash, user.id);
  return true;
}

// Step 1 of login: check email + password. If 2FA is enabled, this does
// NOT log the user in yet — it just tells the frontend a code is needed.
function checkPassword(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw new Error('Incorrect email or password');
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) throw new Error('Incorrect email or password');
  return user;
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Generates a fresh secret + a QR code (as a data URL) for the user to scan
// into their authenticator app. Not enabled until they confirm a code back.
async function startTotpSetup(db, userId) {
  const secret = speakeasy.generateSecret({ name: `PENY (${userId.slice(0, 8)})`, length: 20 });
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, userId);
  const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
  return { qrDataUrl, manualEntryKey: secret.base32 };
}

function confirmTotpSetup(db, userId, code) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code, window: 1 });
  if (!valid) throw new Error('That code didn\'t match — check the time on your phone and try again');
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
  return true;
}

function verifyTotpCode(db, userId, code) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user.totp_enabled) return true; // 2FA not turned on for this account
  return speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code, window: 1 });
}

// Express middleware — protects any route it's attached to. Reads the
// "Authorization: Bearer <token>" header set by the frontend after login.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired — please log in again' });
  }
}

module.exports = {
  registerUser, checkPassword, issueToken, verifyToken,
  startTotpSetup, confirmTotpSetup, verifyTotpCode, requireAuth,
  resetPassword,
};
