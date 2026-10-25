export const isAddress = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');

export function makeIntent({ action, token, budgetBNB, percent }) {
  if (!['buy', 'sell'].includes(action)) throw new Error('无效操作');
  if (!isAddress(token)) throw new Error('请输入完整合约地址');
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100 ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(percent))) throw new Error('比例应为 0–100%，最多两位小数');
  if (action === 'buy') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(String(budgetBNB)) ||
        Number(budgetBNB) <= 0) throw new Error('请输入有效 BNB 预算');
  }
  return Object.freeze({ action, token, percent: pct,
    ...(action === 'buy' ? { budgetBNB: String(budgetBNB) } : {}),
    status: 'demo_only' });
}
