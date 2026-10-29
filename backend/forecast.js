// forecast.js — this is P.E.N.Y's version of Microsoft Money's "Financial
// Planner": it projects your balance forward using your bills, your average
// income/spending, and any budgets you've set, so you can see trouble
// coming before it happens. Every function here is scoped to a single
// user_id, so each person only ever sees their own figures.

function currentNetWorth(db, userId) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE archived = 0 AND user_id = ?').all(userId);
  let total = 0;
  const perAccount = accounts.map(acc => {
    const txSum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE account_id = ? AND user_id = ?').get(acc.id, userId).s;
    const balance = acc.starting_balance + txSum;
    total += balance;
    return { id: acc.id, name: acc.name, type: acc.type, balance };
  });
  return { total, accounts: perAccount };
}

// The dashboard's headline figure — everything you own and owe, plus
// pensions, grouped into the categories people actually think in:
// current accounts, savings, investments, and retirement (pensions).
// Credit cards, loans, and cash fall into "other" so the total still adds up.
function netWorthBreakdown(db, userId) {
  const { total: accountsTotal, accounts } = currentNetWorth(db, userId);

  const groups = { current: 0, savings: 0, investment: 0, credit: 0, loan: 0, cash: 0 };
  accounts.forEach(a => {
    if (groups[a.type] !== undefined) groups[a.type] += a.balance;
    else groups.cash += a.balance; // fallback bucket for unrecognised types
  });

  const pensionRows = db.prepare('SELECT COALESCE(SUM(current_value),0) s FROM pensions WHERE archived = 0 AND user_id = ?').get(userId);
  const retirementTotal = pensionRows.s;

  const investmentRows = db.prepare('SELECT COALESCE(SUM(current_value),0) s FROM investments WHERE archived = 0 AND user_id = ?').get(userId);
  const standaloneInvestmentsTotal = investmentRows.s;

  const otherTotal = groups.credit + groups.loan + groups.cash;

  return {
    totalNetWorth: accountsTotal + retirementTotal + standaloneInvestmentsTotal,
    breakdown: {
      current: groups.current,
      savings: groups.savings,
      investment: groups.investment + standaloneInvestmentsTotal,
      retirement: retirementTotal,
      other: otherTotal,
    },
    accountsTotal,
    retirementTotal,
    standaloneInvestmentsTotal,
  };
}

// Average monthly income/expense over the last N months of actual transactions
function averageMonthlyFlow(db, userId, months = 3) {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date) ym, amount FROM transactions
    WHERE date >= date('now', '-' || ? || ' months') AND user_id = ?
  `).all(months, userId);

  const byMonth = {};
  rows.forEach(r => {
    byMonth[r.ym] = byMonth[r.ym] || { income: 0, expense: 0 };
    if (r.amount >= 0) byMonth[r.ym].income += r.amount;
    else byMonth[r.ym].expense += r.amount;
  });
  const monthKeys = Object.keys(byMonth);
  const n = monthKeys.length || 1;
  const avgIncome = monthKeys.reduce((s, k) => s + byMonth[k].income, 0) / n;
  const avgExpense = monthKeys.reduce((s, k) => s + byMonth[k].expense, 0) / n;
  return { avgIncome, avgExpense, monthsSampled: monthKeys.length };
}

// Project balance day-by-day for `days` ahead, factoring in known recurring
// bills plus the smoothed daily average of everything else.
function projectCashflow(db, userId, days = 90) {
  const { total: startBalance } = currentNetWorth(db, userId);
  const { avgIncome, avgExpense } = averageMonthlyFlow(db, userId, 3);
  const dailyBackground = (avgIncome + avgExpense) / 30; // net, expense already negative

  const bills = db.prepare('SELECT * FROM bills WHERE active = 1 AND user_id = ?').all(userId);

  const today = new Date();
  let balance = startBalance;
  const series = [];
  const events = [];

  for (let i = 0; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dayOfMonth = d.getDate();

    let dayTotal = i === 0 ? 0 : dailyBackground; // don't double count "today"

    bills.forEach(bill => {
      const isDue =
        (bill.frequency === 'monthly' && dayOfMonth === bill.due_day) ||
        (bill.frequency === 'weekly' && i % 7 === 0) ||
        (bill.frequency === 'yearly' && dayOfMonth === bill.due_day && d.getMonth() === today.getMonth());
      if (isDue) {
        dayTotal += -Math.abs(bill.amount);
        events.push({ date: d.toISOString().slice(0, 10), label: bill.name, amount: -Math.abs(bill.amount) });
      }
    });

    balance += dayTotal;
    series.push({ date: d.toISOString().slice(0, 10), balance: Math.round(balance * 100) / 100 });
  }

  const lowestPoint = series.reduce((min, p) => (p.balance < min.balance ? p : min), series[0]);

  return {
    startBalance,
    avgIncome,
    avgExpense,
    series,
    events,
    lowestPoint,
    goesNegative: lowestPoint.balance < 0,
  };
}

// Budget vs actual for a given month (YYYY-MM)
function budgetSummary(db, userId, month) {
  const budgets = db.prepare('SELECT b.*, c.name category_name, c.group_name FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.month = ? AND b.user_id = ?').all(month, userId);
  return budgets.map(b => {
    const spent = db.prepare(`
      SELECT COALESCE(SUM(amount),0) s FROM transactions
      WHERE category_id = ? AND strftime('%Y-%m', date) = ? AND user_id = ?
    `).get(b.category_id, month, userId).s;
    return {
      category: b.category_name,
      group: b.group_name,
      budgeted: b.amount,
      spent: Math.abs(Math.min(spent, 0)),
      remaining: b.amount - Math.abs(Math.min(spent, 0)),
    };
  });
}

module.exports = { currentNetWorth, netWorthBreakdown, averageMonthlyFlow, projectCashflow, budgetSummary };
