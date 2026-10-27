const $=id=>document.getElementById(id),CA=/^0x[0-9a-fA-F]{40}$/;
const selected=new Set(['primary']);let wallets=[],tokens=[],orders=[],config={maxBuyBNB:'0.3',liveTrading:false},info=null;
let view='terminal',side='buy',busy=false,detailBusy=false,detailToken=null,loadedSettings=false;
let pairingWalletId=null;
const csrf=document.querySelector('meta[name="agent-csrf"]').content;
const short=a=>a?`${a.slice(0,7)}…${a.slice(-5)}`:'—';
const number=n=>Number(n||0).toLocaleString('zh-CN',{maximumFractionDigits:5});
const price=n=>Number(n)>0?Number(n).toPrecision(5):'—';
const phase=p=>({curve:'内盘',standard_curve:'发行后曲线',graduated:'外盘',launching:'发行中'})[p]||p;
function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function notice(text){$('notice').textContent=text;}
async function api(path,data){const response=await fetch(path,{cache:'no-store',...(data!==undefined?{method:'POST',
  headers:{'Content-Type':'application/json','X-Agent-CSRF':csrf},body:JSON.stringify(data)}:{})});
  const result=await response.json();if(!response.ok)throw Error(result.error||`请求失败 ${response.status}`);return result;}
function changeView(name){view=name;for(const e of document.querySelectorAll('.view'))e.hidden=e.id!==`view-${name}`;
  for(const e of document.querySelectorAll('[data-view]'))e.classList.toggle('active',e.dataset.view===name);
  $('pageTitle').textContent={terminal:'交易终端',holdings:'我的持仓',orders:'订单与耗时',settings:'钱包与设置'}[name];
  if(name==='holdings')refreshHoldings();if(name==='orders')refreshStatistics();}
for(const e of document.querySelectorAll('[data-view]'))e.addEventListener('click',()=>changeView(e.dataset.view));
function summary(){const count=selected.size;
  $('selectionSummary').textContent=`已选 ${count} 个钱包。目标比例模式：每钱包最多 ${config.maxBuyBNB} BNB，合计最多 ${number(count*Number(config.maxBuyBNB))} BNB，另留 Gas。`;
  $('ticketSummary').textContent=`${count} 个钱包分别买入/卖出；各钱包独立执行、分别显示结果。`;
  $('modeBadge').textContent=config.liveTrading?'真实交易':'仅报价';$('modeBadge').className=config.liveTrading?'live':'';
  $('rpcBadge').textContent=config.rpcLabel||'公共 RPC';}
const walletMessage={wallet_duplicate_address:'重复地址，请连接不同钱包',wallet_identity_mismatch:'账号与预期地址不符',developer_mode_unavailable:'请检查开发者模式/限额',
  wallet_session_expired:'登录已过期',agent_id_required:'请领取 Agent ID',trade_all_tokens_disabled:'请开启交易所有代币',
  wallet_app_confirmation_pending:'等待 App 确认',wallet_status_unavailable:'节点暂不可用'};
function renderWallets(){const root=$('wallets');root.replaceChildren();
  for(const wallet of wallets){const row=element('div',undefined,`wallet-item ${wallet.ready?'ready':''}`),label=element('label');
    const check=element('input');check.type='checkbox';check.checked=selected.has(wallet.id);check.addEventListener('change',()=>{check.checked?selected.add(wallet.id):selected.delete(wallet.id);summary();});
    const text=element('span',wallet.label+(wallet.agentId?` · ${wallet.agentId}`:''));
    const status=wallet.ready?'已连接':walletMessage[wallet.error]||wallet.status||'未连接';
    text.append(element('small',`${status}${wallet.address?' · '+wallet.address:''}`));label.append(check,text);row.append(label);
    if(wallet.status!=='CONNECTED'){const login=element('button','扫码连接');login.addEventListener('click',async()=>{
      login.disabled=true;notice(`正在生成 ${wallet.label} 的二维码…`);try{const pair=await api('/api/wallet/login',{walletId:wallet.id});if(pair.url){pairingWalletId=wallet.id;$('loginLabel').textContent=wallet.label;
        $('loginCode').textContent=pair.code;$('loginLink').href=pair.url;$('loginQR').src=pair.qrDataUrl||'';$('loginQR').hidden=!pair.qrDataUrl;$('loginDialog').showModal();}else await refreshWallets();}
      catch(error){notice(error.message);}finally{login.disabled=false;}});row.append(login);}
    root.append(row);
    if(wallet.id===pairingWalletId&&wallet.status==='CONNECTED'){
      $('loginDialog').close();$('loginQR').removeAttribute('src');pairingWalletId=null;notice(`${wallet.label} 已连接`);
    }
  }summary();
}
async function refreshWallets(){try{wallets=(await api('/api/wallets')).wallets||[];renderWallets();
  if(wallets.some(w=>w.ready)&&$('loginDialog').open)$('loginDialog').close();}catch(error){notice(error.message);}}
