import test from 'node:test';import assert from 'node:assert/strict';
import {walletSnapshot} from '../src/engine/agent_ui/preflight_snapshot.mjs';
const wallet='0x'+'1'.repeat(40),now=Date.now(),future=new Date(now+3600000).toISOString();
const snapshot={wallet,checkedAt:now,chainId:56,status:{status:'CONNECTED'},agent:{claimed:true},addresses:{addresses:[{binanceChainId:'56',address:wallet}]},
 settings:{devMode:{enabled:true,balanceExceeded:false,expiresAt:future},tradeAllTokens:true,sessionExpireTime:future}};
test('fresh queue-owned wallet snapshot removes four duplicate CLI/API queries',async()=>{let calls=0;const cli=async()=>{calls++;return {};};
 const result=await walletSnapshot(cli,wallet,{AGENT_PREFLIGHT_SNAPSHOT:JSON.stringify(snapshot)},now);assert.equal(calls,0);assert.equal(result[1].devMode.enabled,true);});
test('stale, wrong-wallet or malformed snapshots fall back to live preflight',async()=>{for(const s of [{...snapshot,checkedAt:now-6000},{...snapshot,wallet:'0x'+'2'.repeat(40)},null]){
 let calls=0;await walletSnapshot(async()=>{calls++;return {};},wallet,{AGENT_PREFLIGHT_SNAPSHOT:JSON.stringify(s)},now);assert.equal(calls,4);}});
