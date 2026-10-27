import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mode=process.argv[2];
if(!['--live','--worker'].includes(mode))throw Error('请选择 --live 或 --worker');
const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
  env:{...process.env,LIVE_TRADE:'1',...(mode==='--worker'?{WORKER_MODE:'1'}:{})},stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exitCode=code??1);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