$('closeLogin').addEventListener('click',()=>$('loginDialog').close());
function percent(raw,max){if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))throw Error('比例最多两位小数');
  const n=Math.round(Number(raw)*100);if(n<1||n>max)throw Error('比例超出范围');return n;}
function fields(action,mode,bps){const token=$('token').value.trim();if(!CA.test(token))throw Error('请输入完整的 BSC 合约地址');
  if(!selected.size)throw Error('请至少选中一个钱包');
  return {token,action,mode,bps,walletIds:[...selected],budgetBNB:mode==='bnb'?$('buyBNB').value.trim():config.maxBuyBNB,requestId:crypto.randomUUID()};}
async function trade(action,mode,bps){if(busy)return;busy=true;try{const command=fields(action,mode,bps);
  notice(config.liveTrading?'已发送到交易队列，正在核对路径与币安预览…':'正在生成只读报价，不会签名或下单…');
  const result=await api('/api/orders',command);notice(`已建立 ${result.jobs.length} 个独立钱包订单，请查看执行状态。`);await refreshOrders();}
  catch(error){notice(error.message);}finally{busy=false;}}
for(const button of document.querySelectorAll('[data-buy]'))button.addEventListener('click',()=>trade('buy','percent',Number(button.dataset.buy)));
for(const button of document.querySelectorAll('[data-sell]'))button.addEventListener('click',()=>trade('sell',null,Number(button.dataset.sell)));
$('buyCustom').addEventListener('click',()=>{try{trade('buy','percent',percent($('buyPercent').value.trim(),200));}catch(e){notice(e.message);}});
$('sellCustom').addEventListener('click',()=>{try{trade('sell',null,percent($('sellPercent').value.trim(),10000));}catch(e){notice(e.message);}});
$('buyByBNB').addEventListener('click',()=>trade('buy','bnb',null));
function setSide(next){side=next;$('buyControls').hidden=next!=='buy';$('sellControls').hidden=next!=='sell';$('buyTab').classList.toggle('active',next==='buy');$('sellTab').classList.toggle('active',next==='sell');}
$('buyTab').addEventListener('click',()=>setSide('buy'));$('sellTab').addEventListener('click',()=>setSide('sell'));
$('quote').addEventListener('click',async()=>{try{const bps=side==='buy'?percent($('buyPercent').value.trim()||'1',200):percent($('sellPercent').value.trim()||'100',10000);
  const q=await api('/api/quote',fields(side,side==='buy'?'percent':null,bps));
  $('quoteResult').textContent=`${q.action==='buy'?'预计买到 '+q.expectedTokens:'预计卖出 '+q.tokensToSell} · 报价币金额 ${q.quoteAmount} · BNB 等值约 ${q.nativeValueBNB}。仅报价，成交以实际回执为准。`;
}catch(error){notice(error.message);}});
async function inspect(){const token=$('token').value.trim();if(!CA.test(token))throw Error('请输入完整合约地址');
  info=await api('/api/inspect',{token});$('identified').textContent=`${info.label} · ${phase(info.phase)} · ${info.token} · 底池 ${info.quote}${info.canTrade?'':' · 当前路径未验证'}`;
  detailToken=info.token;$('selectedName').textContent=info.symbol||short(info.token);refreshDetail();}
