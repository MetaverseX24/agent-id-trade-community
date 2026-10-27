import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {networkEnvironment} from '../src/engine/network_env.mjs';
const mode=process.argv[2];
if(!['--live','--worker','--quote'].includes(mode))throw Error('请选择 --live、--worker 或 --quote');
const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
  env:networkEnvironment({...process.env,LIVE_TRADE:mode==='--quote'?'0':'1',...(mode==='--worker'?{WORKER_MODE:'1'}:{})}),stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exitCode=code??1);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
