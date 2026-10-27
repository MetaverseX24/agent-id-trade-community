import test from 'node:test';import assert from 'node:assert/strict';
import {prepareFundedBuy} from '../src/engine/agent_ui/funded_buy.mjs';
test('wrap and approve continue to buy when price rises within the actual budget and slippage cap',async()=>{
 let available=0n,needed=100n;const steps=[];
 const result=await prepareFundedBuy({initialGross:100n,slippageBps:3000n,capacity:async()=>300n,balance:async()=>available,
  fund:async cap=>{steps.push(['wrap',cap]);available=cap;return cap;},approve:async cap=>{steps.push(['approve',cap]);needed=110n;return true;},
  refresh:async cap=>{if(cap<needed)throw Error('budget_insufficient_for_target');return {gross:needed,output:10000000n};}});
 assert.equal(result.gross,110n);assert.deepEqual(steps,[['wrap',130n],['approve',130n]]);
});
test('an existing quote balance can top up the difference within one order, without a second user request',async()=>{
 let available=100n,needed=100n,wrapped=0n,approvals=0;
 const result=await prepareFundedBuy({initialGross:100n,slippageBps:3000n,capacity:async()=>300n,balance:async()=>available,
  fund:async cap=>{wrapped+=cap-available;available=cap;return cap;},approve:async()=>{approvals++;needed=110n;return true;},
  refresh:async cap=>{if(cap<needed)throw Error('budget_insufficient_for_target');return {gross:needed,output:10000000n};}});
 assert.equal(result.gross,110n);assert.equal(wrapped,30n);assert.equal(approvals,2);
});
test('true budget or price-limit breaches stop before buying instead of treating the first quote as the budget',async()=>{
 let available=0n,needed=100n;const options={initialGross:100n,slippageBps:3000n,capacity:async()=>105n,balance:async()=>available,
  fund:async cap=>{available=cap;return cap;},approve:async()=>{needed=110n;return true;},
  refresh:async cap=>{if(cap<needed)throw Error('budget_insufficient_for_target');return {gross:needed,output:10n};}};
 await assert.rejects(()=>prepareFundedBuy(options),/budget_insufficient/);assert.equal(available,105n);
 available=0n;needed=100n;await assert.rejects(()=>prepareFundedBuy({...options,capacity:async()=>300n,approve:async()=>{needed=140n;return true;}}),/slippage_cap/);assert.equal(available,130n);
});
