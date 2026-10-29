// server.js — P.E.N.Y's backend API. Runs on your TrueNAS box, talks to the
// local SQLite database, and (optionally) to Enable Banking for read-only bank
// syncing. Nothing about your finances leaves this server unless you set up
// bank sync yourself.
//
// Every person who logs in gets their own private data — their own
// accounts, transactions, budgets, bills, pensions, and investments.
// Every route below scopes its queries to req.user.sub (the logged-in
// user's id), so nobody can see or touch anyone else's records, even
// though everyone shares the same P.E.N.Y installation.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const eb = require('./enablebanking');
const secretbox = require('./secretbox');
const crypto = require('crypto');
const auth = require('./auth');
const { currentNetWorth, netWorthBreakdown, projectCashflow, budgetSummary } = require('./forecast');
const { buildSummaryReport } = require('./reports');
const { parseStatement, parseCSV, detectFormat } = require('./importers');
const { toCSV, toQIF, fullJSON } = require('./exporters');
const pensions = require('./pensions');
const investmentsModule = require('./investments');
const { buildGrowthProjection } = require('./growth');

const app = express();
app.set('trust proxy', true); // so the bank return address is built correctly behind nginx / Tailscale
app.use(cors());
app.use(express.json({ limit: '15mb' })); // bank statement files can be a few MB

const PORT = process.env.PORT || 4200;

// The Windows desktop edition runs one process for everything — no nginx.
// Docker/server edition leaves SERVE_STATIC_FROM unset and lets nginx handle this instead.
if (process.env.SERVE_STATIC_FROM) {
  app.use(express.static(process.env.SERVE_STATIC_FROM));
}

// ---------- Auth ----------
// These are the only routes that don't require a login.
app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
    }
    const user = auth.registerUser(db, email.toLowerCase().trim(), password);
    // Everyone gets their own private set of categories to start with.
    db.seedDefaultCategories(user.id);
    // recoveryCode is only ever available in this one response — save it now, it can't be shown again.
    res.json({ ok: true, userId: user.id, recoveryCode: user.recoveryCode });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/reset-password', (req, res) => {
  try {
    const { email, recoveryCode, newPassword } = req.body;
    if (!email || !recoveryCode || !newPassword) {
      return res.status(400).json({ error: 'Email, recovery code and a new password are all required' });
    }
    auth.resetPassword(db, email.toLowerCase().trim(), recoveryCode, newPassword);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password, totpCode } = req.body;
    const user = auth.checkPassword(db, email.toLowerCase().trim(), password);
    if (user.totp_enabled) {
      if (!totpCode) return res.json({ requires2fa: true });
      const valid = auth.verifyTotpCode(db, user.id, totpCode);
      if (!valid) return res.status(401).json({ error: 'Incorrect 2FA code' });
    }
    const token = auth.issueToken(user);
    res.json({ token, email: user.email, totpEnabled: !!user.totp_enabled });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

