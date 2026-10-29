// db.js — sets up the local SQLite database. All your data lives in one file
// on disk at /data/peny.db (mapped to your TrueNAS SSD pool via Docker volume).
// Nothing leaves this box unless you turn on bank sync.
//
// Every table that holds personal data carries a user_id column, so each
// person who logs in only ever sees their own accounts, transactions,
// budgets, bills, pensions, and investments — never anyone else's, even
// though everyone shares the same P.E.N.Y installation and database file.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = process.env.PENY_DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'peny.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_code_hash TEXT,          -- lets them reset a forgotten password without an email server
  totp_secret TEXT,                 -- set once they scan the QR code
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,               -- current, savings, credit, loan, investment, cash
  starting_balance REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  is_linked INTEGER NOT NULL DEFAULT 0,   -- 1 if connected via GoCardless
  gocardless_account_id TEXT,
  last_synced_at TEXT,              -- when we last pulled bank transactions in
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'General',   -- e.g. Essentials, Lifestyle, Bills
  is_income INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  category_id TEXT REFERENCES categories(id),
  date TEXT NOT NULL,               -- ISO date, e.g. 2026-07-30
  amount REAL NOT NULL,             -- positive = income, negative = expense
  payee TEXT,
  notes TEXT,
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | gocardless | import
  external_id TEXT,                 -- bank transaction id, used to avoid duplicate imports
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  month TEXT NOT NULL,              -- YYYY-MM
  amount REAL NOT NULL,
  UNIQUE(user_id, category_id, month)
);

-- Per-user settings (retirement assumptions, withdrawal rate, etc).
-- Replaces the old global "settings" table so each person can have their
-- own date of birth, withdrawal rate, and state pension figure.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,               -- e.g. "Vanguard FTSE Global All Cap", "Apple Inc (AAPL)"
  type TEXT NOT NULL DEFAULT 'fund',   -- stock, fund, etf, share, bond, other
  current_value REAL NOT NULL DEFAULT 0,
  purchase_value REAL,              -- optional, lets P.E.N.Y show gain/loss
  units REAL,                       -- optional, e.g. number of shares held
  growth_rate_percent REAL DEFAULT 5,  -- assumed annual growth, used only for the Plan screen projection chart
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pensions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,               -- e.g. "Workplace Pension — Aviva"
  current_value REAL NOT NULL DEFAULT 0,
  monthly_contribution_personal REAL NOT NULL DEFAULT 0,
  monthly_contribution_employer REAL NOT NULL DEFAULT 0,
  growth_rate_percent REAL NOT NULL DEFAULT 5,   -- assumed annual growth, before retirement
  retirement_age INTEGER NOT NULL DEFAULT 67,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  due_day INTEGER NOT NULL,         -- day of month, 1-31
  frequency TEXT NOT NULL DEFAULT 'monthly',  -- monthly, weekly, yearly
  category_id TEXT REFERENCES categories(id),
  account_id TEXT REFERENCES accounts(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS gocardless_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  requisition_id TEXT NOT NULL,
  institution_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// A sensible starter set of categories, seeded fresh for each new person
// when they register — so everyone gets their own editable category list
// rather than sharing one.
const DEFAULT_CATEGORIES = [
  ['Salary', 'Income', 1], ['Other Income', 'Income', 1],
  ['Groceries', 'Essentials', 0], ['Rent/Mortgage', 'Essentials', 0],
  ['Utilities', 'Essentials', 0], ['Insurance', 'Essentials', 0],
  ['Transport', 'Essentials', 0], ['Healthcare', 'Essentials', 0],
  ['Eating Out', 'Lifestyle', 0], ['Entertainment', 'Lifestyle', 0],
  ['Shopping', 'Lifestyle', 0], ['Subscriptions', 'Lifestyle', 0],
  ['Savings Transfer', 'Savings', 0], ['Debt Repayment', 'Savings', 0],
  ['Other', 'General', 0],
];
function seedDefaultCategories(userId) {
  const insert = db.prepare('INSERT INTO categories (id, user_id, name, group_name, is_income) VALUES (?,?,?,?,?)');
  const tx = db.transaction((rows) => rows.forEach(r => insert.run(uuidv4(), userId, r[0], r[1], r[2])));
  tx(DEFAULT_CATEGORIES);
}

// ---------- Safe schema migration ----------
// If you're upgrading from an earlier version, CREATE TABLE IF NOT EXISTS
// above won't add new columns to a table that already exists, and won't
// retroactively make old shared data belong to anyone. This adds any
// missing columns, then — only if there's existing data with no owner —
// assigns it all to whoever was the very first person to register, so
// nothing is lost or hidden. From that point on, every new record is
// correctly scoped to whoever created it.
function ensureColumn(table, column, definitionSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definitionSql}`);
  }
}
ensureColumn('investments', 'growth_rate_percent', 'REAL DEFAULT 5');

const userDataTables = ['accounts', 'categories', 'transactions', 'budgets', 'investments', 'pensions', 'bills', 'gocardless_links'];
userDataTables.forEach(t => ensureColumn(t, 'user_id', 'TEXT'));

function backfillOwnership() {
  const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
  if (!firstUser) return; // no users yet — nothing to backfill, fresh install
  userDataTables.forEach(t => {
    const orphaned = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id IS NULL`).get().c;
    if (orphaned > 0) {
      db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(firstUser.id);
    }
  });
}
backfillOwnership();

module.exports = db;
module.exports.seedDefaultCategories = seedDefaultCategories;