$('inspect').addEventListener('click',()=>inspect().catch(e=>notice(e.message)));
$('token').addEventListener('input',()=>{info=null;$('identified').textContent='地址已变更，交易提交时会重新核对平台和阶段。';});
function renderMarkets(){const platform=$('platformFilter').value,p=$('phaseFilter').value,q=$('quoteFilter').value,search=$('marketSearch').value.trim().toLowerCase();
  const list=tokens.filter(t=>(platform==='all'||t.platform===platform)&&(p==='all'||(p==='curve'?['curve','standard_curve'].includes(t.phase):t.phase===p))&&
    (q==='all'||(q==='bnb'?t.quote==='BNB':t.quote!=='BNB'))&&(!search||`${t.symbol} ${t.name} ${t.token}`.toLowerCase().includes(search)));
  $('marketCount').textContent=`${list.length} 个`;
  const root=$('marketRows'),scroll=root.scrollTop;root.replaceChildren();
  for(const row of list.slice(0,120)){const button=element('button',undefined,`market-row ${detailToken?.toLowerCase()===row.token.toLowerCase()?'selected':''}`);
    const badge=element('span',`${row.platform} · ${phase(row.phase)}`,'badge');button.append(badge,element('strong',`${row.symbol||'?'} · ${row.name||''}`));
    const time=row.createdAt>1_600_000_000_000?new Date(row.createdAt).toLocaleTimeString('zh-CN'):'时间待核实';
    button.append(element('small',`${row.quote} · ${time} · ${short(row.token)}`));button.addEventListener('click',()=>{
      $('token').value=row.token;detailToken=row.token;info=null;$('selectedName').textContent=row.symbol||row.name||short(row.token);
      $('chartMeta').textContent=`${row.platform} · ${phase(row.phase)} · ${row.quote} · ${row.token}`;
      refreshDetail();renderMarkets();});root.append(button);}
  if(!list.length)root.append(element('p','当前筛选没有可显示的新盘','hint'));root.scrollTop=scroll;
}
async function refreshMarkets(){try{const data=await api('/api/market');tokens=data.tokens||[];renderMarkets();const failed=Object.entries(data.sources||{}).filter(([,v])=>v&&!v.ok).map(([k])=>k);
  $('marketSource').textContent=failed.length?`部分数据源不可用：${failed.join('、')}，列表可能不完整。`:'来源：链上登记及平台公开接口；交易前会重新核对。';}catch(error){$('marketSource').textContent=error.message;}}
