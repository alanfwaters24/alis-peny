// secretbox.js — encrypts bank-sync credentials (the Enable Banking key
// file) before they go into the database. The encryption key lives in a
// separate file next to the database (.bank-key), so a copied or backed-up
// database on its own does not expose anyone's bank key.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const dataDir = process.env.PENY_DATA_DIR || '/data';
  const keyPath = path.join(dataDir, '.bank-key');
  try {
    if (fs.existsSync(keyPath)) {
      cachedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      cachedKey = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, cachedKey.toString('hex'), { mode: 0o600 });
    }
  } catch (e) {
    throw new Error('Could not create the bank key file in the data folder: ' + e.message);
  }
  return cachedKey;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(boxed) {
  if (!boxed) return null;
  const [v, ivB, tagB, encB] = String(boxed).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
