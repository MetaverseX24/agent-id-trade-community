const $ = id => document.getElementById(id);
let detected = null;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

async function post(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '请求失败');
  return result;
}

async function inspect() {
  const token = $('token').value.trim();
  if (!addressPattern.test(token)) throw Error('请输入完整的 0x 地址');
  detected = null;
  $('identified').className = 'identified';
  $('identified').textContent = '正在只读查询 BSC…';
  const result = await post('/api/inspect', { token });
  if ($('token').value.trim().toLowerCase() !== token.toLowerCase()) return;
  detected = result.platform ? result : null;
  $('identified').className = `identified ${result.platform ? 'good' : 'bad'}`;
  $('identified').textContent = result.platform ?
    `${result.platform} · ${result.phase} · 报价资产 ${result.quote} · ${result.token}` :
    result.phase;
}

async function preview(action, percent) {
  try {
    if (!detected) await inspect();
    if (!detected) throw Error('未识别到支持的平台登记');
    const intent = await post('/api/intent', {
      action, token: detected.token, percent,
      ...(action === 'buy' ? { budgetBNB: $('bnb').value.trim() } : {}),
    });
    $('message').textContent = '已生成演示意图；没有发起交易';
    $('preview').textContent = JSON.stringify({ platform: detected.platform,
      phase: detected.phase, quote: detected.quote, ...intent }, null, 2);
  } catch (error) { $('message').textContent = error.message; }
}

$('inspect').addEventListener('click', () => inspect().catch(error => {
  $('identified').className = 'identified bad';
  $('identified').textContent = error.message;
}));
$('token').addEventListener('input', () => {
  detected = null;
  $('identified').className = 'identified';
  $('identified').textContent = '地址已改变，请重新识别';
  $('preview').textContent = '';
});
for (const button of document.querySelectorAll('[data-buy]'))
  button.addEventListener('click', () => preview('buy', button.dataset.buy));
for (const button of document.querySelectorAll('[data-sell]'))
  button.addEventListener('click', () => preview('sell', button.dataset.sell));
$('buyCustom').addEventListener('click', () => preview('buy', $('buyPercent').value.trim()));
$('sellCustom').addEventListener('click', () => preview('sell', $('sellPercent').value.trim()));
