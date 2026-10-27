(function(){
  const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const fmt=n=>n===null||n===undefined?'未知':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:6});
  const signed=n=>n===null||n===undefined?'未知':`${Number(n)>0?'+':''}${fmt(n)}`;
  function render(root,{data,onTrade,renderActions}){
    root.replaceChildren();if(data.error){root.append(make('p',data.error,'hint'));return;}
    const positions=data.positions||[],groups=new Map();let valued=0;
    for(const p of positions){if(p.valueUsd!==null&&p.valueUsd!==undefined)valued+=Number(p.valueUsd)||0;
      if(!p.basisComplete)continue;const k=p.quoteAsset,g=groups.get(k)||{symbol:p.quoteSymbol||'底池币',realized:0,unrealized:0,known:0};
      if(p.realized!==null)g.realized+=Number(p.realized)||0;if(p.unrealized!==null)g.unrealized+=Number(p.unrealized)||0;g.known++;groups.set(k,g);}
    const totals=make('div',undefined,'portfolio-totals');totals.append(make('div',`钱包资产约 $${fmt(valued)}`));
    for(const g of groups.values())totals.append(make('div',`${g.symbol} · 已实现 ${signed(g.realized)} · 未实现 ${signed(g.unrealized)}`));root.append(totals);
    root.append(make('p',data.notice||'未知成本不会计作盈利。','hint'));
    root.append(make('p',data.source||'','hint'));
    const list=make('div',undefined,'portfolio-list');root.append(list);
    const rows=[...positions].sort((a,b)=>Number(b.balance>0)-Number(a.balance>0)||(b.valueUsd||0)-(a.valueUsd||0));
    for(const p of rows){const card=make('article',undefined,'asset-card'),head=make('div',undefined,'asset-heading');
      const title=make('div');title.append(make('strong',p.symbol||p.token.slice(0,8)),make('small',` ${p.phase==='graduated'?'外盘':p.phase==='curve'?'内盘':p.phase==='standard_curve'?'发行后曲线':''}${p.unit==='shares'?' · 份额':''}`));
      head.append(title,make('span',`${fmt(p.balance)} ${p.unit==='shares'?'份额':'枚'}`));card.append(head);
      card.append(make('small',p.token,'asset-address'));
      const grid=make('div',undefined,'position-grid'),unit=p.quoteSymbol||'底池币';
      for(const [label,value] of [['剩余成本',p.cost===null?'未知':`${fmt(p.cost)} ${unit}`],['当前可卖估值',p.value===null||p.value===undefined?'暂无报价':`${fmt(p.value)} ${unit}`],
        ['已实现盈亏',p.realized===null?'未知':`${signed(p.realized)} ${unit}`],['未实现盈亏',p.unrealized===null?'未知':`${signed(p.unrealized)} ${unit}`],
        ['估值／成本',p.multiple===null||p.multiple===undefined?'未知':`${Number(p.multiple).toFixed(3)}×`],['累计 Gas',p.gasBNB?`${fmt(p.gasBNB)} BNB`:'—']]){
        const cell=make('div');cell.append(make('small',label),make('strong',value));grid.append(cell);}
      card.append(grid);
      if(p.basisNote||p.valuationError)card.append(make('p',[p.basisNote,p.valuationError].filter(Boolean).join(' · '),'hint'));
      const actions=make('div',undefined,'position-actions');
      const cash=['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c','0x0000000000000000000000000000000000000000'].includes(p.token.toLowerCase());
      if(onTrade&&!cash&&Number(p.balance)>0){const b=make('button','打开买卖','secondary');b.addEventListener('click',()=>onTrade(p));actions.append(b);}
      if(renderActions&&!cash)renderActions(actions,p);card.append(actions);
      if(p.trades?.length){const details=make('details'),summary=make('summary',`成交记录 · ${p.trades.length} 笔`);details.append(summary);
        for(const t of p.trades.slice(0,30)){const line=make('div',undefined,'position-trade');
          line.append(make('span',`${new Date(t.atUtc).toLocaleString()} · ${{buy:'买入',sell:'卖出',convert:'领取',transfer:'转出'}[t.action]||t.action}`));
          if(t.quantityRaw){const n=Number(t.quantityRaw)/10**(t.tokenDecimals||18),q=Number(t.quoteRaw||0)/10**(t.quoteDecimals||18);
            line.append(make('span',`${fmt(n)} ${t.unit==='shares'?'份额':'枚'}${q?' · '+fmt(q)+' '+unit:''}`));}
          if(/^0x[0-9a-f]{64}$/i.test(t.txHash||'')){const a=make('a','链上回执 ↗');a.href=`https://bscscan.com/tx/${t.txHash}`;a.target='_blank';a.rel='noopener noreferrer';line.append(a);}details.append(line);}
        card.append(details);}
      list.append(card);
    }
    if(!rows.length)list.append(make('p','暂无资产或已记录成交','hint'));
  }
  window.AgentPortfolio={render};
})();
