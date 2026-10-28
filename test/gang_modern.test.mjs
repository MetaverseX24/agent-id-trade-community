import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress,parseEther} from 'ethers';
import {GANG,GANG_ABI,GANG_REGISTRY_ABI,GANG_ROUTER_IFACE,GANG_SHARE,fairBuyPlan,detectModernGang,gangPoolQuote} from '../src/engine/agent_ui/gang_protocol.mjs';
import {tradeModernGang} from '../src/engine/agent_ui/gang_trade.mjs';
import {ABI,WBNB,ROUTER} from '../src/engine/agent_ui/platforms.mjs';
import {recordBuyFundingReceipt,unusedAcquiredQuote} from '../src/engine/agent_ui/sale_settlement.mjs';
import {makeWorkflowConsent,checkWorkflowStep} from '../src/engine/agent_ui/workflow_consent.mjs';
import {createQuote} from '../src/quotes.mjs';
const token='0x0000000000000000000000000000000000000011',wallet='0x0000000000000000000000000000000000000022';
const foreign='0x0000000000000000000000000000000000000033',supply=parseEther('1000000000'),curve=[wallet,WBNB,0n,0n,parseEther('15'),parseEther('5'),false,200n,300n,0n,ZeroAddress,ZeroAddress];
const sale=[wallet,0n,200n,6000n,WBNB,1n,false,100n,100n,ZeroAddress,parseEther('0.0005'),ZeroAddress,ZeroAddress,1n];
const erc=new Interface([...ABI.ERC20,'function launchpad() view returns(address)']);
const pad=new Interface(GANG_ABI),reg=new Interface(GANG_REGISTRY_ABI),dex=new Interface(ABI.PCS_ROUTER);
function provider({fair=false,held=0n,shares=0n,lookupPad=GANG.pad,lookupKind,launched=false,quote=WBNB}={}){
 const calls=[];
 return {calls,call:async tx=>{
  const to=tx.to.toLowerCase();let i,f,values;
  if(to===GANG.registry.toLowerCase()){i=reg;f=i.parseTransaction(tx);values=f.name==='lookup'?[lookupPad,lookupKind??(fair?2:1)]:f.name==='previewSell'?[parseEther('0.04'),parseEther('0.0004')]:[0,0,0,0];}
  else if(to===GANG.pad.toLowerCase()){i=pad;f=i.parseTransaction(tx);
   const s=[...sale];s[4]=quote;s[6]=launched;const c=[...curve];c[1]=quote;c[6]=launched;
   const n=f.args.length>2?f.args[2]:0n,cost=n*sale[10];
   values={curves:c,sales:s,positions:[shares],walletRoom:[parseEther('10000000')-held],previewMint:[n,cost,cost/100n],previewWithdraw:[n*sale[10]*99n/100n,n*sale[10]/100n]}[f.name];}
  else if(to===ROUTER.toLowerCase()){i=dex;f=i.parseTransaction(tx);values=[f.name==='getAmountsIn'?[100000000000000000n,f.args[0]]:[f.args[0],f.args[0]*100000000n]];}
  else if(to===GANG.handler.toLowerCase()){
   i=new Interface(['function previewSellNextBlock(address,uint256) view returns(uint256,uint256)']);f=i.parseTransaction(tx);values=[parseEther('0.05'),parseEther('1000')];
  }else{i=erc;f=i.parseTransaction(tx);values={balanceOf:[held],totalSupply:[supply],decimals:[18],locked:[!launched],launchpad:[GANG.pad]}[f.name];}
  calls.push({to,method:f.name,args:f.args});if(!values)throw Error('unexpected_read_'+f.name);return i.encodeFunctionResult(f.name,values);
 }};
}
function options(overrides={}){
 const sent=[],approved=[],fundings=[],state={},info={platform:'gang',token,quote:WBNB,pad:'gang',kind:'v3',phase:'curve',buyTaxBps:200,sellTaxBps:300,venue:GANG.pad};
 return {sent,approved,fundings,state,provider:provider(),info,plan:{action:'buy',percent:100n,budget:parseEther('0.3'),sellBps:10000n},
  wallet,abi:ABI,wbnb:WBNB,pancake:ROUTER,minOut:x=>x*70n/100n,emit:()=>{},nativeBudget:async()=>parseEther('0.3'),
  submit:async(...a)=>{sent.push(a);return true;},allowance:async(...a)=>{approved.push(a);return true;},
  funded:async(gross,spender,refresh)=>{fundings.push({gross,spender});return refresh(parseEther('1'));},
  capacity:async()=>parseEther('1'),prepareSettlement:async native=>({nativeExpected:native}),...overrides};
}
test('V3 BNB curve buy uses a single router call, no wrap/swap/approval, and the exact target quote',async()=>{
 const o=options();assert.equal(await tradeModernGang(o),true);
 assert.equal(o.sent.length,1);assert.equal(o.approved.length,0);assert.equal(o.fundings.length,0);
 const [step,to,value,data]=o.sent[0],d=GANG_ROUTER_IFACE.parseTransaction({data});
 assert.equal(step,'buy');assert.equal(to,GANG.router);assert.equal(d.name,'v3BuyBNB');assert.equal(d.args[0],token);
 assert.ok(value<parseEther('0.06'));assert.ok(d.args[1]>=parseEther('7000000'));
 assert.equal(o.state.quoteFunding.nativeDirect,true);
});
test('non-BNB V3 quote funding continues into the same order and approves the pad, never a legacy pad',async()=>{
 const o=options({provider:provider({quote:foreign})});o.info.quote=foreign;await tradeModernGang(o);
 assert.equal(o.fundings.length,1);assert.equal(o.fundings[0].spender,GANG.pad);
 const [step,to,value,data]=o.sent[0];assert.equal(to,GANG.pad);assert.equal(value,0n);assert.equal(pad.parseTransaction({data}).name,'buy');
});
test('fair 1% means 200 whole shares and respects lower per-wallet caps before any funding',()=>{
 const s={capShares:200n,sold:1n,sharePrice:sale[10],mintFeeBps:100n};
 const p=fairBuyPlan(s,0n,0n,supply,100n,parseEther('0.3'));
 assert.equal(p.shares,200n);assert.equal(p.output,parseEther('10000000'));assert.equal(p.gross,parseEther('0.101'));
 assert.throws(()=>fairBuyPlan({...s,capShares:100n},0n,0n,supply,100n,parseEther('0.3')),/exceeds_cap/);
 assert.throws(()=>fairBuyPlan(s,0n,0n,supply,100n,parseEther('0.01')),/budget_insufficient/);
});
test('fair native mint is one transaction; sell-back is direct withdrawal without approval',async()=>{
 const buy=options({provider:provider({fair:true})});buy.info.kind='fair';await tradeModernGang(buy);
 const m=GANG_ROUTER_IFACE.parseTransaction({data:buy.sent[0][3]});assert.equal(m.name,'fairMintBNB');assert.equal(m.args[1],200n);assert.equal(m.args[2],200n);
 const sell=options({provider:provider({fair:true,shares:200n,held:200n*GANG_SHARE})});sell.info.kind='fair';sell.plan.action='sell';sell.plan.sellBps=5000n;
 await tradeModernGang(sell);assert.equal(sell.approved.length,0);assert.equal(sell.sent.length,1);
 const d=pad.parseTransaction({data:sell.sent[0][3]});assert.equal(d.name,'withdraw');assert.equal(d.args[1],100n);
 assert.equal(sell.state.settlement.nativeExpected,false);
});
test('V3 curve sell reuses allowance machinery, refreshes registry sell quote and settles quote to native',async()=>{
 const o=options({provider:provider({held:parseEther('10000000')})});o.plan.action='sell';await tradeModernGang(o);
 assert.equal(o.approved[0][1],GANG.pad);assert.equal(pad.parseTransaction({data:o.sent[0][3]}).name,'sell');
 assert.ok(o.provider.calls.some(x=>x.method==='previewSell'));assert.equal(o.state.settlement.nativeExpected,false);
});
test('modern pool sale includes swap-back tax quote and pays native BNB through reviewed router',async()=>{
 const o=options({provider:provider({held:parseEther('10000000'),launched:true})});o.info.phase='graduated';o.info.pair=foreign;o.plan.action='sell';await tradeModernGang(o);
 assert.equal(o.approved[0][1],GANG.router);assert.equal(GANG_ROUTER_IFACE.parseTransaction({data:o.sent[0][3]}).name,'poolSellForBNB');
 assert.ok(o.provider.calls.some(x=>x.method==='previewSellNextBlock'));assert.equal(o.state.settlement.nativeExpected,true);
});
test('native curve refunds convert only refund from this receipt, preserving old WBNB',()=>{
 const events=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
 const log=events.encodeEventLog(events.getEvent('Transfer'),[GANG.pad,wallet,parseEther('0.002')]);
 const s={quoteFunding:{asset:WBNB,nativeDirect:true,acquiredRaw:'0',spentRaw:'0'}};
 recordBuyFundingReceipt(s,{hash:'0x'+'1'.repeat(64),logs:[{address:WBNB,...log}]},wallet);
 assert.equal(unusedAcquiredQuote(s.quoteFunding),parseEther('0.002'));
});
test('registry double-registration is required and new unreviewed pads never receive approvals',async()=>{
 const o={ercAbi:ABI.ERC20,wbnb:WBNB,verifiedPair:async()=>null};
 assert.equal((await detectModernGang(provider(),token,wallet,o)).kind,'v3');
 assert.equal((await detectModernGang(provider({fair:true}),token,wallet,o)).kind,'fair');
 assert.equal(await detectModernGang(provider({lookupPad:ZeroAddress,lookupKind:0}),token,wallet,o),null);
 await assert.rejects(detectModernGang(provider({lookupPad:foreign}),token,wallet,o),/requires_review/);
});
test('modern one-click consent includes only reviewed new protocol and honors the existing native budget',()=>{
 const info=options().info,scope=makeWorkflowConsent(info,{action:'buy',budgetBNB:'0.3'},wallet,'11111111-1111-4111-8111-111111111111');
 assert.ok(scope.spenders.includes(GANG.router));assert.ok(scope.spenders.includes(GANG.pad));assert.ok(!scope.spenders.includes(foreign));
 const c={from:wallet,to:GANG.router,valueWei:parseEther('0.1'),step:'buy',inputData:GANG_ROUTER_IFACE.encodeFunctionData('v3BuyBNB',[token,1n,Math.floor(Date.now()/1000)+240])};
 const clean={requestId:'unit-preview',simulationCode:'000000000',authorityChangeCount:0,riskDetails:[],addressRisks:[],riskBehaviors:[]};
 assert.equal(checkWorkflowStep(clean,c,scope),parseEther('0.1'));
 assert.throws(()=>checkWorkflowStep(clean, {...c,valueWei:parseEther('0.31')},scope),/budget_exceeded/);
 assert.throws(()=>checkWorkflowStep(clean,{...c,inputData:GANG_ROUTER_IFACE.encodeFunctionData('v3BuyBNB',[foreign,1n,Math.floor(Date.now()/1000)+240])},scope),/trade_mismatch/);
});
test('public quote-only orders resolve modern curve and fair targets without a signing command',async()=>{
 const v3=options(),order={action:'buy',mode:'percent',bps:100,budgetBNB:'0.3',address:wallet};
 const a=await createQuote(v3.provider,v3.info,order);
 assert.equal(a.expectedTokens,'10000000.0');assert.equal(a.estimateOnly,true);assert.ok(Number(a.nativeValueBNB)<0.1);
 const fair=options({provider:provider({fair:true})});fair.info.kind='fair';
 const b=await createQuote(fair.provider,fair.info,order);
 assert.equal(b.expectedTokens,'10000000.0');assert.equal(b.nativeValueBNB,'0.101');
 assert.equal(v3.sent.length+fair.sent.length,0);
});
