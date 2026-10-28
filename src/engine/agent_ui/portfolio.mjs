import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {Contract,Interface,ZeroAddress,formatUnits,getAddress} from 'ethers';
import {ABI,WBNB,BNB,FOUR_CORE,FLAP} from './platforms.mjs';
import {netReceived} from './sale_settlement.mjs';
import {GANG,GANG_ROUTER_IFACE} from './gang_protocol.mjs';
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const norm=a=>!a||same(a,ZeroAddress)||same(a,BNB)||same(a,WBNB)?WBNB:getAddress(a);
const four=new Interface(['event TradeExecuted(address indexed token,address indexed trader,uint256 indexed presetId,bool isBuy,address quoteAsset,address vault,uint256 requestedTokenAmount,uint256 tokenAmount,uint256 curveQuoteAmount,uint256 traderQuoteAmount,uint256 lastPrice,uint256 slippageLimit,uint256 protocolFee,uint256 taxFee,uint256 devFee,uint256 antiSniperFee,uint256 totalRaised,uint256 remainingForSale)']);
const router=new Interface(['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)','function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
const withdraw=new Interface(['event Withdrawal(address indexed src,uint256 wad)']);
export function normalizeBalances(data){const list=Array.isArray(data)?data:(data.balances||data.list||[]);
  return list.map(x=>({token:x.address||x.tokenAddress||x.contractAddress,symbol:String(x.symbol||x.tokenSymbol||'').slice(0,32),
    balance:String(x.balance??x.quantity??'0'),priceUsd:Number(x.price??x.priceUsd)||null,
    valueUsd:Number(x.value??x.valueUsd??x.usdValue)||null})).filter(x=>/^0x[0-9a-f]{40}$/i.test(x.token||''));}

export function bookTrades(trades){const books=new Map();
  for(const t of [...trades].sort((a,b)=>a.block-b.block||a.index-b.index)){
    const key=t.token.toLowerCase();let b=books.get(key);if(!b){b={token:t.token,unit:t.unit||'token',quoteAsset:t.quoteAsset,
      tokenDecimals:t.tokenDecimals??18,quoteDecimals:t.quoteDecimals??18,quantity:0n,cost:0n,realized:0n,bought:0n,sold:0n,
      received:0n,gas:0n,trades:[],basisComplete:t.action==='buy'&&t.quality==='verified'};books.set(key,b);}
    const q=BigInt(t.quantityRaw),money=BigInt(t.quoteRaw||0);b.gas+=BigInt(t.gasWei||0);b.trades.push(t);
    if(t.action==='convert'){b.quantity=q;b.unit='token';continue;}
    if(t.action==='transfer'){const released=b.quantity>0n?b.cost*(q<b.quantity?q:b.quantity)/b.quantity:0n;
      b.quantity=b.quantity>q?b.quantity-q:0n;b.cost-=released;continue;}
    if(!same(b.quoteAsset,t.quoteAsset)||t.quality!=='verified')b.basisComplete=false;
    if(t.action==='buy'){b.quantity+=q;b.cost+=money;b.bought+=money;}
    else if(t.action==='sell'){
      const valid=b.quantity>=q&&b.quantity>0n;const released=valid?b.cost*q/b.quantity:0n;
      if(!valid)b.basisComplete=false;
      b.quantity=b.quantity>q?b.quantity-q:0n;b.cost=b.cost>=released?b.cost-released:0n;
      b.realized+=money-released;b.received+=money;b.sold+=q;
    }
  }
  return books;
}
export function pnlForBalance(book,balanceRaw,valueRaw=null){const balance=BigInt(balanceRaw),tracked=book.quantity;
  const complete=book.basisComplete&&balance===tracked;
  const cost=tracked>0n?book.cost*balance/tracked:0n;
  return {basisComplete:complete,costRaw:complete?String(cost):null,
    realizedRaw:book.basisComplete?String(book.realized):null,
    unrealizedRaw:complete&&valueRaw!==null?String(BigInt(valueRaw)-cost):null,
    multiple:complete&&cost>0n&&valueRaw!==null?Number(BigInt(valueRaw)*10000n/cost)/10000:null,
    averageCost:complete&&balance>0n?Number(formatUnits(cost,book.quoteDecimals))/Number(formatUnits(balance,book.tokenDecimals)):null};}

export class Portfolio {
  constructor({file,provider,cli,detect,quote,convert,getJobs}){Object.assign(this,{file,provider,cli,detect,quote,convert,getJobs});
    try{this.records=JSON.parse(readFileSync(file,'utf8'));}catch{this.records=[];}this.cache=new Map();this.pending=new Map();this.meta=new Map();this.syncs=new Map();}
  save(){mkdirSync(dirname(this.file),{recursive:true,mode:0o700});writeFileSync(this.file+'.tmp',JSON.stringify(this.records),{mode:0o600});renameSync(this.file+'.tmp',this.file);}
  async metadata(asset){asset=norm(asset);if(same(asset,WBNB))return {decimals:18,symbol:'BNB'};
    if(!this.meta.has(asset)){const c=new Contract(asset,ABI.ERC20,this.provider);const [decimals,symbol]=await Promise.all([c.decimals(),c.symbol().catch(()=>'底池币')]);this.meta.set(asset,{decimals:Number(decimals),symbol:String(symbol).slice(0,32)});}return this.meta.get(asset);}
  ingest(wallet,jobs){const k=wallet.toLowerCase();if(this.syncs.has(k))return this.syncs.get(k);
    const work=this.ingestOnce(wallet,jobs).finally(()=>this.syncs.delete(k));this.syncs.set(k,work);return work;}
  async ingestOnce(wallet,jobs){let changed=false;
    for(const j of jobs.filter(j=>same(j.walletAddress||wallet,wallet)&&['buy','sell'].includes(j.action))){
      const events=j.events||[],hash=events.find(e=>e.stage===`${j.action}_confirmed`)?.txHash||events.find(e=>e.stage===`${j.action}_broadcast`||e.stage==='broadcast')?.txHash||
        (j.stage==='confirmed'?events.find(e=>e.stage==='confirmed')?.txHash:null);
      if(!/^0x[0-9a-f]{64}$/i.test(hash||'')||this.records.some(t=>same(t.wallet,wallet)&&same(t.txHash,hash)&&t.action===j.action))continue;
      try{const [receipt,tx]=await Promise.all([this.provider.getTransactionReceipt(hash),this.provider.getTransaction(hash)]);
        if(receipt?.status!==1||!same(tx?.from,wallet))continue;
        const fill=events.find(e=>e.stage==='trade_fill'),qevent=events.find(e=>e.stage==='quote');
        let quoteAsset=norm(qevent?.quoteAsset||j.workflowConsent?.quoteAsset||WBNB),quantity=netReceived(receipt,j.token,wallet),money=0n,quality='verified',unit=fill?.unit||'token';
        let trade;
        for(const l of receipt.logs){if(!same(l.address,FOUR_CORE))continue;try{const e=four.parseLog(l);if(e&&same(e.args.token,j.token)&&same(e.args.trader,wallet)){trade=e.args;break;}}catch{}}
        if(trade){quoteAsset=norm(trade.quoteAsset);quantity=BigInt(trade.tokenAmount)*(trade.isBuy?1n:-1n);money=trade.traderQuoteAmount;}
        else{
          const quoteDelta=netReceived(receipt,quoteAsset,wallet);money=j.action==='buy'?-quoteDelta:quoteDelta;
          if(quantity===0n&&fill?.quantityRaw){quantity=BigInt(fill.quantityRaw)*(j.action==='buy'?1n:-1n);unit=fill.unit;}
          if(same(tx.to,GANG.router)){
            let g;try{g=GANG_ROUTER_IFACE.parseTransaction({data:tx.data,value:tx.value});}catch{}
            if(g&&same(g.args[0],j.token)){
              if(j.action==='buy'&&['v3BuyBNB','fairMintBNB','poolBuyBNB'].includes(g.name)){
                quoteAsset=WBNB;money=tx.value-(quoteDelta>0n?quoteDelta:0n);quality='verified';
              }else if(j.action==='sell'&&g.name==='poolSellForBNB'){
                quoteAsset=WBNB;money=0n;
                for(const l of receipt.logs)if(same(l.address,WBNB))try{const a=withdraw.parseLog(l)?.args;if(a&&same(a.src,GANG.router))money+=a.wad;}catch{}
              }
            }
          }
          if(money<=0n&&same(quoteAsset,WBNB)){
            let decoded;try{decoded=router.parseTransaction({data:tx.data,value:tx.value});}catch{}
            if(j.action==='buy'&&tx.value>0n){money=tx.value;quality=decoded?.name==='swapExactETHForTokensSupportingFeeOnTransferTokens'?'verified':'estimated';}
            if(j.action==='sell'&&decoded?.name==='swapExactTokensForETHSupportingFeeOnTransferTokens'){
              for(const l of receipt.logs)if(same(l.address,WBNB))try{money+=withdraw.parseLog(l)?.args.wad||0n;}catch{}
            }
          }
        }
        const amount=j.action==='buy'?quantity:-quantity;
        if(amount<=0n)continue;if(money<=0n){money=BigInt(fill?.quoteRaw||0);quality='unknown';}
        const [meta,tokenDecimals]=await Promise.all([this.metadata(quoteAsset),unit==='shares'?18:new Contract(j.token,ABI.ERC20,this.provider).decimals().then(Number)]);
        this.records.push({wallet,token:getAddress(j.token),action:j.action,quantityRaw:String(amount),quoteRaw:String(money),
          quoteAsset,quoteDecimals:meta.decimals,tokenDecimals,quoteSymbol:meta.symbol,unit,quality,
          txHash:hash,block:receipt.blockNumber,index:receipt.index||0,atUtc:j.createdUtc,
          gasWei:String(receipt.gasUsed*receipt.gasPrice),source:'confirmed_receipt'});changed=true;
      }catch{/* Missing receipt or metadata is unknown cost, never a zero-cost gain. */}
    }
    for(const j of jobs){for(const e of j.events||[]){
      const action=e.stage==='claim_fill'?'convert':e.stage==='transfer_confirmed'?'transfer':null;
      if(!action||!/^0x[0-9a-f]{64}$/i.test(e.txHash||'')||this.records.some(t=>same(t.wallet,wallet)&&same(t.txHash,e.txHash)&&t.action===action))continue;
      try{const [tx,r]=await Promise.all([this.provider.getTransaction(e.txHash),this.provider.getTransactionReceipt(e.txHash)]);
        if(r?.status!==1||!same(tx?.from,wallet))continue;const delta=netReceived(r,j.token,wallet),qty=action==='convert'?delta:-delta;if(qty<=0n)continue;
        const previous=this.records.find(t=>same(t.wallet,wallet)&&same(t.token,j.token));
        this.records.push({wallet,token:j.token,action,quantityRaw:String(qty),quoteRaw:'0',quoteAsset:previous?.quoteAsset||WBNB,
          quoteDecimals:previous?.quoteDecimals||18,tokenDecimals:18,unit:'token',quality:'verified',txHash:e.txHash,
          block:r.blockNumber,index:r.index||0,gasWei:String(r.gasUsed*r.gasPrice),atUtc:e.atUtc||j.createdUtc});changed=true;
      }catch{}
    }}
    for(const t of this.records.filter(t=>same(t.wallet,wallet)&&t.quality==='estimated'&&same(t.quoteAsset,WBNB))){
      try{const h=await this.cli(['wallet','tx-history','--tx',t.txHash,'--binanceChainId','56']);let net=0n;
        for(const x of h.transactions||[]){if(x.status!=='confirmed')continue;for(const leg of x.txHashList||[]){if(!same(leg.txHash,t.txHash))continue;
          for(const s of leg.instructions?.send||[])if(same(s.tokenInfo?.contractAddress,BNB)||same(s.tokenInfo?.contractAddress,WBNB))net+=BigInt(s.amount||0);
          for(const s of leg.instructions?.receive||[])if(same(s.tokenInfo?.contractAddress,BNB)||same(s.tokenInfo?.contractAddress,WBNB))net-=BigInt(s.amount||0);}}
        const value=t.action==='buy'?net:-net;if(value>0n){t.quoteRaw=String(value);t.quality='verified';t.source='receipt_and_wallet_history';changed=true;}
      }catch{}}
    if(changed){this.save();this.cache.delete(wallet.toLowerCase());}
  }
  async read(wallet,force=false){const key=wallet.toLowerCase(),hit=this.cache.get(key);
    if(!force&&hit&&Date.now()-hit.at<20000)return hit.value;if(this.pending.has(key))return this.pending.get(key);
    const work=this.readOnce(wallet).finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;}
  async position(wallet,token){await this.ingest(wallet,await this.getJobs());const b=bookTrades(this.records.filter(t=>same(t.wallet,wallet))).get(token.toLowerCase());
    const info=await this.detect(token,wallet);if(!b)return {token,phase:info.phase,pair:info.pair,basisComplete:false,basisNote:'缺少已确认买入成本'};
    if(b.unit==='shares'&&info.phase!=='curve')return {token,phase:info.phase,pair:info.pair,needsClaim:true,market:info.market,basisComplete:false};
    const {positionBalance}=await import('./position_quote.mjs');const raw=await positionBalance(this.provider,info,wallet);
    const small=raw>0n?await this.quote(info,{action:'sell',bps:1,address:wallet}):null;
    const price=small?await this.convert(small.quoteAsset,b.quoteAsset,BigInt(small.outputRaw)):null;
    return {token,phase:info.phase,pair:info.pair,market:info.market,balanceRaw:String(raw),
      basisComplete:b.basisComplete&&raw===b.quantity,costRaw:String(b.cost),quantityRaw:String(b.quantity),quoteAsset:b.quoteAsset,
      priceRaw:price===null?null:String(price),priceQuantityRaw:small?.inputRaw||null,quotationMode:small?.mode,
      tokenDecimals:b.tokenDecimals,quoteDecimals:b.quoteDecimals};}
  async readOnce(wallet){
    const [data,jobs]=await Promise.all([this.cli(['wallet','balance','--binanceChainId','56','--hideLowValue','false']),this.getJobs()]);
    await this.ingest(wallet,jobs);
    const balances=normalizeBalances(data),books=bookTrades(this.records.filter(t=>same(t.wallet,wallet)));
    const candidates=new Map(balances.map(x=>[x.token.toLowerCase(),x]));
    for(const [key,b]of books)if(!candidates.has(key))candidates.set(key,{token:b.token,symbol:'',balance:'0',valueUsd:null});
    const positions=await Promise.all([...candidates.values()].slice(0,100).map(async item=>{
      const b=books.get(item.token.toLowerCase());const base={...item,knownTrade:!!b,tradeCount:b?.trades.length||0};
      if(!b)return {...base,basisComplete:false,cost:null,realized:null,unrealized:null};
      if(b.quantity===0n&&Number(item.balance)===0){const pnl=pnlForBalance(b,0n,0n);return {...base,...pnl,balanceRaw:'0',balance:'0',unit:b.unit,
        quoteAsset:b.quoteAsset,quoteSymbol:(await this.metadata(b.quoteAsset)).symbol,cost:'0',value:'0',quoteDecimals:b.quoteDecimals,tokenDecimals:b.tokenDecimals,
        realized:pnl.realizedRaw===null?null:formatUnits(pnl.realizedRaw,b.quoteDecimals),unrealized:pnl.unrealizedRaw===null?null:'0',
        gasBNB:formatUnits(b.gas,18),trades:b.trades.slice(-50).reverse()};}
      try{const info=await this.detect(item.token,wallet);let raw;
        if(info.platform==='flap'&&info.phase==='curve'){raw=await new Contract(info.market,ABI.FLAP_MARKET,this.provider).sharesOf(wallet);base.unit='shares';}
        else{raw=await new Contract(item.token,ABI.ERC20,this.provider).balanceOf(wallet);base.unit='token';}
        base.balance=formatUnits(raw,b.tokenDecimals);base.phase=info.phase;base.platform=info.platform;base.market=info.market;
        base.symbol=info.symbol||item.symbol||item.token.slice(0,8);let valueRaw=null,valuationError=null,priceRaw=null,priceQuantityRaw=null;
        if(raw>0n){try{const q=await this.quote(info,{action:'sell',bps:10000,address:wallet});
          valueRaw=await this.convert(q.quoteAsset,b.quoteAsset,BigInt(q.outputRaw));
          const small=await this.quote(info,{action:'sell',bps:1,address:wallet});
          priceRaw=await this.convert(small.quoteAsset,b.quoteAsset,BigInt(small.outputRaw));priceQuantityRaw=BigInt(small.inputRaw);
        }catch(e){valuationError='当前卖出报价不可用';}}
        const pnl=pnlForBalance(b,raw,valueRaw),meta=await this.metadata(b.quoteAsset);
        return {...base,...pnl,quoteAsset:b.quoteAsset,quoteSymbol:meta.symbol,quoteDecimals:b.quoteDecimals,tokenDecimals:b.tokenDecimals,
          balanceRaw:String(raw),priceRaw:priceRaw===null?null:String(priceRaw),priceQuantityRaw:priceQuantityRaw===null?null:String(priceQuantityRaw),
          valueRaw:valueRaw===null?null:String(valueRaw),cost:pnl.costRaw===null?null:formatUnits(pnl.costRaw,b.quoteDecimals),
          value:valueRaw===null?null:formatUnits(valueRaw,b.quoteDecimals),realized:pnl.realizedRaw===null?null:formatUnits(pnl.realizedRaw,b.quoteDecimals),
          unrealized:pnl.unrealizedRaw===null?null:formatUnits(pnl.unrealizedRaw,b.quoteDecimals),gasBNB:formatUnits(b.gas,18),
          valuationError,basisNote:pnl.basisComplete?'已确认成交的加权成本':'成本不全、币种变化或有外部转入转出',
          trades:b.trades.slice(-50).reverse()};
      }catch{return {...base,basisComplete:false,cost:null,realized:null,unrealized:null,basisNote:'当前登记或持仓单位未核实',trades:b.trades.slice(-50).reverse()};}
    }));
    const result={address:wallet,updatedAt:Date.now(),positions,balances,
      notice:'盈亏按各币的底池币计算，估值为当前可卖报价，Gas 单独列出；未知成本不记作零成本。',
      source:'本部署保留的已确认成交；外部转入及缺失历史不会伪造成完整盈亏'};
    this.cache.set(wallet.toLowerCase(),{at:Date.now(),value:result});return result;
  }
}
