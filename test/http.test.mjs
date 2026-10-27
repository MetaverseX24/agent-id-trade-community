import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('local interface rejects other origins and hides deployment secrets',async()=>{
  const port=19473,child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
    env:{...process.env,PORT:String(port),DATA_DIR:mkdtempSync(join(tmpdir(),'agent-http-')),MARKET_ENABLED:'0',LIVE_TRADE:'0',AGENT_API_TOKEN:'test-secret-only'},
    stdio:'ignore',windowsHide:true});
  try{let ready=false;for(let n=0;n<50;n++){try{if((await fetch(`http://127.0.0.1:${port}`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    assert(ready);const base=`http://127.0.0.1:${port}`,html=await (await fetch(base)).text();
    assert(!html.includes('test-secret-only'));const csrf=html.match(/name="agent-csrf" content="([^"]+)/)[1];
    assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body:'{}'})).status,403);
    const response=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Agent-CSRF':csrf},body:JSON.stringify({maxBuyBNB:'0.2'})});
    assert.equal(response.status,200);assert.equal((await response.json()).maxBuyBNB,'0.2');
    assert.equal((await fetch(base+'/api/settings',{headers:{Origin:'https://evil.invalid'}})).status,403);
    const data=await(await fetch(base+'/api/settings')).json();assert.equal(data.liveTrading,false);
  }finally{child.kill();if(child.exitCode===null)await new Promise(r=>child.once('close',r));}
});
