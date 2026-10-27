import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';
import {verifyTokenTransfer} from '../src/engine/agent_ui/transfer_receipt.mjs';
const token='0x'+'1'.repeat(40),wallet='0x'+'2'.repeat(40),recipient='0x'+'3'.repeat(40),fee='0x'+'4'.repeat(40),i=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const log=(to,value)=>({address:token,...i.encodeEventLog(i.getEvent('Transfer'),[wallet,to,value])});
test('transfer proof binds the token, sender, recipient and entire authorized quantity, including token tax',()=>{
 const receipt={status:1,logs:[log(recipient,99n),log(fee,1n)]};assert.equal(verifyTokenTransfer(receipt,{token,wallet,recipient,amount:100n}).received,99n);
 assert.throws(()=>verifyTokenTransfer(receipt,{token,wallet,recipient:fee,amount:101n}),/amount_mismatch/);
 assert.throws(()=>verifyTokenTransfer(receipt,{token:fee,wallet,recipient,amount:100n}),/amount_mismatch/);
 assert.throws(()=>verifyTokenTransfer({...receipt,status:0},{token,wallet,recipient,amount:100n}),/invalid/);
});
