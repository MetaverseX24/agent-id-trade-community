import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletPool } from '../src/wallet_pool.mjs';
const address='0x0000000000000000000000000000000000000001';
const cli=async args=>{
  const command=args.slice(0,2).join(' ');
  if(command==='wallet status')return {status:'CONNECTED'};
  if(command==='wallet address')return {addresses:[{binanceChainId:'56',address}]};
  if(command==='wallet agent-id')return {claimed:true,agentId:'example.ai'};
  if(command==='wallet tx-lock')return {status:'UNLOCKED'};
  if(command==='wallet settings')return {devMode:{enabled:true,expiresAt:new Date(Date.now()+3600000).toISOString()},
    sessionExpireTime:new Date(Date.now()+3600000).toISOString(),tradeAllTokens:true};
  throw Error('unexpected_command');
};
test('wallet profiles verify identity and keep failed peers independent',async()=>{
  const pool=new WalletPool({file:'missing-test-profile.json',primaryAddress:address,cli});
  pool.records=[{id:'wallet2',label:'第二钱包',endpoint:'https://example.invalid',token:'x'.repeat(40)}];
  pool.request=async()=>{throw Error('offline');};
  const list=await pool.list();
  assert.equal(list[0].ready,true);assert.equal(list[1].ready,false);
  assert(!JSON.stringify(list).includes('x'.repeat(40)));
  const wrong=new WalletPool({file:'missing-test-profile.json',primaryAddress:'0x0000000000000000000000000000000000000002',cli});
  assert.equal((await wrong.status()).error,'wallet_identity_mismatch');
});
test('unprotected remote wallet workers are rejected',()=>{
  const pool=new WalletPool({file:'missing-test-profile.json',primaryAddress:address,cli});
  assert.throws(()=>pool.add({id:'wallet2',endpoint:'http://example.com',token:'x'.repeat(40)}),/https_or_localhost/);
});
test('the same connected address cannot be treated as two wallets',async()=>{
  const pool=new WalletPool({file:'missing-test-profile.json',primaryAddress:address,cli});
  pool.records=[{id:'wallet2',label:'wallet2',endpoint:'https://example.invalid',token:'x'.repeat(40)}];
  pool.request=async()=>({status:'CONNECTED',ready:true,address});
  const rows=await pool.list();assert.equal(rows[0].ready,true);
  assert.equal(rows[1].ready,false);assert.equal(rows[1].error,'wallet_duplicate_address');
});
test('concurrent login clicks reuse one QR request and provide an inline image',async()=>{
  let calls=0;
  const loginCli=async args=>{
    if(args[0]==='auth'&&args[1]==='signin'){calls++;await new Promise(r=>setTimeout(r,10));return {
      urlForWeb:'https://web3.binance.com/zh-CN/agent-login?test=unit',pairingCode:'a1b2c3',qrCodeId:'test-only',expireAt:Date.now()+180000};}
    if(args[0]==='auth')return new Promise(()=>{});
    return cli(args);
  };
  const pool=new WalletPool({file:'missing-test-profile.json',primaryAddress:address,cli:loginCli});
  const [a,b]=await Promise.all([pool.signIn(),pool.signIn()]);
  assert.equal(calls,1);assert.equal(a.code,b.code);assert.match(a.qrDataUrl,/^data:image\/png;base64,/);
});
test('the official app.binance.com QR response is accepted and unknown hosts are rejected',async()=>{
  const makeCli=url=>async args=>args[0]==='auth'&&args[1]==='signin'?{
    urlForWeb:url,pairingCode:'a1b2c3',qrCodeId:'unit-only',expireAt:String(Date.now()+180000)}:new Promise(()=>{});
  const pool=new WalletPool({file:'missing-test-profile.json',cli:makeCli('https://app.binance.com/uni-qr/UnitTestOnly')});
  const result=await pool.signIn();assert.match(result.qrDataUrl,/^data:image\/png;base64,/);
  const web=new URL(result.url);assert.equal(web.hostname,'web3.binance.com');
  assert.equal(Buffer.from(web.searchParams.get('_ul'),'base64').toString(),'https://app.binance.com/uni-qr/UnitTestOnly');
  const unsafe=new WalletPool({file:'missing-test-profile.json',cli:makeCli('https://app.binance.com.attacker.example/uni-qr/test')});
  await assert.rejects(()=>unsafe.signIn(),/invalid_binance_login_response/);
});
