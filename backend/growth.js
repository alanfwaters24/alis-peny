// growth.js — projects pensions and investments forward year by year so
// they can be charted together on the Plan screen. Same maths as the
// individual pension projections, just sampled annually instead of only
// at the retirement date.
//
// Pensions stop growing/contributing in this projection once they reach
// their own retirement age (you'd typically start drawing from them then).
// Investments have no "retirement age" — they're projected to keep
// compounding for the whole chart horizon at their assumed growth rate.
//
// This is a projection based on the assumptions entered, not a forecast
// of what will actually happen — markets, fees, and contributions all
// change over time in reality.

const { projectPot, monthsUntil, getRetirementSettings } = require('./pensions');

function buildGrowthProjection(db, userId, horizonYearsOverride) {
  const settings = getRetirementSettings(db, userId);
  const pensionRows = db.prepare('SELECT * FROM pensions WHERE archived = 0 AND user_id = ?').all(userId);
  const investmentRows = db.prepare('SELECT * FROM investments WHERE archived = 0 AND user_id = ?').all(userId);

  if (!settings.dateOfBirth || (pensionRows.length === 0 && investmentRows.length === 0)) {
    return { available: false, series: [], horizonYears: 0 };
  }

  const pensionsWithMonths = pensionRows.map(p => ({
    ...p,
    monthlyContribution: p.monthly_contribution_personal + p.monthly_contribution_employer,
    monthsToRetirement: monthsUntil(settings.dateOfBirth, p.retirement_age),
  }));

  const longestPensionHorizonYears = pensionsWithMonths.length
    ? Math.max(...pensionsWithMonths.map(p => Math.ceil(p.monthsToRetirement / 12)))
    : 0;

  // Investments don't have a natural end point, so default to matching the
  // pension horizon (or a sensible 20 years if there are no pensions at all).
  const horizonYears = horizonYearsOverride || Math.max(longestPensionHorizonYears, investmentRows.length ? 20 : 0, 1);

  const series = [];
  for (let year = 0; year <= horizonYears; year++) {
    const months = year * 12;

    const pensionsTotal = pensionsWithMonths.reduce((sum, p) => {
      const cappedMonths = Math.min(months, p.monthsToRetirement);
      return sum + projectPot(p.current_value, p.monthlyContribution, p.growth_rate_percent, cappedMonths);
    }, 0);

    const investmentsTotal = investmentRows.reduce((sum, i) => {
      return sum + projectPot(i.current_value, 0, i.growth_rate_percent || 0, months);
    }, 0);

    series.push({
      year,
      calendarYear: new Date().getFullYear() + year,
      pensionsTotal: Math.round(pensionsTotal * 100) / 100,
      investmentsTotal: Math.round(investmentsTotal * 100) / 100,
      combinedTotal: Math.round((pensionsTotal + investmentsTotal) * 100) / 100,
    });
  }

  return {
    available: true,
    series,
    horizonYears,
    hasPensions: pensionRows.length > 0,
    hasInvestments: investmentRows.length > 0,
  };
}

module.exports = { buildGrowthProjection };
