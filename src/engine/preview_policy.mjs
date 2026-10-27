// Only the exact medium-risk labels already observed in Binance previews may
// proceed within an explicitly authorized trade workflow. Unknown risks remain blocked.
export function previewRiskState(details) {
  if (!details?.requestId || details.simulationCode !== '000000000' ||
      details.simulationErrorDetail || details.authorityChangeCount !== 0 ||
      !Array.isArray(details.riskDetails) || !Array.isArray(details.addressRisks) ||
      !Array.isArray(details.riskBehaviors) || details.riskBehaviors.length)
    return 'blocked';
  let medium = false;
  for (const risk of details.riskDetails) {
    if (risk?.code !== 'medium_risk_transaction') return 'blocked';
    medium = true;
  }
  for (const address of details.addressRisks) {
    if (typeof address?.riskLevel === 'number' && address.riskLevel > 3)
      return 'blocked';
    if (!Array.isArray(address?.riskDetails)) return 'blocked';
    for (const risk of address.riskDetails) {
      if (risk?.code !== 'medium_risk' || risk.riskType !== 'CAUTION')
        return 'blocked';
      medium = true;
    }
  }
  return medium ? 'medium' : 'clean';
}
