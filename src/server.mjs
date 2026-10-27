import http from 'node:http';
import { readFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { ZeroAddress } from 'ethers';
import { DATA, ROOT, apiToken, settings, publicSettings, updateSettings,readData,writeData } from './config.mjs';
import { FailoverRpcProvider } from './engine/rpc_failover.mjs';
import { baw } from './engine/wallet_cli.mjs';
import { WalletPool } from './wallet_pool.mjs';
import { Jobs, validateOrder } from './jobs.mjs';
import { MarketData } from './market.mjs';
import { createQuote } from './quotes.mjs';
import { coreAbi } from './protocol_snapshot.mjs';
import { detectAgentToken } from './engine/agent_ui/platforms.mjs';
import {Portfolio,normalizeBalances} from './engine/agent_ui/portfolio.mjs';
import {positionQuote,convertQuote,positionBalance} from './engine/agent_ui/position_quote.mjs';
import {MigrationRules} from './migration_rules.mjs';
import {networkEnvironment} from './engine/network_env.mjs';
import {Contract} from 'ethers';
import {ABI,FLAP} from './engine/agent_ui/platforms.mjs';

const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('主界面仅支持本机监听，请使用 SSH 隧道访问服务器部署');
const origin=`http://${host==='::1'?'[::1]':host}:${port}`,csrf=randomBytes(32).toString('base64url');
const workerToken=process.env.AGENT_WORKER_TOKEN_FILE?readFileSync(process.env.AGENT_WORKER_TOKEN_FILE,'utf8').trim():process.env.AGENT_WORKER_TOKEN||'';
const makeProvider=()=>new FailoverRpcProvider(settings.rpcHttp||'https://bsc-rpc.publicnode.com',[
  'https://bsc-rpc.publicnode.com','https://bsc-dataseed.bnbchain.org']);
let provider=makeProvider(),market=new MarketData(provider,settings.rpcWs);
const cliPath=fileURLToPath(new URL('../node_modules/@binance/agentic-wallet/dist/index.js',import.meta.url));
const sessionDir=process.env.BINANCE_BAW_DIR||join(DATA,'wallets','primary','baw');
mkdirSync(sessionDir,{recursive:true,mode:0o700});
const environment=()=>networkEnvironment({...process.env,BINANCE_BAW_DIR:sessionDir,BAW_CLI:process.env.BAW_CLI||cliPath,
  BSC_RPC_HTTP:settings.rpcHttp||'https://bsc-rpc.publicnode.com'});
const cli=(args,timeout)=>baw(args,timeout,environment());
const pool=new WalletPool({file:join(DATA,'wallet-profiles.json'),primaryAddress:process.env.EXPECTED_WALLET||null,cli});
const jobs=new Jobs({provider,pool,quote:(info,order)=>createQuote(provider,info,order),environment});
const portfolio=new Portfolio({file:join(DATA,'portfolio-ledger.json'),provider,cli,
  detect:(token,wallet)=>detectAgentToken(provider,token,coreAbi,wallet),
  quote:(info,order)=>positionQuote(provider,info,order),convert:(from,to,amount)=>convertQuote(provider,from,to,amount),
  getJobs:async()=>jobs.rows.filter(j=>(j.walletId||'primary')==='primary')});
const migrations=new MigrationRules({read:()=>readData('migration-rules.json',[]),write:rows=>writeData('migration-rules.json',rows),
  orders:async()=>{await jobs.list();return jobs.rows;},canRun:()=>settings.liveTrading,busy:()=>jobs.locks.has('primary'),reconcile:id=>jobs.reconcilePosition(id),
  execute:input=>jobs.operation(input,{migration:true}),position:async r=>{
    const s=await pool.status('primary');if(!s.ready)throw Error(s.error||'wallet_not_ready');
    const info=await detectAgentToken(provider,r.token,coreAbi,s.address);
    const balance=await positionBalance(provider,info,s.address);
    const shares=info.platform==='flap'&&info.market&&info.phase!=='curve'?await new Contract(info.market,ABI.FLAP_MARKET,provider).sharesOf(s.address):0n;
    return {wallet:s.address,phase:info.phase,pair:info.pair,balanceRaw:String(balance),needsClaim:shares>0n};
  }});
async function migrationList(){const rows=migrations.list().map(r=>({...r,walletId:'primary',walletLabel:'钱包 1'}));
  await Promise.all(pool.records.map(async profile=>{try{const data=await pool.request(profile,'/worker/migrations');
    rows.push(...(data.rules||[]).map(r=>({...r,walletId:profile.id,walletLabel:profile.label})));}
    catch{rows.push({id:'unavailable-'+profile.id,walletId:profile.id,walletLabel:profile.label,stage:'worker_unavailable',enabled:false});}}));return {rules:rows};}
async function stopMigration(fields){const profile=pool.get(fields.walletId||'primary');
  return profile.local?migrations.stop(fields.id):pool.request(profile,'/worker/migrations/stop',{id:fields.id});}
let portfolioTimer;
jobs.on('change',()=>{clearTimeout(portfolioTimer);portfolioTimer=setTimeout(async()=>{const s=await pool.status('primary');
  if(s.address)portfolio.ingest(s.address,jobs.rows.filter(j=>(j.walletId||'primary')==='primary')).catch(()=>{});},2000);portfolioTimer.unref?.();});
const clients=new Set();
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data,(_,value)=>typeof value==='bigint'?value.toString():value));};
async function body(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('需要 JSON 请求');let raw='';
  for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('请求过大');}return JSON.parse(raw||'{}');}
