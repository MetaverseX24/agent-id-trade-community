import test from 'node:test';import assert from 'node:assert/strict';
import {bookTrades,pnlForBalance,normalizeBalances} from '../src/engine/agent_ui/portfolio.mjs';
const token='0x'+'1'.repeat(40),quote='0x'+'2'.repeat(40);
const fill=(action,q,m,block,extra={})=>({token,quoteAsset:quote,action,quantityRaw:String(q),quoteRaw:String(m),block,index:0,quality:'verified',...extra});
test('weighted cost, partial sales and realized versus unrealized PnL reconcile exactly',()=>{
 const book=bookTrades([fill('buy',100n,1000n,1),fill('buy',100n,2000n,2),fill('sell',50n,1000n,3)]).get(token);
 assert.equal(book.quantity,150n);assert.equal(book.cost,2250n);assert.equal(book.realized,250n);
 const p=pnlForBalance(book,150n,3000n);assert.equal(p.costRaw,'2250');assert.equal(p.unrealizedRaw,'750');assert.equal(p.multiple,1.3333);
});
test('external transfers, missing buy history and estimated native costs never become free profit',()=>{
 const b=bookTrades([fill('buy',100n,1000n,1)]).get(token);assert.equal(pnlForBalance(b,110n,2000n).unrealizedRaw,null);
 const missing=bookTrades([fill('sell',100n,1000n,1)]).get(token);assert.equal(missing.basisComplete,false);
 const estimate=bookTrades([fill('buy',100n,1000n,1,{quality:'estimated'})]).get(token);assert.equal(pnlForBalance(estimate,100n,2000n).costRaw,null);
});
test('claim converts position units without resetting cost; transfer is not realized profit',()=>{
 const b=bookTrades([fill('buy',100n,1000n,1,{unit:'shares'}),fill('convert',500n,0n,2),fill('transfer',500n,0n,3)]).get(token);
 assert.equal(b.quantity,0n);assert.equal(b.cost,0n);assert.equal(b.realized,0n);
 const orphan=bookTrades([fill('convert',100n,0n,1)]).get(token);assert.equal(orphan.basisComplete,false);
});
test('wallet balance normalization preserves native SDK value and price fields',()=>{
 const [x]=normalizeBalances([{address:token,symbol:'X',balance:'12.5',price:'2',value:'25'}]);assert.equal(x.valueUsd,25);assert.equal(x.priceUsd,2);
});
