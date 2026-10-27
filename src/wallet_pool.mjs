import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAddress } from 'ethers';
import { baw } from './engine/wallet_cli.mjs';
import http from 'node:http';
import QRCode from 'qrcode';

const deadline = value => /^\d{13}$/.test(String(value || '')) ? Number(value) : Date.parse(value);
const same = (a,b) => String(a||'').toLowerCase() === String(b||'').toLowerCase();
const validId = id => /^[a-z][a-z0-9_-]{0,30}$/.test(id || '');
function loginURL(raw){const url=new URL(raw);
  const official=(url.hostname==='app.binance.com'&&url.pathname.startsWith('/uni-qr/'))||
    (url.hostname==='web3.binance.com'&&/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/agent-login$/i.test(url.pathname));
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!official)
    throw Error('invalid_binance_login_response');return url;}
async function withQR(login){if(!login?.url)return login;const url=loginURL(login.url),payload=login.url;
  const web=url.hostname==='app.binance.com'?'https://web3.binance.com/zh-CN/agent-login?_ul='+
    encodeURIComponent(Buffer.from(payload).toString('base64'))+'&expireAt='+Number(login.expiresAt):payload;
  return {...login,url:web,qrDataUrl:login.qrDataUrl||await QRCode.toDataURL(payload,{width:260,margin:2,errorCorrectionLevel:'M'})};}

