import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT=fileURLToPath(new URL('../',import.meta.url));
try{for(const line of readFileSync(join(ROOT,'.env'),'utf8').split(/\r?\n/)){
  const m=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}}catch{}
export const DATA=resolve(process.env.DATA_DIR||join(ROOT,'data'));
mkdirSync(DATA,{recursive:true,mode:0o700});
export function readData(name,fallback){try{return JSON.parse(readFileSync(join(DATA,name),'utf8'));}catch{return fallback;}}
export function writeData(name,value){const target=join(DATA,name);writeFileSync(target+'.tmp',JSON.stringify(value,null,2),{mode:0o600});renameSync(target+'.tmp',target);}
export function validateRpc(raw){if(!raw)return '';const u=new URL(raw);
  if(u.username||u.password||!['https:','wss:'].includes(u.protocol))throw Error('RPC 仅接受 HTTPS 或 WSS 地址');
  const host=u.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.local')||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))throw Error('请使用公网 RPC 地址');
  return u.toString();}
const defaults={rpcHttp:process.env.BSC_RPC_HTTP||'',rpcWs:process.env.BSC_RPC_WSS||'',
  maxBuyBNB:'0.3',gasReserveBNB:'0.005',slippageBps:3000,liveTrading:false};
export const settings={...defaults,...readData('settings.json',{})};
if(process.env.LIVE_TRADE!=='1')settings.liveTrading=false;
export const apiToken=process.env.AGENT_API_TOKEN||(()=>{let data=readData('api-token.json',null);if(!data){data={token:randomBytes(32).toString('base64url')};writeData('api-token.json',data);}return data.token;})();
export function publicSettings(){return {maxBuyBNB:settings.maxBuyBNB,gasReserveBNB:settings.gasReserveBNB,
  slippageBps:settings.slippageBps,liveTrading:settings.liveTrading,liveAllowed:process.env.LIVE_TRADE==='1',
  rpcConfigured:!!settings.rpcHttp,rpcWsConfigured:!!settings.rpcWs,
  rpcLabel:settings.rpcHttp?'自定义 RPC':'公共 RPC'};}
export function updateSettings(input){const next={...settings};
  if(input.rpcHttp!==undefined){next.rpcHttp=validateRpc(input.rpcHttp);if(next.rpcHttp&&!next.rpcHttp.startsWith('https:'))throw Error('HTTP RPC 必须是 HTTPS');}
  if(input.rpcWs!==undefined){next.rpcWs=validateRpc(input.rpcWs);if(next.rpcWs&&!next.rpcWs.startsWith('wss:'))throw Error('WebSocket RPC 必须是 WSS');}
  for(const field of ['maxBuyBNB','gasReserveBNB'])if(input[field]!==undefined){
    const s=String(input[field]);if(!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(s)||+s<0||+s>10||(field==='maxBuyBNB'&&+s===0))throw Error('BNB 限额无效');next[field]=s;}
  if(input.slippageBps!==undefined){if(!Number.isInteger(input.slippageBps)||input.slippageBps<1||input.slippageBps>5000)throw Error('滑点范围 0.01%–50%');next.slippageBps=input.slippageBps;}
  if(input.liveTrading!==undefined){if(input.liveTrading&&process.env.LIVE_TRADE!=='1')throw Error('请用 npm run live 启动后启用真实交易');
    if(input.liveTrading&&input.confirmation!=='ENABLE LIVE')throw Error('启用真实交易需要输入 ENABLE LIVE');next.liveTrading=input.liveTrading===true;}
  Object.assign(settings,next);writeData('settings.json',settings);return publicSettings();
}
