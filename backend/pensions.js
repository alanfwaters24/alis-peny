// pensions.js — combines multiple pension pots into one picture: what
// they're worth now, what they're likely to be worth at retirement given
// some assumptions, and roughly what that might mean as a monthly income.
// Every person has their own pensions and their own retirement settings.
//
// IMPORTANT: this is a simple, transparent estimate, not financial advice.
// It uses standard compound-growth maths on the numbers and assumptions
// you provide — it can't know about tax, fees, market conditions, or your
// specific pension rules. Always treat the output as a rough guide.

function getSetting(db, userId, key, fallback) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? row.value : fallback;
}
function setSetting(db, userId, key, value) {
  db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, String(value));
}

function getRetirementSettings(db, userId) {
  return {
    dateOfBirth: getSetting(db, userId, 'date_of_birth', null),
    withdrawalRatePercent: parseFloat(getSetting(db, userId, 'withdrawal_rate_percent', '4')),
    statePensionMonthly: parseFloat(getSetting(db, userId, 'state_pension_monthly', '0')),
  };
}

function saveRetirementSettings(db, userId, { dateOfBirth, withdrawalRatePercent, statePensionMonthly }) {
  if (dateOfBirth !== undefined) setSetting(db, userId, 'date_of_birth', dateOfBirth);
  if (withdrawalRatePercent !== undefined) setSetting(db, userId, 'withdrawal_rate_percent', withdrawalRatePercent);
  if (statePensionMonthly !== undefined) setSetting(db, userId, 'state_pension_monthly', statePensionMonthly);
}

function ageNow(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const hadBirthdayThisYear = (now.getMonth() > dob.getMonth()) || (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
  if (!hadBirthdayThisYear) age--;
  return age;
}

// Future value of a pot with a lump sum plus regular monthly contributions,
// compounded monthly at the given annual growth rate, over `months` months.
function projectPot(currentValue, monthlyContribution, annualGrowthPercent, months) {
  const r = (annualGrowthPercent / 100) / 12; // monthly rate
  if (months <= 0) return currentValue;
  const fvLumpSum = currentValue * Math.pow(1 + r, months);
  const fvContributions = r === 0
    ? monthlyContribution * months
    : monthlyContribution * ((Math.pow(1 + r, months) - 1) / r);
  return fvLumpSum + fvContributions;
}

function monthsUntil(dateOfBirth, retirementAge) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  const retirementDate = new Date(dob.getFullYear() + retirementAge, dob.getMonth(), dob.getDate());
  const now = new Date();
  const months = (retirementDate.getFullYear() - now.getFullYear()) * 12 + (retirementDate.getMonth() - now.getMonth());
  return Math.max(0, months);
}

function buildPensionSummary(db, userId) {
  const pensions = db.prepare('SELECT * FROM pensions WHERE archived = 0 AND user_id = ? ORDER BY created_at').all(userId);
  const settings = getRetirementSettings(db, userId);
  const currentAge = ageNow(settings.dateOfBirth);

  const perPension = pensions.map(p => {
    const months = monthsUntil(settings.dateOfBirth, p.retirement_age);
    const monthlyContribution = p.monthly_contribution_personal + p.monthly_contribution_employer;
    const projectedValue = months === null
      ? null // can't project without a date of birth
      : projectPot(p.current_value, monthlyContribution, p.growth_rate_percent, months);

    return {
      id: p.id,
      name: p.name,
      currentValue: p.current_value,
      monthlyContribution,
      growthRatePercent: p.growth_rate_percent,
      retirementAge: p.retirement_age,
      monthsToRetirement: months,
      projectedValue,
      notes: p.notes,
    };
  });

  const totalCurrentValue = perPension.reduce((s, p) => s + p.currentValue, 0);
  const totalMonthlyContribution = perPension.reduce((s, p) => s + p.monthlyContribution, 0);
  const projectable = perPension.filter(p => p.projectedValue !== null);
  const totalProjectedValue = projectable.length ? projectable.reduce((s, p) => s + p.projectedValue, 0) : null;

  // Estimated monthly income at retirement, using a withdrawal-rate rule
  // (a common rough guide — e.g. 4% per year of the pot) plus any state
  // pension entered. This is a simple estimate, not a promise or advice.
  const estimatedMonthlyIncome = totalProjectedValue !== null
    ? (totalProjectedValue * (settings.withdrawalRatePercent / 100) / 12) + settings.statePensionMonthly
    : null;

  return {
    pensions: perPension,
    totalCurrentValue,
    totalMonthlyContribution,
    totalProjectedValue,
    estimatedMonthlyIncome,
    settings: { ...settings, currentAge },
    hasDateOfBirth: !!settings.dateOfBirth,
  };
}

module.exports = {
  getRetirementSettings, saveRetirementSettings, buildPensionSummary,
  projectPot, monthsUntil, ageNow,
};
