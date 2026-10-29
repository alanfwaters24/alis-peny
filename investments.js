// investments.js — tracks a portfolio of holdings (stocks, shares, funds,
// ETFs, bonds, whatever else) that don't fit neatly as a single bank-style
// account. These add into the "Investments" line on the dashboard net
// worth breakdown, alongside any accounts you've marked as type
// "investment" (like a simple lump-sum ISA).

function buildInvestmentsSummary(db, userId) {
  const rows = db.prepare('SELECT * FROM investments WHERE archived = 0 AND user_id = ? ORDER BY created_at').all(userId);

  const investments = rows.map(r => {
    const gainLoss = (r.purchase_value !== null && r.purchase_value !== undefined)
      ? r.current_value - r.purchase_value
      : null;
    const gainLossPercent = (gainLoss !== null && r.purchase_value > 0)
      ? (gainLoss / r.purchase_value) * 100
      : null;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      currentValue: r.current_value,
      purchaseValue: r.purchase_value,
      units: r.units,
      growthRatePercent: r.growth_rate_percent,
      gainLoss,
      gainLossPercent,
      notes: r.notes,
    };
  });

  const totalValue = investments.reduce((s, i) => s + i.currentValue, 0);
  const totalPurchaseValue = investments.reduce((s, i) => s + (i.purchaseValue || 0), 0);
  const trackedForGainLoss = investments.filter(i => i.gainLoss !== null);
  const totalGainLoss = trackedForGainLoss.length
    ? trackedForGainLoss.reduce((s, i) => s + i.gainLoss, 0)
    : null;

  return { investments, totalValue, totalGainLoss, totalPurchaseValue };
}

module.exports = { buildInvestmentsSummary };