const equal=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);};
function allowed(req){const requestHost=String(req.headers.host||'').toLowerCase(),accepted=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
  return accepted.includes(requestHost)&&(!req.headers.origin||accepted.some(h=>req.headers.origin===`http://${h}`));}
const mutatingAllowed=req=>equal(req.headers['x-agent-token'],apiToken)||(allowed(req)&&equal(req.headers['x-agent-csrf'],csrf)&&!!req.headers.origin);
function asset(res,name,type){let content=readFileSync(join(ROOT,'public',name));if(name==='index.html')content=Buffer.from(content.toString().replace('__CSRF__',csrf));
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(content);}
async function holdings(walletId){const profile=pool.get(walletId);if(!profile.local)return pool.request(profile,'/worker/holdings');
  const state=await pool.status(walletId);if(state.status!=='CONNECTED')return {walletId,items:[],error:state.error||'钱包未连接'};
  const data=await cli(['wallet','balance','--binanceChainId','56','--hideLowValue','false']);
  return {walletId,address:state.address,items:normalizeBalances(data)};}
async function portfolioFor(walletId,force=false){const profile=pool.get(walletId);
  if(!profile.local)return pool.request(profile,'/worker/portfolio'+(force?'?refresh=1':''));
  const s=await pool.status(walletId);if(s.status!=='CONNECTED'||!s.address)throw Error('钱包尚未连接');
  return {walletId,...await portfolio.read(s.address,force)};}
async function state(){return {settings:publicSettings(),wallets:await pool.list(),market:market.list(),orders:await jobs.list()};}
jobs.on('change',()=>{for(const res of clients)res.write(`data: ${JSON.stringify({type:'orders',orders:jobs.rows.slice(-60).reverse()})}\n\n`);});
async function worker(req,res){if(workerToken.length<32||!equal(req.headers['x-agent-worker'],workerToken))return json(res,401,{error:'worker_auth_required'});
  try{const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/worker/status'&&req.method==='GET')return json(res,200,await pool.status('primary'));
    if(path==='/worker/jobs'&&req.method==='GET')return json(res,200,{jobs:await jobs.list()});
    if(path==='/worker/migrations'&&req.method==='GET')return json(res,200,{rules:migrations.list()});
    if(path==='/worker/migrations/stop'&&req.method==='POST')return json(res,200,migrations.stop((await body(req)).id));
    if(path==='/worker/holdings'&&req.method==='GET')return json(res,200,await holdings('primary'));
    if(path==='/worker/portfolio'&&req.method==='GET')return json(res,200,await portfolioFor('primary',req.url.includes('refresh=1')));
    if(path==='/worker/position'&&req.method==='POST'){const f=await body(req),s=await pool.status('primary');
      if(!s.address)throw Error('钱包未连接');return json(res,200,await portfolio.position(s.address,f.token));}
    if(path==='/worker/login'&&req.method==='POST')return json(res,200,await pool.signIn('primary'));
    if(path==='/worker/trade'&&req.method==='POST')return json(res,202,await jobs.submit({...await body(req),walletIds:['primary']}));
    if(path==='/worker/operation'&&req.method==='POST')return json(res,202,await jobs.operation(await body(req)));
    if(path==='/worker/approve'&&req.method==='POST'){await jobs.approve((await body(req)).jobId);return json(res,200,{ok:true});}
    return json(res,404,{error:'not_found'});
  }catch(error){return json(res,400,{error:String(error.message).replace(/https?:\/\/\S+/g,'[endpoint]')});}}