for(const id of ['marketSearch','platformFilter','phaseFilter','quoteFilter'])$(id).addEventListener(id==='marketSearch'?'input':'change',renderMarkets);
function svg(name,attrs){const node=document.createElementNS('http://www.w3.org/2000/svg',name);for(const[k,v]of Object.entries(attrs))node.setAttribute(k,String(v));$('chart').append(node);return node;}
function chart(rows){$('chart').replaceChildren();const candles=rows.slice(-150).filter(x=>x.low>0&&x.high>0);$('chartEmpty').hidden=!!candles.length;if(!candles.length)return;
  const hi=Math.max(...candles.map(x=>x.high)),lo=Math.min(...candles.map(x=>x.low)),span=Math.max(hi-lo,hi*.01),start=candles[0].time,end=Math.max(start+60000,candles.at(-1).time);
  const y=v=>255-(v-lo)/span*210,x=t=>35+(t-start)/(end-start)*730,width=Math.min(14,Math.max(2,730/(candles.length*1.5)));
  for(let i=0;i<4;i++)svg('line',{x1:30,y1:45+i*70,x2:785,y2:45+i*70,class:'chart-grid'});
  for(const c of candles){const cls=c.close>=c.open?'candle-up':'candle-down';svg('line',{x1:x(c.time),y1:y(c.high),x2:x(c.time),y2:y(c.low),class:cls});
    svg('rect',{x:x(c.time)-width/2,y:Math.min(y(c.open),y(c.close)),width,height:Math.max(1,Math.abs(y(c.open)-y(c.close))),class:cls});}
  svg('text',{x:32,y:24,class:'chart-label'}).textContent=`高 ${price(hi)} · 低 ${price(lo)}`;
  svg('text',{x:785,y:24,'text-anchor':'end',class:'chart-label'}).textContent=`最新 ${price(candles.at(-1).close)}`;
  svg('text',{x:32,y:286,class:'chart-label'}).textContent=new Date(start).toLocaleTimeString();
  svg('text',{x:785,y:286,'text-anchor':'end',class:'chart-label'}).textContent=new Date(end).toLocaleTimeString();
}
async function refreshDetail(){if(!detailToken||detailBusy)return;detailBusy=true;const token=detailToken;try{const data=await api(`/api/detail?token=${token}`);if(token!==detailToken)return;
  chart(data.candles||[]);$('chartSource').textContent=`${data.chartSource} · 价格单位 ${data.chartSource?.includes('USD')?'USD':data.quote}`;
  const root=$('trades');root.replaceChildren();$('tradeCount').textContent=`最近 ${data.trades?.length||0} 笔`;
  for(const tr of data.trades||[]){const row=element('div',undefined,'trade-row');row.append(element('span',new Date(tr.ts).toLocaleTimeString()),element('span',tr.side==='buy'?'买入':'卖出',tr.side==='buy'?'positive':'negative'),element('span',number(tr.tokens)),element('span',price(tr.price)));
    if(/^0x[0-9a-f]{64}$/i.test(tr.tx||'')){const a=element('a','↗');a.href=`https://bscscan.com/tx/${tr.tx}`;a.target='_blank';a.rel='noopener noreferrer';row.append(a);}root.append(row);}
}catch(error){$('chartSource').textContent=`行情暂不可用：${error.message}`;}finally{detailBusy=false;if(token!==detailToken)refreshDetail();}}
function eventText(e){if(e.stage==='error')return `未完成：${e.error}${e.failedAfter?' · 停在 '+e.failedAfter:''}`;
  if(e.stage==='native_conversion_confirmed')return `本单底池币已换回 ${e.receivedBNB} BNB`;
  if(e.stage==='native_settlement_complete')return '本单所得已处理为原生 BNB';
  if(e.stage==='buy_surplus_returning_to_bnb')return '买入已成交，正在将本单新换而未使用的底池币换回 BNB';
  if(e.stage==='quote_refreshed')return '已按最新价格重新计算买入金额';
  if(e.stage==='native_conversion_failed')return '代币已成交，换回 BNB 失败，底池币仍在钱包';
  if(['native_conversion_pending','native_conversion_submission_unknown','native_conversion_partial_fill'].includes(e.stage))return '代币已成交，换回 BNB 尚未全部确认，请勿重复下单';
  if(e.stage==='workflow_step_approved')return `按本次授权继续执行 ${e.step}${e.requireConfirmation?' · 等待 App 验证':''}`;
  if(e.stage==='quote')return `报价：${e.expectedTokens?'预计 '+e.expectedTokens+' 代币':e.tokensToSell?'卖出 '+e.tokensToSell:'已计算'}${e.nativeValueBNB?' · BNB 等值 '+e.nativeValueBNB:''}`;
  if(e.stage?.endsWith('preview'))return `币安预览 · 模拟 ${e.simulationCode||'未知'} · 手机验证 ${e.requireConfirmation?'需要':'不需要'}`;
  if(e.stage?.includes('app_confirmation'))return '等待币安 App 确认';if(e.stage==='receipt_unresolved')return '结果尚未查明，请核对链上记录，勿重复下单';
  return {confirmed:'链上已成交',quoted_only:'仅报价，没有下单',approval_sent:'预览已确认，正在提交'}[e.stage]||e.stage;}
