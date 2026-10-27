import test from 'node:test';
import assert from 'node:assert/strict';
import {AbiCoder,Interface,parseEther} from 'ethers';
import {marketConvertToNative,netReceived,proceedsToConvert,unusedAcquiredQuote} from '../src/engine/agent_ui/sale_settlement.mjs';
import {BNB} from '../src/engine/agent_ui/platforms.mjs';
import {makeBuyPlan} from '../src/engine/trade_logic.mjs';
const wallet='0x'+'1'.repeat(40),asset='0x'+'2'.repeat(40),other='0x'+'3'.repeat(40),hash='0x'+'a'.repeat(64);
const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
function log(from,to,value){return {address:asset,...abi.encodeEventLog(abi.getEvent('Transfer'),[from,to,value])};}
const state=()=>({settlement:{asset,wallet,saleTxHash:hash,receivedRaw:'100',amountRaw:'100'}});
function provider(spent=100n){return {call:async()=>AbiCoder.defaultAbiCoder().encode(['uint256'],[18]),
  getTransaction:async()=>({from:wallet}),getTransactionReceipt:async()=>({status:1,logs:[log(wallet,other,spent)]})};}
const order={orderId:'unit-123',status:'FINISHED',fromToken:asset,toToken:BNB,chain:'56',txHash:hash,toTokenActualQty:'0.01'};
test('receipt net accounting distinguishes refunds, costs, and pre-existing quote balances',()=>{
  const receipt={logs:[log(wallet,other,24710n),log(other,wallet,20596n)]};
  assert.equal(netReceived(receipt,asset,wallet),-4114n);
  assert.equal(unusedAcquiredQuote({acquiredRaw:'18611',spentRaw:'4114'}),14497n);
  assert.equal(proceedsToConvert(100n,500n,650n),100n);
  assert.equal(proceedsToConvert(100n,500n,480n),0n);
});
test('native conversion submits once with MEV and 30% slippage, verifies terminal status and receipt',async()=>{
  let submits=0,lists=0;const s=state(),events=[];
  const cli=async args=>{if(args[1]==='swap'){
    submits++;assert.equal(args[args.indexOf('--mev')+1],'true');assert.equal(args[args.indexOf('--slippage')+1],'30');
    assert.equal(args[args.indexOf('--toToken')+1],BNB);assert.equal(s.settlement.nativeOrder.stage,'submitting');return {orderId:order.orderId};}
    return {list:[++lists===1?{...order,status:'PENDING'}:order]};};
  const ok=await marketConvertToNative({provider:provider(),wallet,state:s,amount:100n,slippageBps:3000n,persist:()=>{},emit:e=>events.push(e),cli,sleep:async()=>{}});
  assert.equal(ok,true);assert.equal(submits,1);assert.equal(lists,2);assert.equal(s.settlement.nativeReceivedWei,parseEther('0.01').toString());
});
test('lost native swap response never submits again; partial fills never claim complete settlement',async()=>{
  const s=state();let submits=0;
  const options={provider:provider(),wallet,state:s,amount:100n,slippageBps:3000n,persist:()=>{},emit:()=>{},cli:async()=>{submits++;throw Error('timeout');}};
  assert.equal(await marketConvertToNative(options),false);
  assert.equal(await marketConvertToNative(options),false);assert.equal(submits,1);
  const partial=state();partial.settlement.nativeOrder={asset,amountRaw:'100',orderId:order.orderId};
  assert.equal(await marketConvertToNative({...options,state:partial,provider:provider(70n),cli:async()=>({list:[order]})}),false);
  assert.equal(partial.settlement.nativeSettled,undefined);assert.equal(partial.settlement.nativeOrder.stage,'partial_fill_review_required');
});
test('BNB conversion cannot spend beyond the original sale proof',async()=>{
  await assert.rejects(()=>marketConvertToNative({provider:provider(),wallet,state:state(),amount:101n,persist:()=>{},emit:()=>{}}),/scope_invalid/);
});
test('30% buy-price cap is bounded by both the quote and the user budget',()=>{
  const p=makeBuyPlan({estimate:{curveQuote:99n,totalFee:1n,userPays:100n,tokenAmount:1000n},quoteIsWrappedNative:true,nativeBudgetWei:300n});
  assert.equal(p.maxQuotePay,130n);assert.equal(p.minTokenOut,700n);
});
