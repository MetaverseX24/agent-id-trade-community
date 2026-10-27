// Reviewed local bootstrap: uses the installed Node/npm, pinned lockfile and
// disabled dependency lifecycle scripts. Never changes system permissions.
import {spawn,execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {networkEnvironment} from '../src/engine/network_env.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
async function run(file,args,options={}){return new Promise((resolve,reject)=>{
  const p=spawn(file,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});p.on('error',reject);
  p.on('close',code=>code===0?resolve():reject(Error(`命令执行失败（${code}），请保留窗口中的错误信息。`)));
});}
function npmCli(){const near=dirname(process.execPath),candidates=[process.env.npm_execpath,
  join(near,'node_modules/npm/bin/npm-cli.js'),join(near,'../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  if(!candidates.some(existsSync)){try{const paths=execFileSync(process.platform==='win32'?'where.exe':'which',
    [process.platform==='win32'?'npm.cmd':'npm'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);
    for(const p of paths)candidates.push(process.platform==='win32'?join(dirname(p),'node_modules/npm/bin/npm-cli.js'):realpathSync(p));}catch{}}
  const cli=candidates.find(p=>existsSync(p)&&/npm(?:-cli)?\.(?:js|cjs)$/.test(p));
  if(!cli)throw Error('没有找到 npm，请从 https://nodejs.org/ 安装完整的 Node.js LTS。');return cli;
}
async function main(){
  if(Number(process.versions.node.split('.')[0])<22)throw Error('需要 Node.js 22 或更新版本。请从 https://nodejs.org/ 安装 LTS，再重新启动。');
  const flags=process.argv.slice(2);if(flags.some(f=>!['--check','--no-open'].includes(f)))throw Error('不支持的启动选项');
  const data=join(root,'data');mkdirSync(data,{recursive:true,mode:0o700});
  const marker=join(data,'installed-lock.sha256'),fingerprint=createHash('sha256').update(readFileSync(join(root,'package-lock.json'))).digest('hex');
  const files=['@binance/agentic-wallet/dist/index.js','ethers/package.json','qrcode/package.json'];
  const installed=files.every(f=>existsSync(join(root,'node_modules',f)))&&existsSync(marker)&&readFileSync(marker,'utf8')===fingerprint;
  if(!installed){console.log('正在安装锁定版本的依赖，首次启动需要联网…');
    await run(process.execPath,[npmCli(),'ci','--ignore-scripts','--no-audit','--no-fund']);
    if(!files.every(f=>existsSync(join(root,'node_modules',f))))throw Error('依赖不完整，安装未完成。');
    writeFileSync(marker,fingerprint,{mode:0o600});
  }
  await run(process.execPath,[join(root,'node_modules/@binance/agentic-wallet/dist/index.js'),'--version'],
    {env:networkEnvironment({...process.env,BINANCE_BAW_DIR:join(data,'wallets','primary','baw')})});
  console.log('运行环境与钱包组件检查通过。不会要求助记词或私钥。');
  if(flags.includes('--check'))return;
  console.log('请打开终端输出的网址，扫码连接钱包。首次默认为仅报价；真实交易需在网页设置中明确开启。');
  const child=spawn(process.execPath,[join(root,'src/server.mjs')],{cwd:root,env:networkEnvironment({...process.env,LIVE_TRADE:'1'}),
    stdio:['inherit','pipe','inherit'],windowsHide:true});let opened=false;
  child.stdout.on('data',chunk=>{process.stdout.write(chunk);const match=String(chunk).match(/ready on local port (\d+)/);
    if(match&&!opened){opened=true;const url='http://127.0.0.1:'+match[1];console.log('网页地址：'+url);
      if(!flags.includes('--no-open')){
        const command=process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:
          process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
        const browser=spawn(command[0],command[1],{stdio:'ignore',windowsHide:true});browser.on('error',()=>console.log('请手动打开上面的网页地址。'));browser.unref();
      }
    }});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('服务已退出；端口被占用或启动失败时，请查看上方提示。')));});
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