app.post('/api/auth/2fa/setup', auth.requireAuth, async (req, res) => {
  try {
    const result = await auth.startTotpSetup(db, req.user.sub);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/2fa/confirm', auth.requireAuth, (req, res) => {
  try {
    auth.confirmTotpSetup(db, req.user.sub, req.body.code);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Everything below this line requires a valid login.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health' || req.path === '/banksync/callback') return next();
  return auth.requireAuth(req, res, next);
});

// ---------- Accounts ----------
app.get('/api/accounts', (req, res) => {
  res.json(db.prepare('SELECT * FROM accounts WHERE archived = 0 AND user_id = ? ORDER BY created_at').all(req.user.sub));
});

app.post('/api/accounts', (req, res) => {
  const { name, type, starting_balance = 0, currency = 'GBP' } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  const id = uuidv4();
  db.prepare('INSERT INTO accounts (id, user_id, name, type, starting_balance, currency) VALUES (?,?,?,?,?,?)')
    .run(id, req.user.sub, name, type, starting_balance, currency);
  res.json(db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id, req.user.sub));
});

app.put('/api/accounts/:id', (req, res) => {
  const { name, type, starting_balance, currency } = req.body;
  db.prepare('UPDATE accounts SET name=?, type=?, starting_balance=?, currency=? WHERE id=? AND user_id=?')
    .run(name, type, starting_balance, currency, req.params.id, req.user.sub);
  res.json(db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.sub));
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('UPDATE accounts SET archived = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

// ---------- Categories ----------
app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY group_name, name').all(req.user.sub));
});

app.post('/api/categories', (req, res) => {
  const { name, group_name = 'General', is_income = 0 } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO categories (id, user_id, name, group_name, is_income) VALUES (?,?,?,?,?)').run(id, req.user.sub, name, group_name, is_income ? 1 : 0);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, req.user.sub));
});

// ---------- Transactions ----------
app.get('/api/transactions', (req, res) => {
  const { account_id, category_id, from, to, q, limit = 200 } = req.query;
  let sql = 'SELECT t.*, c.name category_name, a.name account_name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id WHERE t.user_id = ?';
  const params = [req.user.sub];
  if (account_id) { sql += ' AND t.account_id = ?'; params.push(account_id); }
  if (category_id) { sql += ' AND t.category_id = ?'; params.push(category_id); }
  if (from) { sql += ' AND t.date >= ?'; params.push(from); }
  if (to) { sql += ' AND t.date <= ?'; params.push(to); }
  if (q) { sql += ' AND (t.payee LIKE ? OR t.notes LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY t.date DESC, t.created_at DESC LIMIT ?';
  params.push(Number(limit));
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/transactions', (req, res) => {
  const { account_id, category_id, date, amount, payee, notes } = req.body;
  if (!account_id || !date || amount === undefined) {
    return res.status(400).json({ error: 'account_id, date and amount are required' });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO transactions (id, user_id, account_id, category_id, date, amount, payee, notes, source)
              VALUES (?,?,?,?,?,?,?,?,'manual')`)
    .run(id, req.user.sub, account_id, category_id || null, date, amount, payee || '', notes || '');
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, req.user.sub));
});

app.put('/api/transactions/:id', (req, res) => {
  const { account_id, category_id, date, amount, payee, notes, is_reconciled } = req.body;
  db.prepare(`UPDATE transactions SET account_id=?, category_id=?, date=?, amount=?, payee=?, notes=?, is_reconciled=?
              WHERE id=? AND user_id=?`)
    .run(account_id, category_id || null, date, amount, payee || '', notes || '', is_reconciled ? 1 : 0, req.params.id, req.user.sub);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.sub));
});

app.delete('/api/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

// ---------- Budgets ----------
app.get('/api/budgets/:month', (req, res) => {
  res.json(budgetSummary(db, req.user.sub, req.params.month));
});

app.post('/api/budgets', (req, res) => {
  const { category_id, month, amount } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO budgets (id, user_id, category_id, month, amount) VALUES (?,?,?,?,?)
              ON CONFLICT(user_id, category_id, month) DO UPDATE SET amount = excluded.amount`)
    .run(id, req.user.sub, category_id, month, amount);
  res.json({ ok: true });
});

// ---------- Bills ----------
app.get('/api/bills', (req, res) => {
  res.json(db.prepare('SELECT b.*, c.name category_name FROM bills b LEFT JOIN categories c ON c.id = b.category_id WHERE b.active = 1 AND b.user_id = ? ORDER BY due_day').all(req.user.sub));
});

app.post('/api/bills', (req, res) => {
  const { name, amount, due_day, frequency = 'monthly', category_id, account_id } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO bills (id, user_id, name, amount, due_day, frequency, category_id, account_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.sub, name, amount, due_day, frequency, category_id || null, account_id || null);
  res.json(db.prepare('SELECT * FROM bills WHERE id = ? AND user_id = ?').get(id, req.user.sub));
});

app.delete('/api/bills/:id', (req, res) => {
  db.prepare('UPDATE bills SET active = 0 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

// ---------- Planning / Reporting ----------
app.get('/api/networth', (req, res) => res.json(currentNetWorth(db, req.user.sub)));
app.get('/api/networth/breakdown', (req, res) => res.json(netWorthBreakdown(db, req.user.sub)));

app.get('/api/forecast', (req, res) => {
  const days = Number(req.query.days || 90);
  res.json(projectCashflow(db, req.user.sub, days));
});

// ---------- Data ownership: export / import ----------
// format: json (full backup/restore), csv (spreadsheet-friendly), qif (Quicken/MS Money style)
app.get('/api/export', (req, res) => {
  const format = req.query.format || 'json';
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="peny-export-${Date.now()}.csv"`);
    return res.send(toCSV(db, req.user.sub));
  }
  if (format === 'qif') {
    res.setHeader('Content-Type', 'application/qif');
    res.setHeader('Content-Disposition', `attachment; filename="peny-export-${Date.now()}.qif"`);
    return res.send(toQIF(db, req.user.sub));
  }
  res.setHeader('Content-Disposition', `attachment; filename="peny-export-${Date.now()}.json"`);
  res.json(fullJSON(db, req.user.sub));
});

// Import a bank statement: CSV (any UK bank's download), OFX/QFX, or QIF
// (Microsoft Money / Quicken). format can be 'auto' — P.E.N.Y works it out.
// dayFirst: only matters for QIF (CSV is always read UK-style, day first).
// flipSigns: for credit card files where spending is shown as positive.
function readStatement(body) {
  const { content, filename, dayFirst, flipSigns } = body;
  let { format } = body;
  if (!content) throw new Error('The file was empty');
  if (!format || format === 'auto') format = detectFormat(filename, content);
  let records; let detected = '';
  if (format === 'csv') { const r = parseCSV(content); records = r.records; detected = r.detected; }
  else { records = parseStatement(format, content, { dayFirst }); detected = format.toUpperCase() + ' file'; }
  if (flipSigns) records = records.map(r => ({ ...r, amount: -r.amount }));
  return { format, records, detected };
}

app.post('/api/import/preview', (req, res) => {
  try {
    const { format, records, detected } = readStatement(req.body);
    const dates = records.map(r => r.date).sort();
    res.json({
      format, detected, count: records.length,
      from: dates[0] || null, to: dates[dates.length - 1] || null,
      moneyIn: records.filter(r => r.amount > 0).reduce((t, r) => t + r.amount, 0),
      moneyOut: records.filter(r => r.amount < 0).reduce((t, r) => t + r.amount, 0),
      sample: records.slice(0, 5),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/import/statement', (req, res) => {
  try {
    const { account_id } = req.body;
    if (!req.body.content || !account_id) {
      return res.status(400).json({ error: 'Pick a file and the account it belongs to' });
    }
    // Make sure this account actually belongs to the person importing —
    // otherwise account_id could be guessed to inject transactions elsewhere.
    const owns = db.prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.user.sub);
    if (!owns) return res.status(404).json({ error: 'Account not found' });

    const { records } = readStatement(req.body);
    const result = insertTransactions(req.user.sub, account_id, records.map(r => ({
      date: r.date, amount: r.amount, payee: r.payee || '', notes: r.memo || '',
      externalId: r.externalId || `${r.date}-${r.amount}-${r.payee || ''}-${r.memo || ''}`, // same format as v1.8 so re-imports still dedupe
    })), 'import');
    res.json({ ok: true, added: result.added, skipped: result.skipped, total: records.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Shared by statement import and bank sync. Skips anything already in P.E.N.Y.
// Two identical lines on the same day (e.g. two £3.20 coffees) are kept apart
// by numbering repeats within the same file.
function insertTransactions(userId, accountId, rows, source) {
  const exists = db.prepare('SELECT 1 FROM transactions WHERE external_id = ? AND account_id = ? AND user_id = ?');
  const insert = db.prepare(`INSERT INTO transactions
    (id, user_id, account_id, date, amount, payee, notes, source, external_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let added = 0, skipped = 0;
  const seen = {};
  db.transaction(() => {
    rows.forEach(r => {
      seen[r.externalId] = (seen[r.externalId] || 0) + 1;
      const extId = seen[r.externalId] > 1 ? `${r.externalId}#${seen[r.externalId]}` : r.externalId;
      if (exists.get(extId, accountId, userId)) { skipped++; return; }
      insert.run(uuidv4(), userId, accountId, r.date, r.amount, r.payee, r.notes || '', source, extId);
      added++;
    });
  })();
  return { added, skipped };
}

// Restores a full P.E.N.Y JSON backup into the current person's account —
// always scoped to whoever is logged in and importing, regardless of
// whose user_id was in the exported file originally.
app.post('/api/import', (req, res) => {
  const uid = req.user.sub;
  const { accounts = [], categories = [], transactions = [], budgets = [], bills = [], pensions: pensionRows = [], investments: investmentRows = [] } = req.body;
  const tx = db.transaction(() => {
    const insA = db.prepare('INSERT OR REPLACE INTO accounts (id,user_id,name,type,starting_balance,currency,is_linked,gocardless_account_id,last_synced_at,archived,created_at) VALUES (@id,@user_id,@name,@type,@starting_balance,@currency,@is_linked,@gocardless_account_id,@last_synced_at,@archived,@created_at)');
    accounts.forEach(a => insA.run({ ...a, user_id: uid }));
    const insC = db.prepare('INSERT OR REPLACE INTO categories (id,user_id,name,group_name,is_income) VALUES (@id,@user_id,@name,@group_name,@is_income)');
    categories.forEach(c => insC.run({ ...c, user_id: uid }));
    const insT = db.prepare('INSERT OR REPLACE INTO transactions (id,user_id,account_id,category_id,date,amount,payee,notes,is_reconciled,source,external_id,created_at) VALUES (@id,@user_id,@account_id,@category_id,@date,@amount,@payee,@notes,@is_reconciled,@source,@external_id,@created_at)');
    transactions.forEach(t => insT.run({ ...t, user_id: uid }));
    const insB = db.prepare('INSERT OR REPLACE INTO budgets (id,user_id,category_id,month,amount) VALUES (@id,@user_id,@category_id,@month,@amount)');
    budgets.forEach(b => insB.run({ ...b, user_id: uid }));
    const insBl = db.prepare('INSERT OR REPLACE INTO bills (id,user_id,name,amount,due_day,frequency,category_id,account_id,active) VALUES (@id,@user_id,@name,@amount,@due_day,@frequency,@category_id,@account_id,@active)');
    bills.forEach(b => insBl.run({ ...b, user_id: uid }));
    const insP = db.prepare('INSERT OR REPLACE INTO pensions (id,user_id,name,current_value,monthly_contribution_personal,monthly_contribution_employer,growth_rate_percent,retirement_age,notes,archived,created_at) VALUES (@id,@user_id,@name,@current_value,@monthly_contribution_personal,@monthly_contribution_employer,@growth_rate_percent,@retirement_age,@notes,@archived,@created_at)');
    pensionRows.forEach(p => insP.run({ ...p, user_id: uid }));
    const insI = db.prepare('INSERT OR REPLACE INTO investments (id,user_id,name,type,current_value,purchase_value,units,growth_rate_percent,notes,archived,created_at) VALUES (@id,@user_id,@name,@type,@current_value,@purchase_value,@units,@growth_rate_percent,@notes,@archived,@created_at)');
    investmentRows.forEach(i => insI.run({ ...i, user_id: uid }));
  });
  tx();
  res.json({ ok: true });
});

// ---------- Bank sync (Enable Banking, read-only) ----------
// Everything is set up from the app (More > Bank Sync) — no .env editing.
// Each person stores their own Enable Banking Application ID + key file,
// so everyone's bank links stay private to them.

function getSetting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? row.value : null;
}
function setSetting(userId, key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
  } else {
    db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, String(value));
  }
}
function getBankCreds(userId) {
  const appId = getSetting(userId, 'eb_app_id');
  const boxed = getSetting(userId, 'eb_private_key');
  if (!appId || !boxed) return null;
  return { appId, privateKey: secretbox.decrypt(boxed) };
}
function defaultRedirect(req) {
  return `${req.protocol}://${req.get('host')}/api/banksync/callback`;
}

// What the setup wizard needs to show
app.get('/api/banksync/setup', (req, res) => {
  const uid = req.user.sub;
  res.json({
    configured: !!(getSetting(uid, 'eb_app_id') && getSetting(uid, 'eb_private_key')),
    appId: getSetting(uid, 'eb_app_id'),
    redirectUrl: getSetting(uid, 'eb_redirect_url') || defaultRedirect(req),
    suggestedRedirectUrl: defaultRedirect(req),
    country: getSetting(uid, 'eb_country') || 'GB',
  });
});

// Save + test the Application ID and key file in one go
app.post('/api/banksync/setup', async (req, res) => {
  try {
    const uid = req.user.sub;
    const appId = String(req.body.appId || '').trim();
    let privateKey = String(req.body.privateKey || '').trim();
    const redirectUrl = String(req.body.redirectUrl || '').trim() || defaultRedirect(req);
    const country = String(req.body.country || 'GB').trim().toUpperCase().slice(0, 2);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
      return res.status(400).json({ error: 'That doesn\'t look like an Application ID. It\'s a long code like 1a2b3c4d-1234-5678-9abc-1234567890ab — copy it from your application in the Enable Banking control panel.' });
    }
    if (!privateKey) {
      const existing = getBankCreds(uid);
      if (existing && existing.appId === appId) privateKey = existing.privateKey;
    }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
      return res.status(400).json({ error: 'Pick the key file (.pem) Enable Banking downloaded when you registered your application. It starts with "-----BEGIN PRIVATE KEY-----".' });
    }
    if (!/^https?:\/\/\S+$/i.test(redirectUrl)) return res.status(400).json({ error: 'The return address must start with https:// or http://' });

    // Test it before saving, so mistakes show up now rather than later
    const banks = await eb.listBanks({ appId, privateKey }, country);

    setSetting(uid, 'eb_app_id', appId);
    setSetting(uid, 'eb_private_key', secretbox.encrypt(privateKey));
    setSetting(uid, 'eb_redirect_url', redirectUrl);
    setSetting(uid, 'eb_country', country);
    res.json({ ok: true, bankCount: banks.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Remove the keys and disconnect everything (the person's transactions stay)
app.delete('/api/banksync/setup', async (req, res) => {
  const uid = req.user.sub;
  const creds = (() => { try { return getBankCreds(uid); } catch (_) { return null; } })();
  const conns = db.prepare("SELECT * FROM bank_connections WHERE user_id = ? AND status = 'active'").all(uid);
  for (const c of conns) { if (creds) await eb.deleteSession(creds, c.session_id); }
  db.prepare("UPDATE bank_connections SET status = 'removed' WHERE user_id = ?").run(uid);
  db.prepare('UPDATE bank_remote_accounts SET peny_account_id = NULL WHERE user_id = ?').run(uid);
  db.prepare('UPDATE accounts SET is_linked = 0 WHERE user_id = ?').run(uid);
  ['eb_app_id', 'eb_private_key', 'eb_redirect_url', 'eb_country'].forEach(k => setSetting(uid, k, null));
  res.json({ ok: true });
});

app.get('/api/banksync/banks', async (req, res) => {
  try {
    const uid = req.user.sub;
    const country = (req.query.country || getSetting(uid, 'eb_country') || 'GB').toUpperCase();
    res.json(await eb.listBanks(getBankCreds(uid), country));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Step 1 of connecting: returns the bank's login page address
app.post('/api/banksync/connect', async (req, res) => {
  try {
    const uid = req.user.sub;
    const creds = getBankCreds(uid);
    const { bankName, maxConsentDays } = req.body;
    const country = (req.body.country || getSetting(uid, 'eb_country') || 'GB').toUpperCase();
    if (!bankName) return res.status(400).json({ error: 'Choose your bank first' });
    const state = crypto.randomBytes(18).toString('hex');
    db.prepare("DELETE FROM bank_auth_pending WHERE created_at < datetime('now', '-1 day')").run();
    db.prepare('INSERT INTO bank_auth_pending (state, user_id, bank_name, country) VALUES (?,?,?,?)').run(state, uid, bankName, country);
    const days = Math.max(1, Math.min(Number(maxConsentDays) || 90, 180));
    const auth = await eb.startAuth(creds, { bankName, country, redirectUrl: getSetting(uid, 'eb_redirect_url') || defaultRedirect(req), state, days });
    res.json({ url: auth.url, state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Step 2: swap the bank's one-time code for a connection + account list
async function completeBankLogin(state, code) {
  const pending = db.prepare('SELECT * FROM bank_auth_pending WHERE state = ?').get(state);
  if (!pending) throw new Error('This bank login has expired or was already used. Start the connection again from More > Bank Sync.');
  const creds = getBankCreds(pending.user_id);
  const session = await eb.createSession(creds, code);
  const connId = uuidv4();
  const validUntil = session.access && session.access.valid_until ? session.access.valid_until : null;
  db.transaction(() => {
    db.prepare('INSERT INTO bank_connections (id, user_id, session_id, bank_name, country, valid_until) VALUES (?,?,?,?,?,?)')
      .run(connId, pending.user_id, session.session_id, pending.bank_name, pending.country, validUntil);
    (session.accounts || []).forEach(a => {
      const ident = (a.account_id && (a.account_id.iban || (a.account_id.other && a.account_id.other.identification))) || '';
      // Reconnecting the same bank account keeps its link to the same P.E.N.Y account
      const previous = db.prepare('SELECT peny_account_id FROM bank_remote_accounts WHERE user_id = ? AND identifier = ? AND name IS ? AND peny_account_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')
        .get(pending.user_id, maskId(ident), a.name || a.product || null);
      db.prepare('INSERT INTO bank_remote_accounts (id, user_id, connection_id, remote_uid, name, identifier, currency, peny_account_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(uuidv4(), pending.user_id, connId, a.uid, a.name || a.product || 'Bank account', maskId(ident), a.currency || 'GBP', previous ? previous.peny_account_id : null);
    });
    db.prepare('DELETE FROM bank_auth_pending WHERE state = ?').run(state);
  })();
  return { connectionId: connId, accounts: (session.accounts || []).length, bankName: pending.bank_name };
}
function maskId(id) { const s = String(id || '').replace(/\s/g, ''); return s ? '••••' + s.slice(-4) : ''; }

// The bank sends the person's browser back here after they log in.
// Needs no P.E.N.Y login: the random state value proves which person it is.
app.get('/api/banksync/callback', async (req, res) => {
  const page = (title, msg, ok) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>P.E.N.Y</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#05100D;color:#E8F5F0;font-family:'Segoe UI',Arial,sans-serif;padding:20px}
.c{max-width:420px;padding:28px;border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.03));border:1px solid rgba(94,234,212,.25);text-align:center}
h1{color:${ok ? '#5EEAD4' : '#F87171'};font-size:22px;margin:0 0 10px}p{color:#8A9A96;line-height:1.5}</style></head>
<body><div class="c"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(page('Bank connection cancelled', `Your bank said: ${String(error_description || error).replace(/[<>]/g, '')}. You can close this tab and try again in P.E.N.Y.`, false));
    if (!code || !state) return res.status(400).send(page('Something is missing', 'This page needs the code your bank sends back. Start the connection again from P.E.N.Y.', false));
    const r = await completeBankLogin(String(state), String(code));
    res.send(page('Bank connected', `${r.bankName} is connected (${r.accounts} account${r.accounts === 1 ? '' : 's'}). Close this tab and go back to P.E.N.Y to choose which account each one feeds.`, true));
  } catch (e) {
    res.status(400).send(page('Could not finish connecting', String(e.message).replace(/[<>]/g, ''), false));
  }
});

// If the return address can't reach P.E.N.Y (e.g. it's a placeholder page),
// the person pastes the address they landed on, and we finish from that.
app.post('/api/banksync/complete', async (req, res) => {
  try {
    const raw = String(req.body.returnedUrl || '').trim();
    let code, state;
    try { const u = new URL(raw); code = u.searchParams.get('code'); state = u.searchParams.get('state'); } catch (_) { /* not a URL */ }
    if (!code || !state) return res.status(400).json({ error: 'Paste the whole address from your browser\'s address bar after logging in to your bank — it contains "code=" and "state=".' });
    const pending = db.prepare('SELECT user_id FROM bank_auth_pending WHERE state = ?').get(state);
    if (!pending || pending.user_id !== req.user.sub) return res.status(400).json({ error: 'That address belongs to an older or different bank login. Start the connection again.' });
    res.json({ ok: true, ...(await completeBankLogin(state, code)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Bank accounts found, and which P.E.N.Y account each one feeds
app.get('/api/banksync/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.identifier, r.currency, r.peny_account_id, r.last_synced_at, r.last_balance, r.last_error,
           c.bank_name, c.valid_until, c.status, c.id AS connection_id, a.name AS peny_account_name
    FROM bank_remote_accounts r
    JOIN bank_connections c ON c.id = r.connection_id
    LEFT JOIN accounts a ON a.id = r.peny_account_id
    WHERE r.user_id = ? AND c.status != 'removed'
    ORDER BY c.created_at DESC, r.name`).all(req.user.sub);
  res.json(rows);
});

// Link a bank account to an existing P.E.N.Y account, or create a new one
app.post('/api/banksync/accounts/:id/link', (req, res) => {
  const uid = req.user.sub;
  const remote = db.prepare('SELECT * FROM bank_remote_accounts WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!remote) return res.status(404).json({ error: 'Bank account not found' });
  let penyId = req.body.penyAccountId || null;
  if (req.body.createNew) {
    penyId = uuidv4();
    const type = ['current', 'savings', 'credit', 'loan', 'cash'].includes(req.body.type) ? req.body.type : 'current';
    db.prepare('INSERT INTO accounts (id, user_id, name, type, starting_balance, currency) VALUES (?,?,?,?,0,?)')
      .run(penyId, uid, String(req.body.name || remote.name || 'Bank account').slice(0, 80), type, remote.currency || 'GBP');
    setSetting(uid, `eb_new_account_${penyId}`, '1'); // first sync sets the opening balance to match the bank
  } else if (penyId) {
    const owns = db.prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?').get(penyId, uid);
    if (!owns) return res.status(404).json({ error: 'Account not found' });
  }
  db.prepare('UPDATE bank_remote_accounts SET peny_account_id = ? WHERE id = ?').run(penyId, remote.id);
  if (penyId) db.prepare('UPDATE accounts SET is_linked = 1 WHERE id = ?').run(penyId);
  res.json({ ok: true, penyAccountId: penyId });
});

app.delete('/api/banksync/connections/:id', async (req, res) => {
  const uid = req.user.sub;
  const conn = db.prepare('SELECT * FROM bank_connections WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  try { const creds = getBankCreds(uid); if (creds) await eb.deleteSession(creds, conn.session_id); } catch (_) {}
  db.prepare("UPDATE bank_connections SET status = 'removed' WHERE id = ?").run(conn.id);
  refreshLinkedFlags(uid);
  res.json({ ok: true });
});

function refreshLinkedFlags(uid) {
  db.prepare(`UPDATE accounts SET is_linked = CASE WHEN id IN (
      SELECT r.peny_account_id FROM bank_remote_accounts r JOIN bank_connections c ON c.id = r.connection_id
      WHERE r.user_id = ? AND c.status = 'active' AND r.peny_account_id IS NOT NULL) THEN 1 ELSE 0 END
    WHERE user_id = ?`).run(uid, uid);
}

// Pull new transactions for every linked account. Read-only.
let syncInFlight = new Set();
app.post('/api/banksync/sync', async (req, res) => {
  const uid = req.user.sub;
  if (syncInFlight.has(uid)) return res.status(409).json({ error: 'A sync is already running' });
  syncInFlight.add(uid);
  try {
    const creds = getBankCreds(uid);
    if (!creds) return res.status(400).json({ error: 'Bank sync is not set up yet' });
    const remotes = db.prepare(`SELECT r.*, c.valid_until, c.bank_name FROM bank_remote_accounts r JOIN bank_connections c ON c.id = r.connection_id
      WHERE r.user_id = ? AND c.status = 'active' AND r.peny_account_id IS NOT NULL`).all(uid);
    let added = 0; const problems = [];
    for (const r of remotes) {
      if (r.valid_until && new Date(r.valid_until) < new Date()) {
        db.prepare("UPDATE bank_connections SET status = 'expired' WHERE id = ?").run(r.connection_id);
        problems.push(`${r.bank_name}: access has expired — reconnect it`);
        continue;
      }
      try {
        // First sync: last 90 days. After that: from a week before the last sync, to catch late-posting items.
        const from = r.last_synced_at
          ? new Date(new Date(r.last_synced_at + 'Z').getTime() - 7 * 86400000).toISOString().slice(0, 10)
          : new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const txs = (await eb.getTransactions(creds, r.remote_uid, from))
          .filter(t => !t.status || t.status === 'BOOK')
          .map(eb.toPenyTransaction)
          .filter(t => t.date && !isNaN(t.amount));
        const result = insertTransactions(uid, r.peny_account_id, txs, 'bank');
        added += result.added;

        let balance = null;
        try { balance = eb.pickBalance(await eb.getBalances(creds, r.remote_uid)); } catch (_) { /* balance is a bonus */ }
        if (balance !== null) {
          db.prepare("UPDATE accounts SET bank_balance = ?, bank_balance_at = datetime('now') WHERE id = ?").run(balance, r.peny_account_id);
          // A brand-new account made from the bank: set its opening balance so P.E.N.Y matches the bank today
          if (getSetting(uid, `eb_new_account_${r.peny_account_id}`)) {
            const sum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE account_id = ? AND user_id = ?').get(r.peny_account_id, uid).s;
            db.prepare('UPDATE accounts SET starting_balance = ? WHERE id = ?').run(Math.round((balance - sum) * 100) / 100, r.peny_account_id);
            setSetting(uid, `eb_new_account_${r.peny_account_id}`, null);
          }
        }
        db.prepare("UPDATE bank_remote_accounts SET last_synced_at = datetime('now'), last_balance = ?, last_error = NULL WHERE id = ?").run(balance, r.id);
        db.prepare("UPDATE accounts SET last_synced_at = datetime('now') WHERE id = ?").run(r.peny_account_id);
      } catch (e) {
        db.prepare('UPDATE bank_remote_accounts SET last_error = ? WHERE id = ?').run(e.message.slice(0, 300), r.id);
        if (/expired/i.test(e.message)) db.prepare("UPDATE bank_connections SET status = 'expired' WHERE id = ?").run(r.connection_id);
        problems.push(`${r.name}: ${e.message}`);
      }
    }
    res.json({ ok: problems.length === 0, added, accounts: remotes.length, problems, lastSyncedAt: new Date().toISOString() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    syncInFlight.delete(uid);
  }
});

// Status for the header sync indicator
app.get('/api/banksync/status', (req, res) => {
  const uid = req.user.sub;
  const configured = !!getSetting(uid, 'eb_app_id');
  const linked = db.prepare(`SELECT r.name, r.last_synced_at, r.last_error, c.status, c.valid_until, c.bank_name
    FROM bank_remote_accounts r JOIN bank_connections c ON c.id = r.connection_id
    WHERE r.user_id = ? AND c.status != 'removed' AND r.peny_account_id IS NOT NULL`).all(uid);
  if (!linked.length) return res.json({ state: 'none', configured });
  const expired = linked.filter(l => l.status === 'expired' || (l.valid_until && new Date(l.valid_until) < new Date()));
  const errors = linked.filter(l => l.last_error);
  const synced = linked.filter(l => l.last_synced_at).map(l => l.last_synced_at).sort();
  const soonest = linked.map(l => l.valid_until).filter(Boolean).sort()[0] || null;
  res.json({
    state: expired.length ? 'expired' : errors.length ? 'error' : 'synced',
    configured,
    lastSyncedAt: synced[0] || null,
    expiresAt: soonest,
    accounts: linked.map(l => ({ name: l.name, bank: l.bank_name, lastSyncedAt: l.last_synced_at, error: l.last_error })),
  });
});

// ---------- Reports / print summaries ----------
// type: 'month' (periodKey 'YYYY-MM'), 'year' ('YYYY'), or '5year' (start year 'YYYY')
app.get('/api/reports/:type/:periodKey', (req, res) => {
  try {
    res.json(buildSummaryReport(db, req.user.sub, req.params.type, req.params.periodKey));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Investments (stocks, shares, funds, ETFs, etc) ----------
app.get('/api/investments', (req, res) => {
  res.json(db.prepare('SELECT * FROM investments WHERE archived = 0 AND user_id = ? ORDER BY created_at').all(req.user.sub));
});

app.post('/api/investments', (req, res) => {
  const { name, type = 'fund', current_value = 0, purchase_value = null, units = null, growth_rate_percent = 5, notes = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'A name for this investment is required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO investments (id, user_id, name, type, current_value, purchase_value, units, growth_rate_percent, notes)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.sub, name, type, current_value, purchase_value, units, growth_rate_percent, notes);
  res.json(db.prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?').get(id, req.user.sub));
});

app.put('/api/investments/:id', (req, res) => {
  const { name, type, current_value, purchase_value, units, growth_rate_percent, notes } = req.body;
  db.prepare(`UPDATE investments SET name=?, type=?, current_value=?, purchase_value=?, units=?, growth_rate_percent=?, notes=?
              WHERE id=? AND user_id=?`)
    .run(name, type, current_value, purchase_value, units, growth_rate_percent, notes || '', req.params.id, req.user.sub);
  res.json(db.prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.sub));
});

app.delete('/api/investments/:id', (req, res) => {
  db.prepare('UPDATE investments SET archived = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

app.get('/api/investments/summary', (req, res) => {
  res.json(investmentsModule.buildInvestmentsSummary(db, req.user.sub));
});

app.get('/api/growth-projection', (req, res) => {
  const years = req.query.years ? parseInt(req.query.years) : undefined;
  res.json(buildGrowthProjection(db, req.user.sub, years));
});

// ---------- Pensions & Retirement ----------
app.get('/api/pensions', (req, res) => {
  res.json(db.prepare('SELECT * FROM pensions WHERE archived = 0 AND user_id = ? ORDER BY created_at').all(req.user.sub));
});

app.post('/api/pensions', (req, res) => {
  const { name, current_value = 0, monthly_contribution_personal = 0, monthly_contribution_employer = 0, growth_rate_percent = 5, retirement_age = 67, notes = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'A name for this pension is required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO pensions
    (id, user_id, name, current_value, monthly_contribution_personal, monthly_contribution_employer, growth_rate_percent, retirement_age, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.sub, name, current_value, monthly_contribution_personal, monthly_contribution_employer, growth_rate_percent, retirement_age, notes);
  res.json(db.prepare('SELECT * FROM pensions WHERE id = ? AND user_id = ?').get(id, req.user.sub));
});

app.put('/api/pensions/:id', (req, res) => {
  const { name, current_value, monthly_contribution_personal, monthly_contribution_employer, growth_rate_percent, retirement_age, notes } = req.body;
  db.prepare(`UPDATE pensions SET name=?, current_value=?, monthly_contribution_personal=?, monthly_contribution_employer=?, growth_rate_percent=?, retirement_age=?, notes=?
              WHERE id=? AND user_id=?`)
    .run(name, current_value, monthly_contribution_personal, monthly_contribution_employer, growth_rate_percent, retirement_age, notes || '', req.params.id, req.user.sub);
  res.json(db.prepare('SELECT * FROM pensions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.sub));
});

app.delete('/api/pensions/:id', (req, res) => {
  db.prepare('UPDATE pensions SET archived = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

app.get('/api/pensions/summary', (req, res) => {
  res.json(pensions.buildPensionSummary(db, req.user.sub));
});

app.get('/api/retirement-settings', (req, res) => {
  res.json(pensions.getRetirementSettings(db, req.user.sub));
});

app.put('/api/retirement-settings', (req, res) => {
  pensions.saveRetirementSettings(db, req.user.sub, req.body);
  res.json(pensions.getRetirementSettings(db, req.user.sub));
});

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'P.E.N.Y', version: '1.9.0', edition: process.env.PENY_EDITION || 'Server Edition' }));

// Standalone (Windows) edition: any non-API GET falls back to the app itself
if (process.env.SERVE_STATIC_FROM) {
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(require('path').join(process.env.SERVE_STATIC_FROM, 'index.html'));
  });
}

// The server/Docker edition needs to listen on all interfaces so other
// devices on your network can reach it. The Windows desktop edition sets
// LISTEN_HOST=127.0.0.1 so nothing else on the network can reach it at all
// — it's meant for one PC only, not a household network service.
const HOST = process.env.LISTEN_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`PENY backend running on ${HOST}:${PORT}`));