const server=http.createServer(async(req,res)=>{
  try{if(!allowed(req))return json(res,403,{error:'请求来源不符'});const url=new URL(req.url,origin),path=url.pathname;
    if(req.method!=='GET'&&!mutatingAllowed(req))return json(res,403,{error:'操作校验失败，请刷新页面'});
    if(req.method==='GET'){
      if(path==='/')return asset(res,'index.html','text/html; charset=utf-8');
      if(path==='/app.js')return asset(res,'app.js','text/javascript; charset=utf-8');
      if(path==='/portfolio_view.js')return asset(res,'portfolio_view.js','text/javascript; charset=utf-8');
      if(path==='/app.css')return asset(res,'app.css','text/css; charset=utf-8');
      if(path==='/api/state')return json(res,200,await state());
      if(path==='/api/wallets')return json(res,200,{wallets:await pool.list()});
      if(path==='/api/market')return json(res,200,market.list());
      if(path==='/api/watchlist')return json(res,200,readData('watchlist.json',{favorites:[],blocked:[]}));
      if(path==='/api/orders')return json(res,200,{jobs:await jobs.list()});
      if(path==='/api/migrations')return json(res,200,await migrationList());
      if(path==='/api/settings')return json(res,200,publicSettings());
      if(path==='/api/statistics')return json(res,200,jobs.statistics());
      if(path==='/api/holdings')return json(res,200,await holdings(url.searchParams.get('walletId')||'primary'));
      if(path==='/api/portfolio')return json(res,200,await portfolioFor(url.searchParams.get('walletId')||'primary',url.searchParams.get('refresh')==='1'));
      if(path==='/api/detail'){const info=await detectAgentToken(provider,url.searchParams.get('token'),coreAbi);const interval=url.searchParams.get('interval')||'1m';
        if(!['1m','5m','15m','1h'].includes(interval))throw Error('图表周期无效');return json(res,200,await market.detail(info,interval));}
      if(path==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
        clients.add(res);res.write('data: {"type":"connected"}\n\n');req.on('close',()=>clients.delete(res));return;}
    }
    if(req.method==='POST'){const fields=await body(req);
      if(path==='/api/watchlist'){const token=(await import('ethers')).getAddress(fields.token).toLowerCase();
        if(!['favorites','blocked'].includes(fields.list)||typeof fields.enabled!=='boolean')throw Error('列表操作无效');
        const data=readData('watchlist.json',{favorites:[],blocked:[]});data[fields.list]=data[fields.list].filter(x=>x!==token);
        if(fields.enabled){if(data[fields.list].length>=1000)throw Error('列表最多 1000 个代币');data[fields.list].push(token);}writeData('watchlist.json',data);return json(res,200,data);}
      if(path==='/api/inspect'){const info=await detectAgentToken(provider,fields.token,coreAbi);return json(res,200,{...info,canTrade:['curve','standard_curve'].includes(info.phase)||!!info.pair});}
      if(path==='/api/quote'){const order=validateOrder(fields),s=pool.cache.get(order.walletIds[0])?.value;
        const info=await detectAgentToken(provider,order.token,coreAbi,s?.address||ZeroAddress);return json(res,200,await createQuote(provider,info,{...order,address:s?.address||ZeroAddress}));}
      if(path==='/api/orders')return json(res,202,await jobs.submit(fields));
      if(path==='/api/migrations/stop')return json(res,200,await stopMigration(fields));
      if(path==='/api/approve'){await jobs.approve(fields.jobId);return json(res,200,{ok:true});}
      if(path==='/api/wallet/login')return json(res,200,await pool.signIn(fields.walletId||'primary'));
      if(path==='/api/wallets')return json(res,201,pool.add(fields));
      if(path==='/api/settings'){if(jobs.locks.size)throw Error('有订单正在执行，请结束后修改设置');
        const before=settings.rpcHttp+'|'+settings.rpcWs,result=updateSettings(fields);
        if(before!==settings.rpcHttp+'|'+settings.rpcWs){market.stop();provider.destroy();provider=makeProvider();market=new MarketData(provider,settings.rpcWs);jobs.provider=provider;jobs.expired.provider=provider;portfolio.provider=provider;portfolio.cache.clear();if(process.env.MARKET_ENABLED!=='0')market.start();}
        return json(res,200,result);}
    }
    json(res,404,{error:'not_found'});
  }catch(error){json(res,400,{error:String(error.message||'请求失败').replace(/https?:\/\/\S+/g,'[endpoint]')});}
});
if(process.env.WORKER_MODE==='1'){if(workerToken.length<32)throw Error('钱包节点缺少连接密钥');settings.liveTrading=process.env.LIVE_TRADE==='1';
  const ws=http.createServer(worker),path=process.env.AGENT_WORKER_SOCKET;
  if(path){if(!/^\/run\/agent-wallet-[a-z0-9_-]+\/worker\.sock$/.test(path))throw Error('Invalid worker socket');
    if(existsSync(path))unlinkSync(path);ws.listen(path,()=>{chmodSync(path,0o660);console.log('Wallet worker socket ready');});
  }else ws.listen(Number(process.env.AGENT_WORKER_PORT||4330),process.env.AGENT_WORKER_HOST||'127.0.0.1',()=>console.log('Wallet worker ready'));
}else server.listen(port,host,()=>console.log(`Agent ID Community ready on local port ${port}`));
if(process.env.WORKER_MODE!=='1'&&process.env.MARKET_ENABLED!=='0')market.start();
migrations.start();
