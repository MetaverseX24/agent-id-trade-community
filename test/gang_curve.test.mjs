import test from 'node:test';import assert from 'node:assert/strict';
import {parseEther} from 'ethers';
import {gangV2BuyQuote,resolveGangBuyQuote} from '../src/engine/agent_ui/gang_curve.mjs';
const c={virtualQuote:parseEther('480000'),realQuote:0n,sold:0n,gradAmt:parseEther('1500000')};
test('wallet 1% quote plateau cannot cause the whole BNB budget to be exchanged',()=>{
  const desired=parseEther('10000000'),upper=parseEther('30000');
  assert.equal(gangV2BuyQuote(c,upper,desired),desired);
  const result=resolveGangBuyQuote(c,upper,desired,desired);
  assert.equal(result.output,desired);assert.ok(result.gross<upper/5n);
  assert.ok(gangV2BuyQuote(c,result.gross-2n,desired)<desired);
});
test('inverse curve preserves explicit target and budget limits',()=>{
  const desired=parseEther('10000000'),low=parseEther('100');
  assert.throws(()=>resolveGangBuyQuote(c,low,desired,desired),/budget_insufficient/);
  const r=resolveGangBuyQuote(c,low,desired,desired,false);assert.equal(r.gross,low);assert.ok(r.output<desired);
  assert.throws(()=>resolveGangBuyQuote(c,parseEther('30000'),desired,desired/2n),/budget_insufficient/);
});
