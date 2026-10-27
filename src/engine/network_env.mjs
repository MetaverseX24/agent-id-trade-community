import {execFileSync} from 'node:child_process';
let windowsProxy;
function systemProxy(){if(windowsProxy!==undefined)return windowsProxy;
  windowsProxy='';try{
    const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enabled=execFileSync('reg.exe',['query',key,'/v','ProxyEnable'],{encoding:'utf8',windowsHide:true,timeout:3000});
    if(!/REG_DWORD\s+0x1\b/.test(enabled))return '';
    const raw=execFileSync('reg.exe',['query',key,'/v','ProxyServer'],{encoding:'utf8',windowsHide:true,timeout:3000}).match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
    if(!raw)return '';
    const entries=Object.fromEntries(raw.split(';').filter(x=>x.includes('=')).map(x=>x.split('=',2)));
    const endpoint=entries.https||entries.http||(!raw.includes('=')?raw:'');if(!endpoint)return '';
    const u=new URL(endpoint.includes('://')?endpoint:'http://'+endpoint);
    if(['http:','https:'].includes(u.protocol))windowsProxy=u.href;
  }catch{/* System proxy discovery is optional; explicit environment wins. */}
  return windowsProxy;
}
export function networkEnvironment(input=process.env,{platform=process.platform,readSystem=systemProxy,supportsProxy=process.allowedNodeEnvironmentFlags.has('--use-env-proxy')}={}){
  const env={...input};let proxy=env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy;
  if(!proxy&&platform==='win32')proxy=readSystem();
  if(proxy){
    if(!supportsProxy)throw Error('当前 Node.js 不支持环境代理；请升级到 Node.js 官网最新 LTS。');
    if(!env.HTTPS_PROXY&&!env.https_proxy)env.HTTPS_PROXY=proxy;
    if(!env.HTTP_PROXY&&!env.http_proxy)env.HTTP_PROXY=proxy;
    if(!env.NO_PROXY&&!env.no_proxy)env.NO_PROXY='localhost,127.0.0.1,::1';
    if(!String(env.NODE_OPTIONS||'').includes('--use-env-proxy'))env.NODE_OPTIONS=(env.NODE_OPTIONS?env.NODE_OPTIONS+' ':'')+'--use-env-proxy';
  }
  return env;
}