export class WalletPool {
  constructor({ file, primaryAddress, primaryLabel = '钱包 1', cli = baw }) {
    this.file=file; this.cli=cli; this.primaryAddress=primaryAddress;
    this.cache=new Map(); this.logins=new Map(); this.pending=new Map();
    this.facts=new Map();
    this.pairingPending=new Map();
    try { this.records=JSON.parse(readFileSync(file,'utf8')); } catch { this.records=[]; }
    this.records=this.records.filter(x=>validId(x.id) && x.id!=='primary' && x.endpoint && x.token);
    this.primary={id:'primary',label:primaryLabel,address:primaryAddress,local:true};
  }
  save() {
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    writeFileSync(this.file+'.tmp',JSON.stringify(this.records),{mode:0o600});
    renameSync(this.file+'.tmp',this.file);
  }
  get(id) {
    const found=id==='primary'?this.primary:this.records.find(x=>x.id===id);
    if(!found) throw Error('wallet_profile_not_found');
    return found;
  }
  add({id,label,endpoint,token,address}) {
    if(!validId(id)||id==='primary'||this.records.some(x=>x.id===id)||this.records.length>=9)
      throw Error('invalid_wallet_profile');
    const url=new URL(endpoint);
    const unix=url.protocol==='unix:'&&/^\/run\/agent-wallet-[a-z0-9_-]+\/worker\.sock$/.test(url.pathname)&&!url.host;
    if(url.username||url.password||url.search||url.hash||
      !(unix || url.protocol==='https:' || (url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))))
      throw Error('wallet_worker_requires_https_or_localhost');
    if(!/^[A-Za-z0-9_-]{32,128}$/.test(token||'')) throw Error('invalid_worker_token');
    const row={id,label:String(label||id).slice(0,40),endpoint:unix?url.href:url.origin,token,
      address:address?getAddress(address):null};
    this.records.push(row);this.save();return {id,label:row.label};
  }
  async request(profile,path,fields) {
    if(profile.endpoint.startsWith('unix:'))return new Promise((resolve,reject)=>{
      const req=http.request({socketPath:new URL(profile.endpoint).pathname,path,method:fields?'POST':'GET',
        headers:{'X-Agent-Worker':profile.token,...(fields?{'Content-Type':'application/json'}:{})}},res=>{
        let raw='';res.on('data',x=>{raw+=x;if(raw.length>2_000_000)req.destroy(Error('worker_response_too_large'));});
        res.on('end',()=>{try{const data=JSON.parse(raw);res.statusCode>=400?reject(Error(data.error||'worker_error')):resolve(data);}catch{reject(Error('worker_invalid_response'));}});
      });req.on('error',reject);req.setTimeout(40_000,()=>req.destroy(Error('worker_timeout')));req.end(fields?JSON.stringify(fields):undefined);
    });
    const response=await fetch(profile.endpoint+path,{method:fields?'POST':'GET',
      headers:{'X-Agent-Worker':profile.token,...(fields?{'Content-Type':'application/json'}:{})},
      ...(fields?{body:JSON.stringify(fields)}:{}),redirect:'error',signal:AbortSignal.timeout(40_000)});
    const data=await response.json();
    if(!response.ok) throw Error(data.error||'wallet_worker_request_failed');
    return data;
  }
  async status(id='primary',force=false) {
    const profile=this.get(id), cached=this.cache.get(id);
    if(!force&&cached&&Date.now()-cached.at<10_000) return cached.value;
    if(this.pending.has(id)) return this.pending.get(id);
    const work=(async()=>{
      let value;
      try {
        if(!profile.local) {
          const remote=await this.request(profile,'/worker/status');
          value={...remote,id,label:profile.label,local:false,...(remote.login?{login:await withQR(remote.login)}:{})};
          const primary=this.primary.address||this.cache.get('primary')?.value?.address;
          if(primary&&same(primary,remote.address))value={...value,ready:false,error:'wallet_duplicate_address'};
          if(profile.address && !same(profile.address,remote.address))
            value={...value,ready:false,error:'wallet_identity_mismatch'};
        } else {
          const status=await this.cli(['wallet','status']);
          value={id,label:profile.label,local:true,status:status.status,ready:false};
          if(status.status==='CONNECTED') {
            const [address,settings,agent,lock]=await Promise.all([
              this.cli(['wallet','address']),this.cli(['wallet','settings']),
              this.cli(['wallet','agent-id']),this.cli(['wallet','tx-lock','--binanceChainId','56']).catch(()=>({status:'UNKNOWN'})),
            ]);
            const actual=address.addresses?.find(x=>String(x.binanceChainId)==='56')?.address;
            this.facts.set(id,{chainId:56,wallet:actual,checkedAt:Date.now(),status,
              addresses:{addresses:(address.addresses||[]).filter(a=>String(a.binanceChainId)==='56').map(a=>({binanceChainId:'56',address:a.address}))},
              agent:{claimed:agent.claimed===true},settings:{devMode:settings.devMode,tradeAllTokens:settings.tradeAllTokens,sessionExpireTime:settings.sessionExpireTime}});
            const identity=!!actual&&(!profile.address||same(actual,profile.address));
            const dev=!!settings.devMode?.enabled&&!settings.devMode.balanceExceeded&&deadline(settings.devMode.expiresAt)>Date.now()+120_000;
            const session=deadline(settings.sessionExpireTime)>Date.now()+120_000;
            value={...value,address:actual,agentId:agent.agentId||null,claimed:!!agent.claimed,
              developerMode:dev,tradeAllTokens:settings.tradeAllTokens===true,
              expiresAt:settings.sessionExpireTime,lock:lock.status,
              ready:identity&&dev&&session&&agent.claimed&&settings.tradeAllTokens===true&&lock.status!=='LOCKED',
              error:!identity?'wallet_identity_mismatch':!session?'wallet_session_expired':
                !dev?'developer_mode_unavailable':!agent.claimed?'agent_id_required':
                !settings.tradeAllTokens?'trade_all_tokens_disabled':lock.status==='LOCKED'?'wallet_app_confirmation_pending':null};
          }
        }
      } catch { value={id,label:profile.label,local:!!profile.local,status:'UNAVAILABLE',ready:false,error:'wallet_status_unavailable'}; }
      if(value.status==='CONNECTED'){delete value.login;this.logins.delete(id);}
      const login=this.logins.get(id);
      if(login&&login.expiresAt>Date.now()) value.login={...login};
      this.cache.set(id,{at:Date.now(),value});return value;
    })().finally(()=>this.pending.delete(id));
    this.pending.set(id,work);return work;
  }
  async list() { const values=await Promise.all([this.primary,...this.records].map(p=>this.status(p.id)));
    const seen=new Set();for(const value of values){if(!value.address)continue;const address=value.address.toLowerCase();
      if(seen.has(address)){value.ready=false;value.error='wallet_duplicate_address';}else seen.add(address);}
    return values;
  }
  signIn(id='primary') {if(this.pairingPending.has(id))return this.pairingPending.get(id);
    const work=this.signInOnce(id).finally(()=>this.pairingPending.delete(id));this.pairingPending.set(id,work);return work;}
  async signInOnce(id='primary') {
    const profile=this.get(id);
    if(!profile.local) return withQR(await this.request(profile,'/worker/login',{}));
    const old=this.logins.get(id);
    if(old?.state==='waiting'&&old.expiresAt>Date.now()) return old;
    const result=await this.cli(['auth','signin']);
    if(['ALREADY_CONNECTED','CONNECTED'].includes(result.status)) { this.cache.delete(id);return {alreadyConnected:true}; }
    loginURL(result.urlForWeb);
    if(!/^[a-z0-9]{6}$/i.test(String(result.pairingCode||''))||!result.qrCodeId)
      throw Error('invalid_binance_login_response');
    const login=await withQR({url:result.urlForWeb,code:result.pairingCode,expiresAt:Number(result.expireAt),state:'waiting'});
    if(!(login.expiresAt>Date.now()&&login.expiresAt<Date.now()+600_000)) throw Error('invalid_login_expiry');
    this.logins.set(id,login);this.cache.delete(id);
    this.cli(['auth','verify','--qrCodeId',result.qrCodeId],330_000)
      .then(async()=>{login.state='verified';this.cache.delete(id);const s=await this.status(id,true);
        login.state=s.status==='CONNECTED'&&!s.error?'connected':s.error||'not_ready';})
      .catch(()=>{login.state='expired_or_rejected';this.cache.delete(id);});
    return login;
  }
}