function renderOrders(){const root=$('orders'),approvals=$('approvals');root.replaceChildren();approvals.replaceChildren();approvals.hidden=true;
  for(const order of orders){const box=element('div',undefined,'order');box.append(element('strong',`${order.walletLabel||'钱包'} · ${order.action==='buy'?'买入':'卖出'} · ${short(order.token)}`),element('small',` · ${new Date(order.createdUtc).toLocaleString()} · ${order.stage}`));
    const detail=element('details'),sum=element('summary',`执行详情 · ${order.id}`);detail.append(sum);
    for(const e of order.events||[]){detail.append(element('div',`${eventText(e)}${e.elapsedMs!==undefined?' · '+(e.elapsedMs/1000).toFixed(2)+'秒':''}`,'event'));
      if(/^0x[0-9a-f]{64}$/i.test(e.txHash||'')){const link=element('a','查看链上交易 ↗');link.href=`https://bscscan.com/tx/${e.txHash}`;link.target='_blank';link.rel='noopener noreferrer';detail.append(link);}}
    box.append(element('p',eventText(order.events?.at(-1)||{stage:order.stage}),'event'),detail);root.append(box);
    if(order.awaitingApproval){approvals.hidden=false;const card=element('div',undefined,'order');card.append(element('h3',`${order.walletLabel} · 请确认这一步交易`));
      const preview=[...(order.events||[])].reverse().find(e=>e.stage?.endsWith('preview'));
      card.append(element('pre',JSON.stringify({token:order.token,to:preview?.to,valueWei:preview?.valueWei,
        parsed:preview?.parsedTx,simulation:preview?.simulationCode,risks:preview?.risks,addressRisks:preview?.addressRisks,authorityChanges:preview?.authorityChangeCount},null,2)));
      const approve=element('button','我已核对预览，确认提交这一步');approve.addEventListener('click',async()=>{approve.disabled=true;
        try{await api('/api/approve',{jobId:order.id});notice('已确认提交。如币安 App 弹出确认，请在手机处理。');await refreshOrders();}catch(e){notice(e.message);approve.disabled=false;}});card.append(approve);approvals.append(card);}
  }if(!orders.length)root.append(element('p','暂无订单','hint'));
}
async function refreshOrders(){try{orders=(await api('/api/orders')).jobs||[];renderOrders();}catch(error){notice(error.message);}}
$('refreshOrders').addEventListener('click',()=>{refreshOrders();refreshStatistics();});
async function refreshStatistics(){try{const data=await api('/api/statistics');$('statistics').textContent=`累计 ${data.total} 单 · 已确认 ${data.confirmed} · 失败 ${data.failed}`;}catch{}}
async function refreshHoldings(){const root=$('holdings');root.replaceChildren();
  for(const wallet of wallets){const section=element('section');section.append(element('h3',wallet.label));root.append(section);
    try{const data=await api(`/api/holdings?walletId=${encodeURIComponent(wallet.id)}`);if(data.error)section.append(element('p',data.error,'hint'));
      for(const item of data.items||[]){const row=element('div',undefined,'balance-row');row.append(element('strong',item.symbol),element('span',item.token||'原生币'),element('span',number(item.balance)));
        if(CA.test(item.token||'')){const button=element('button','交易','secondary');button.addEventListener('click',()=>{selected.clear();selected.add(wallet.id);renderWallets();summary();$('token').value=item.token;changeView('terminal');inspect().catch(e=>notice(e.message));});row.append(button);}section.append(row);}
    }catch(error){section.append(element('p',error.message,'hint'));}}
}
$('refreshHoldings').addEventListener('click',refreshHoldings);
function renderSettings(){summary();if(loadedSettings)return;loadedSettings=true;$('maxBuy').value=config.maxBuyBNB;$('gasReserve').value=config.gasReserveBNB;
  $('slippage').value=String(config.slippageBps/100);$('liveTrading').checked=config.liveTrading;$('rpcStatus').textContent=config.rpcConfigured?'已配置私有 RPC；地址和密钥不会返回浏览器。':'使用公共 RPC。';}
$('saveTrading').addEventListener('click',async()=>{try{config=await api('/api/settings',{maxBuyBNB:$('maxBuy').value.trim(),gasReserveBNB:$('gasReserve').value.trim(),slippageBps:percent($('slippage').value.trim(),5000)});notice('交易设置已保存');summary();}catch(e){notice(e.message);}});
$('saveLive').addEventListener('click',async()=>{try{config=await api('/api/settings',{liveTrading:$('liveTrading').checked,confirmation:$('livePhrase').value.trim()});$('livePhrase').value='';summary();notice(config.liveTrading?'真实交易已开启；提交后仍须核对币安预览。':'已切换为仅报价模式');}catch(e){notice(e.message);}});
$('saveRpc').addEventListener('click',async()=>{try{config=await api('/api/settings',{rpcHttp:$('rpcHttp').value.trim(),rpcWs:$('rpcWs').value.trim()});$('rpcHttp').value='';$('rpcWs').value='';$('rpcStatus').textContent=config.rpcConfigured?'私有 RPC 已保存到本机。':'已使用公共 RPC。';summary();}catch(e){notice(e.message);}});
$('addWallet').addEventListener('click',async()=>{try{await api('/api/wallets',{id:$('peerId').value.trim(),label:$('peerLabel').value.trim(),endpoint:$('peerEndpoint').value.trim(),address:$('peerAddress').value.trim()||null,token:$('peerToken').value.trim()});$('peerToken').value='';notice('钱包节点已添加，请扫码连接');refreshWallets();}catch(e){notice(e.message);}});
async function start(){try{const data=await api('/api/state');config=data.settings;wallets=data.wallets||[];tokens=data.market?.tokens||[];orders=data.orders||[];
  renderSettings();renderWallets();renderMarkets();renderOrders();}catch(error){notice(error.message);}}
start();const events=new EventSource('/api/events');events.onmessage=e=>{try{const data=JSON.parse(e.data);if(data.type==='orders'){orders=data.orders;renderOrders();}}catch{}};
setInterval(refreshMarkets,5000);setInterval(refreshWallets,10000);setInterval(refreshOrders,3000);setInterval(refreshDetail,10000);
