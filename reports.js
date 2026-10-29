// reports.js — builds the data behind the printable A4 summary: net worth,
// income vs expense, category breakdown, budget performance, and bills,
// for a chosen month, year, or 5-year span.

function periodRange(type, periodKey) {
  // periodKey: for 'month' -> 'YYYY-MM', for 'year' -> 'YYYY', for '5year' -> 'YYYY' (start year)
  if (type === 'month') {
    const [y, m] = periodKey.split('-').map(Number);
    const from = `${periodKey}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${periodKey}-${String(lastDay).padStart(2, '0')}`;
    return { from, to, label: new Date(from).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) };
  }
  if (type === 'year') {
    return { from: `${periodKey}-01-01`, to: `${periodKey}-12-31`, label: periodKey };
  }
  if (type === '5year') {
    const startYear = Number(periodKey);
    const endYear = startYear + 4;
    return { from: `${startYear}-01-01`, to: `${endYear}-12-31`, label: `${startYear}–${endYear}` };
  }
  throw new Error('Unknown report period type');
}

function buildSummaryReport(db, userId, type, periodKey) {
  const { from, to, label } = periodRange(type, periodKey);

  const accounts = db.prepare('SELECT * FROM accounts WHERE archived = 0 AND user_id = ?').all(userId);
  const netWorthByAccount = accounts.map(a => {
    const sumToDate = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE account_id = ? AND date <= ? AND user_id = ?').get(a.id, to, userId).s;
    return { name: a.name, balance: a.starting_balance + sumToDate };
  });
  const netWorth = netWorthByAccount.reduce((s, a) => s + a.balance, 0);

  const txInPeriod = db.prepare('SELECT t.*, c.name category_name, c.group_name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE date >= ? AND date <= ? AND t.user_id = ?').all(from, to, userId);
  const income = txInPeriod.filter(t => t.amount >= 0).reduce((s, t) => s + t.amount, 0);
  const expense = txInPeriod.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);

  const byCategory = {};
  txInPeriod.forEach(t => {
    const key = t.category_name || 'Uncategorised';
    byCategory[key] = byCategory[key] || { spent: 0, income: 0 };
    if (t.amount < 0) byCategory[key].spent += Math.abs(t.amount);
    else byCategory[key].income += t.amount;
  });
  const categoryBreakdown = Object.entries(byCategory)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.spent - a.spent);

  // Budgets only really make sense to show for a single month
  let budgetPerformance = [];
  if (type === 'month') {
    budgetPerformance = db.prepare(`
      SELECT b.amount budgeted, c.name category_name FROM budgets b
      JOIN categories c ON c.id = b.category_id WHERE b.month = ? AND b.user_id = ?
    `).all(periodKey, userId).map(b => {
      const spent = byCategory[b.category_name] ? byCategory[b.category_name].spent : 0;
      return { category: b.category_name, budgeted: b.budgeted, spent, remaining: b.budgeted - spent };
    });
  }

  const bills = db.prepare('SELECT * FROM bills WHERE active = 1 AND user_id = ?').all(userId);

  return {
    label, from, to, type,
    netWorth, netWorthByAccount,
    income, expense, net: income + expense,
    categoryBreakdown, budgetPerformance, bills,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildSummaryReport, periodRange };
