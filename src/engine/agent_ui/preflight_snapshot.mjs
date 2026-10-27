// A queue-owned snapshot can remove duplicate CLI calls within one user order.
// Expired, malformed or wrong-wallet snapshots always use live wallet queries.
export async function walletSnapshot(cli,wallet,environment=process.env,now=Date.now()){
  let s;try{s=JSON.parse(environment.AGENT_PREFLIGHT_SNAPSHOT||'null');}catch{}
  if(s&&s.chainId===56&&String(s.wallet).toLowerCase()===wallet.toLowerCase()&&
      Number.isSafeInteger(s.checkedAt)&&now>=s.checkedAt&&now-s.checkedAt<=5000&&
      s.status?.status==='CONNECTED'&&s.agent?.claimed===true&&s.settings?.tradeAllTokens===true&&
      s.addresses?.addresses?.some(a=>String(a.binanceChainId)==='56'&&String(a.address).toLowerCase()===wallet.toLowerCase())&&
      s.settings.devMode?.enabled&&!s.settings.devMode.balanceExceeded&&
      Date.parse(s.settings.devMode.expiresAt)>now+120000&&Date.parse(s.settings.sessionExpireTime)>now+120000)
    return [s.status,s.settings,s.addresses,s.agent];
  return Promise.all([cli(['wallet','status']),cli(['wallet','settings']),cli(['wallet','address']),cli(['wallet','agent-id'])]);
}
