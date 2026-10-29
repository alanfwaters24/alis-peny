// server.js — P.E.N.Y's backend API. Runs on your TrueNAS box, talks to the
// local SQLite database, and (optionally) to GoCardless for read-only bank
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
const gc = require('./gocardless');
const auth = require('./auth');
const { currentNetWorth, netWorthBreakdown, projectCashflow, budgetSummary } = require('./forecast');
const { buildSummaryReport } = require('./reports');
const { parseStatement } = require('./importers');
const { toCSV, toQIF, fullJSON } = require('./exporters');
const pensions = require('./pensions');
const investmentsModule = require('./investments');
const { buildGrowthProjection } = require('./growth');

const app = express();
app.use(cors());
app.use(express.json());

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
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
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

// Import a QIF or OFX file — the formats Microsoft Money and most other
// finance software can export. dayFirst: set true if your QIF dates are
// DD/MM/YYYY (UK-style) rather than the QIF-standard MM/DD/YYYY.
app.post('/api/import/statement', (req, res) => {
  try {
    const { format, content, account_id, dayFirst } = req.body;
    if (!format || !content || !account_id) {
      return res.status(400).json({ error: 'format, content and account_id are required' });
    }
    // Make sure this account actually belongs to the person importing —
    // otherwise account_id could be guessed to inject transactions elsewhere.
    const owns = db.prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.user.sub);
    if (!owns) return res.status(404).json({ error: 'Account not found' });

    const records = parseStatement(format, content, { dayFirst });
    const insert = db.prepare(`INSERT OR IGNORE INTO transactions
      (id, user_id, account_id, date, amount, payee, notes, source, external_id)
      VALUES (?,?,?,?,?,?,?,'import',?)`);

    let added = 0, skipped = 0;
    const tx = db.transaction(() => {
      records.forEach(r => {
        const externalId = r.externalId || `${r.date}-${r.amount}-${r.payee || ''}-${r.memo || ''}`;
        const exists = db.prepare('SELECT 1 FROM transactions WHERE external_id = ? AND account_id = ? AND user_id = ?').get(externalId, account_id, req.user.sub);
        if (exists) { skipped++; return; }
        insert.run(uuidv4(), req.user.sub, account_id, r.date, r.amount, r.payee || '', r.memo || '', externalId);
        added++;
      });
    });
    tx();
    res.json({ ok: true, added, skipped, total: records.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

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

// ---------- Bank sync (GoCardless, read-only) ----------
app.get('/api/banksync/institutions', async (req, res) => {
  try {
    const country = req.query.country || 'GB';
    res.json(await gc.listInstitutions(country));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/banksync/connect', async (req, res) => {
  try {
    const { institution_id, redirect_url } = req.body;
    const requisition = await gc.createRequisition(institution_id, redirect_url);
    db.prepare('INSERT INTO gocardless_links (id, user_id, requisition_id, institution_id, status) VALUES (?,?,?,?,?)')
      .run(uuidv4(), req.user.sub, requisition.id, institution_id, 'pending');
    res.json(requisition); // includes .link — send the user here to log into their bank
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/banksync/requisition/:id', async (req, res) => {
  try {
    res.json(await gc.getRequisition(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pull balances + new transactions for a linked bank account into P.E.N.Y.
// Read-only: this never writes anything back to your bank.
app.post('/api/banksync/sync/:gcAccountId/:penyAccountId', async (req, res) => {
  try {
    const { gcAccountId, penyAccountId } = req.params;
    // Confirm the target account actually belongs to whoever is syncing.
    const owns = db.prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?').get(penyAccountId, req.user.sub);
    if (!owns) return res.status(404).json({ error: 'Account not found' });

    const txData = await gc.getAccountTransactions(gcAccountId);
    const booked = (txData.transactions && txData.transactions.booked) || [];

    const insert = db.prepare(`INSERT OR IGNORE INTO transactions
      (id, user_id, account_id, date, amount, payee, notes, source, external_id)
      VALUES (?,?,?,?,?,?,?,'gocardless',?)`);

    let added = 0;
    const tx = db.transaction(() => {
      booked.forEach(t => {
        const externalId = t.transactionId || `${t.bookingDate}-${t.transactionAmount.amount}-${t.remittanceInformationUnstructured || ''}`;
        const exists = db.prepare('SELECT 1 FROM transactions WHERE external_id = ? AND account_id = ? AND user_id = ?').get(externalId, penyAccountId, req.user.sub);
        if (!exists) {
          insert.run(uuidv4(), req.user.sub, penyAccountId, t.bookingDate, parseFloat(t.transactionAmount.amount),
            t.creditorName || t.debtorName || 'Bank transaction', t.remittanceInformationUnstructured || '', externalId);
          added++;
        }
      });
    });
    tx();

    db.prepare("UPDATE accounts SET is_linked = 1, gocardless_account_id = ?, last_synced_at = datetime('now') WHERE id = ? AND user_id = ?").run(gcAccountId, penyAccountId, req.user.sub);
    res.json({ ok: true, added, lastSyncedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Simple sync status the frontend polls for the header icon:
// idle (nothing linked), synced (all linked accounts synced), or a timestamp of the oldest sync.
app.get('/api/banksync/status', (req, res) => {
  const linked = db.prepare('SELECT name, last_synced_at FROM accounts WHERE is_linked = 1 AND archived = 0 AND user_id = ?').all(req.user.sub);
  if (!linked.length) return res.json({ state: 'none' });
  const oldest = linked.reduce((min, a) => (!min || (a.last_synced_at && a.last_synced_at < min)) ? a.last_synced_at : min, null);
  res.json({ state: 'synced', lastSyncedAt: oldest, accounts: linked });
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

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'P.E.N.Y', version: '1.8.1' }));

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
