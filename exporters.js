// exporters.js — turns your P.E.N.Y data into formats other software can
// read, so you're never locked in. JSON keeps everything (full backup/
// restore between P.E.N.Y instances); CSV and QIF are for moving your
// transactions into a spreadsheet or another finance app. Every export
// is scoped to one person's own data only.

function toCSV(db, userId) {
  const rows = db.prepare(`
    SELECT t.date, a.name account, c.name category, t.amount, t.payee, t.notes
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ?
    ORDER BY t.date
  `).all(userId);

  const esc = (v) => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['Date', 'Account', 'Category', 'Amount', 'Payee', 'Notes'].join(',');
  const lines = rows.map(r => [r.date, r.account, r.category, r.amount, r.payee, r.notes].map(esc).join(','));
  return [header, ...lines].join('\r\n');
}

function toQIF(db, userId) {
  const rows = db.prepare(`
    SELECT t.date, c.name category, t.amount, t.payee, t.notes
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ?
    ORDER BY t.date
  `).all(userId);

  const lines = ['!Type:Bank'];
  rows.forEach(r => {
    const [y, m, d] = r.date.split('-');
    lines.push(`D${m}/${d}/${y}`);
    lines.push(`T${r.amount}`);
    if (r.payee) lines.push(`P${r.payee}`);
    if (r.notes) lines.push(`M${r.notes}`);
    if (r.category) lines.push(`L${r.category}`);
    lines.push('^');
  });
  return lines.join('\n');
}

function fullJSON(db, userId) {
  return {
    exported_at: new Date().toISOString(),
    accounts: db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId),
    categories: db.prepare('SELECT * FROM categories WHERE user_id = ?').all(userId),
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(userId),
    budgets: db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(userId),
    bills: db.prepare('SELECT * FROM bills WHERE user_id = ?').all(userId),
    pensions: db.prepare('SELECT * FROM pensions WHERE user_id = ?').all(userId),
    investments: db.prepare('SELECT * FROM investments WHERE user_id = ?').all(userId),
  };
}

module.exports = { toCSV, toQIF, fullJSON };
