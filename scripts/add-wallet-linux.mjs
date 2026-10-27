// Linux/systemd alternative: no Docker, host port, IP forwarding, or firewall changes.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chownSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if(process.platform!=='linux'||process.getuid()!==0)throw Error('请由 Linux 管理员运行此安装器');
if(!existsSync('/run/systemd/system')||!existsSync('/sys/fs/cgroup/cgroup.controllers'))throw Error('需要正常运行的 systemd 和已挂载的 cgroup v2，请先修复服务器配置');
const args=Object.fromEntries(process.argv.slice(2).map(x=>x.replace(/^--/,'').split(/=(.*)/s).slice(0,2)));
const id=args.id||'wallet2',group=args.group,owner=args.owner;
if(!/^[a-z][a-z0-9_-]{0,20}$/.test(id)||id==='primary'||![group,owner].every(x=>/^[a-z][a-z0-9_-]{0,30}$/.test(x||'')))throw Error('请明确指定 --id、--owner 和 --group');
const root=resolve(args.project||fileURLToPath(new URL('../',import.meta.url))),node=process.execPath;
if(!/^\/[A-Za-z0-9_./-]+$/.test(root)||!/^\/[A-Za-z0-9_./-]+$/.test(node))throw Error('项目路径不支持空格或特殊字符');
const run=(cmd,argv)=>execFileSync(cmd,argv,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const base=`agent-wallet-${id}`,user=`aw-${id}`,state=`/var/lib/${base}`,runtime=`/run/${base}`;
const profiles=resolve(args.profiles||'/var/lib/agent-id-terminal/wallet-profiles.json');
let records=[];try{records=JSON.parse(readFileSync(profiles,'utf8'));}catch{}
if(records.some(x=>x.id===id)||existsSync(`/etc/systemd/system/${base}.service`))throw Error('已有同名钱包，请核对原服务，禁止重复安装');
const uid=Number(run('id',['-u',owner])),gid=Number(run('getent',['group',group]).split(':')[2]);
if(!Number.isInteger(uid)||!Number.isInteger(gid))throw Error('服务用户/组不存在');
const privateMode=args.private==='true',app=privateMode?`${root}/agent_ui/app.mjs`:`${root}/src/server.mjs`;
if(!existsSync(app))throw Error('项目文件不存在');
// Ubuntu archive package only. No third-party installer is executed.
try{run('slirp4netns',['--version']);}catch{run('apt-get',['install','--yes','--no-install-recommends','slirp4netns']);}
try{run('id',['-u',user]);}catch{run('useradd',['--system','--home-dir',state,'--shell','/usr/sbin/nologin','--gid',group,user]);}
mkdirSync(state,{recursive:true,mode:0o700});chownSync(state,Number(run('id',['-u',user])),gid);
const token=randomBytes(32).toString('base64url'),envFile=`/etc/${base}.env`;
if(!privateMode){const settingsFile=`${state}/settings.json`;
  if(!existsSync(settingsFile)){writeFileSync(settingsFile,JSON.stringify({maxBuyBNB:'0.3',gasReserveBNB:args.reserve||'0.005',slippageBps:2000,liveTrading:true}),{mode:0o600});chownSync(settingsFile,Number(run('id',['-u',user])),gid);}}
const mac='02:'+randomBytes(5).toString('hex').match(/../g).join(':');
const env=[`AGENT_WORKER_TOKEN=${token}`,`AGENT_WORKER_SOCKET=${runtime}/worker.sock`,
  `AGENT_WALLET_PROFILES=${state}/peers.json`,`AGENT_TRADE_JOBS=${state}/jobs.json`,
  `AGENT_TRADE_STATE_DIR=${state}/orders`,`OPENFOUR_MANUAL_STATE_DIR=${state}/four-orders`,
  `OPENFOUR_BASELINE_STATE=${state}/protocol-baseline.json`,`BINANCE_BAW_DIR=${state}/baw`,
  `BINANCE_INSTANCE_ID=${randomBytes(16).toString('hex')}`,`BAW_CLI=${root}/node_modules/@binance/agentic-wallet/dist/index.js`,
  `DATA_DIR=${state}`,'AGENT_WORKER_ONLY=1','WORKER_MODE=1','LIVE_TRADE=1','MARKET_ENABLED=0',
  'BSC_RPC_HTTP=https://bsc-rpc.publicnode.com','AGENT_TRADE_SOCKET=none','AGENT_TRADE_INTERNAL_SOCKET=none',''];
writeFileSync(envFile,env.join('\n'),{mode:0o600});
writeFileSync(`${state}/resolv.conf`,'nameserver 10.0.2.3\n',{mode:0o644});
mkdirSync(`/etc/netns/${base}`,{recursive:true,mode:0o755});writeFileSync(`/etc/netns/${base}/resolv.conf`,'nameserver 10.0.2.3\n',{mode:0o644});
const unit=(name,text)=>writeFileSync(`/etc/systemd/system/${name}.service`,text,{mode:0o644});
unit(`${base}-namespace`,`[Unit]\nDescription=Isolated network for ${id}\nBefore=${base}-network.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/ip netns add ${base}\nExecStop=/usr/sbin/ip netns delete ${base}\n[Install]\nWantedBy=multi-user.target\n`);
unit(`${base}-network`,`[Unit]\nDescription=Outbound networking for ${id}\nRequires=${base}-namespace.service\nAfter=${base}-namespace.service network-online.target\n[Service]\nExecStart=/usr/bin/slirp4netns --netns-type=path --configure --disable-host-loopback --enable-sandbox --enable-seccomp /run/netns/${base} tap0\nExecStartPost=/bin/sh -c 'n=0; until /usr/sbin/ip -n ${base} link show tap0 >/dev/null 2>&1; do n=$$((n+1)); [ $$n -gt 50 ] && exit 1; sleep 0.1; done; /usr/sbin/ip -n ${base} link set tap0 address ${mac}'\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n`);
const writable=privateMode?`ReadWritePaths=${state} ${runtime}\n`:'';
unit(base,`[Unit]\nDescription=Independent Agentic Wallet ${id}\nRequires=${base}-network.service\nAfter=${base}-network.service\n[Service]\nUser=${user}\nGroup=${group}\nNetworkNamespacePath=/run/netns/${base}\nWorkingDirectory=${root}\nEnvironmentFile=${envFile}\nExecStartPre=/bin/sleep 1\nExecStart=${node} ${app}\nStateDirectory=${base}\nStateDirectoryMode=0700\nRuntimeDirectory=${base}\nRuntimeDirectoryMode=0750\nBindReadOnlyPaths=${state}/resolv.conf:/etc/resolv.conf\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nRestrictSUIDSGID=yes\nMemoryMax=384M\nCPUQuota=75%\nUMask=0077\n${writable}Restart=on-failure\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n`);
run('systemctl',['daemon-reload']);run('systemctl',['enable','--now',`${base}.service`]);
records.push({id,label:args.label||id,endpoint:`unix://${runtime}/worker.sock`,token,address:null});
const existed=existsSync(dirname(profiles));mkdirSync(dirname(profiles),{recursive:true,mode:0o700});if(!existed)chownSync(dirname(profiles),uid,gid);
writeFileSync(profiles+'.tmp',JSON.stringify(records,null,2),{mode:0o600});chownSync(profiles+'.tmp',uid,gid);renameSync(profiles+'.tmp',profiles);
console.log(JSON.stringify({id,service:`${base}.service`,socket:runtime+'/worker.sock',next:'在主界面刷新钱包配置后扫码登录',docker:false,firewallChanged:false}));
