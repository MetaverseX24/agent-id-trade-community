import { getAddress, keccak256 } from 'ethers';

const same = (a, b) => getAddress(a) === getAddress(b);

// An approval completed before the trade preview is safe to retry. Verify the
// exact recorded transaction on chain; never reuse an uncertain sell attempt.
export async function canRetryAfterApproval(provider, prior, wallet) {
  if (prior?.stage !== 'approve_confirmed' || prior.step !== 'approve' ||
      !/^0x[0-9a-fA-F]{64}$/.test(prior.txHash || '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(prior.inputHash || '') ||
      !Number.isSafeInteger(prior.fromBlock) || prior.fromBlock < 0 ||
      !/^\d+$/.test(String(prior.value)) || !prior.to) return false;
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(prior.txHash),
    provider.getTransactionReceipt(prior.txHash),
  ]);
  return !!tx && !!receipt && !!tx.to && tx.chainId === 56n &&
    tx.blockNumber !== null && tx.blockNumber >= prior.fromBlock &&
    receipt.status === 1 && receipt.blockNumber >= prior.fromBlock &&
    same(tx.from, wallet) && same(tx.to, prior.to) &&
    tx.value === BigInt(prior.value) && keccak256(tx.data) === prior.inputHash;
}

// A Binance App double-confirm request expires after 5 minutes (official CLI).
// Time alone never clears an order: verify wallet identity, SDK lock, complete
// history and both nonces; unknown broadcast submissions remain blocked.
export async function reconcileRecordedCall(provider,prior,wallet,cli,now=Date.now()){
  if(!prior?.to||!/^0x[0-9a-f]{64}$/i.test(prior.inputHash||'')||!Number.isSafeInteger(prior.fromBlock)||
    !Number.isSafeInteger(prior.startedMs)||prior.startedMs<=0)return {kind:'unresolved'};
  const value=BigInt(prior.value??prior.valueWei??0),hashes=new Set(prior.txHash?[prior.txHash]:[]);let complete=false;
  const appPending=!prior.txHash&&prior.orderId&&String(prior.stage).endsWith('app_confirmation_pending');
  if(!hashes.size){
    const address=await cli(['wallet','address']);
    if(!address.addresses?.some(a=>String(a.binanceChainId)==='56'&&same(a.address,wallet)))return {kind:'unresolved'};
    let cursor;for(let page=0;page<5;page++){
      const h=await cli(['wallet','tx-history','--type','all','--size','100','--startTime',String(prior.startedMs-60000),'--binanceChainId','56',...(cursor?['--nextCursor',cursor]:[])]);
      if(!Array.isArray(h.transactions))return {kind:'unresolved'};
      for(const t of h.transactions||[])if(/^0x[0-9a-f]{64}$/i.test(t.txHash||''))hashes.add(t.txHash);
      if(h.hasMore===false||(!h.nextCursor&&h.hasMore!==true)){complete=true;break;}if(!h.nextCursor)break;cursor=h.nextCursor;
    }
  }
  for(const hash of hashes){const [tx,receipt]=await Promise.all([provider.getTransaction(hash),provider.getTransactionReceipt(hash)]);
    if(!tx||!receipt||!tx.to||tx.chainId!==56n||!same(tx.from,wallet)||!same(tx.to,prior.to)||tx.value!==value||
      keccak256(tx.data)!==prior.inputHash||receipt.blockNumber<prior.fromBlock)continue;
    return {kind:receipt.status===1?'confirmed':'reverted',txHash:hash,receipt};
  }
  if(appPending&&complete&&now-prior.startedMs>=330000){
    const [latest,pending,lock]=await Promise.all([provider.getTransactionCount(wallet,'latest'),provider.getTransactionCount(wallet,'pending'),
      cli(['wallet','tx-lock','--binanceChainId','56'])]);
    if(Number.isSafeInteger(latest)&&latest>=0&&latest===pending&&lock.status==='UNLOCKED')return {kind:'confirmation_closed',checkedUtc:new Date(now).toISOString(),nonce:latest,orderId:String(prior.orderId)};
  }
  return {kind:'unresolved'};
}

// A completed trade whose settlement still needs attention must never be
// treated as an unsubmitted trade, even when its last App request expired.
export function expiredCallMayRetry(state){return !state?.settlement?.saleTxHash&&!state?.quoteFunding?.buyTxHash;}
