// Operator-only setup. The web service never receives Docker access.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const flags=Object.fromEntries(process.argv.slice(2).map(x=>x.replace(/^--/,'').split(/=(.*)/s).slice(0,2)));
const id=flags.id||'wallet2',port=Number(flags.port||4332),label=flags.label||id;
if(!/^[a-z][a-z0-9_-]{0,24}$/.test(id)||id==='primary'||port<1024||port>65535||!Number.isInteger(port))throw Error('钱包标识或端口无效');
const data=resolve(flags.data||process.env.DATA_DIR||join(root,'data'));
const profiles=resolve(flags.profiles||join(data,'wallet-profiles.json'));
mkdirSync(data,{recursive:true,mode:0o700});mkdirSync(dirname(profiles),{recursive:true,mode:0o700});
let records=[];try{records=JSON.parse(readFileSync(profiles,'utf8'));}catch{}
if(records.some(x=>x.id===id)||records.length>=9)throw Error('钱包标识重复或已达十个钱包');
const envFile=join(data,`${id}.worker.secret`);
if(existsSync(envFile))throw Error('已有钱包准备文件，请检查原节点，不要重复创建');
const token=randomBytes(32).toString('base64url'),name=`agent-id-${id}`,image='agent-id-community:local';
const plan={wallet:id,label,container:name,listen:`127.0.0.1:${port}`,isolatedSession:true,
  network:'独立容器网络，不共享其他钱包的会话',resources:'384 MB RAM / 0.75 CPU',secretFile:envFile};
if(flags.prepare==='true'){console.log(JSON.stringify(plan,null,2));process.exit(0);}
writeFileSync(envFile,[`AGENT_WORKER_TOKEN=${token}`,'WORKER_MODE=1','LIVE_TRADE=1',
  'AGENT_WORKER_HOST=0.0.0.0','AGENT_WORKER_PORT=4330','MARKET_ENABLED=0',
  'DATA_DIR=/app/data',`BINANCE_INSTANCE_ID=${randomBytes(16).toString('hex')}`,''].join('\n'),{mode:0o600});
const docker=args=>execFileSync('docker',args,{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
try{docker(['image','inspect',image]);}catch{docker(['build','--tag',image,'.']);}
docker(['volume','create',`${name}-data`]);
docker(['run','--detach','--name',name,'--restart','unless-stopped','--read-only','--cap-drop=ALL',
  '--security-opt=no-new-privileges:true','--memory=384m','--cpus=0.75','--pids-limit=128',
  '--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--publish',`127.0.0.1:${port}:4330`,
  '--volume',`${name}-data:/app/data`,'--env-file',envFile,image]);
let ready=false;for(let n=0;n<30;n++){
  try{const r=await fetch(`http://127.0.0.1:${port}/worker/status`,{headers:{'X-Agent-Worker':token},signal:AbortSignal.timeout(2000)});
    if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
if(!ready)throw Error('节点未就绪；保留原节点供排查，不自动创建第二个节点');
records.push({id,label,endpoint:`http://127.0.0.1:${port}`,token,address:null});
writeFileSync(profiles+'.tmp',JSON.stringify(records,null,2),{mode:0o600});renameSync(profiles+'.tmp',profiles);
console.log(JSON.stringify({...plan,secretFile:undefined,next:'重启没有执行中订单的主界面服务，然后在钱包列表点击扫码登录'},null,2));
