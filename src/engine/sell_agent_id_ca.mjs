// One explicit sell action for an Agent ID inner-market token. No background loop.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, Interface, formatEther, getAddress, keccak256 } from 'ethers';
import { FailoverRpcProvider } from './rpc_failover.mjs';
import { preflight } from './buy_agent_id_ca.mjs';
import { baw, previewDiagnostics, submitContractCall } from './wallet_cli.mjs';
import { waitForBrowserApproval } from './agent_ui/approval_gate.mjs';
import {prepareSaleSettlement,recordSaleReceipt,recordNativeReceipt,settleSaleToBNB} from './agent_ui/sale_settlement.mjs';
import {reconcileRecordedCall,expiredCallMayRetry} from './agent_ui/recovery.mjs';

const CORE = getAddress('0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3');
const WALLET = getAddress(process.env.AGENT_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000');
const STATE_DIR = process.env.OPENFOUR_MANUAL_STATE_DIR || './data/manual';
const ERC20 = new Interface([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
]);
const coreAbi = JSON.parse(readFileSync(new URL('./abi/OpenFourCore.json', import.meta.url), 'utf8'));
const toolsAbi = JSON.parse(readFileSync(new URL('./abi/OpenFourTools.json', import.meta.url), 'utf8'));
const coreInterface = new Interface(coreAbi);
const out = value => console.log(JSON.stringify(value));
const pathOf = token => join(STATE_DIR, `sell-${token.toLowerCase()}.json`);
const save = (path, value, first = false) => {
  const next = { ...value, updatedUtc: new Date().toISOString() };
  if (first) writeFileSync(path, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
  else { const temp = `${path}.tmp`; writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, path); }
  return next;
};

function args(argv) {
  const [rawToken, ...flags] = argv;
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawToken || '')) throw new Error('invalid_token_address');
  const modes = flags.filter(x => x === '--execute' || x === '--status');
  const amounts = flags.filter(x => /^--sell-bps=/.test(x));
  const slips = flags.filter(x => /^--slippage-bps=/.test(x));
  const manualConfirm = flags.includes('--manual-confirm');
  if (modes.length > 1 || amounts.length > 1 || slips.length > 1 ||
      flags.some(x => x !== '--execute' && x !== '--status' && x !== '--manual-confirm' &&
        !/^--sell-bps=/.test(x) && !/^--slippage-bps=/.test(x)))
    throw new Error('invalid_arguments');
  const bps = BigInt((amounts[0] || '--sell-bps=10000').split('=')[1]);
  const slippage = BigInt((slips[0] || '--slippage-bps=3000').split('=')[1]);
  if (bps <= 0n || bps > 10000n) throw new Error('invalid_sell_percentage');
  if (slippage < 0n || slippage > 5000n) throw new Error('invalid_sell_slippage');
  return { token: getAddress(rawToken), mode: modes[0] || '--check', bps, slippage, manualConfirm };
}

async function reconcile(provider, token, path) {
  if (!existsSync(path)) return null;
  let state = JSON.parse(readFileSync(path, 'utf8'));
  if (['confirmed', 'reverted'].includes(state.stage)) return state;
  const candidates = new Set(state.txHash ? [state.txHash] : []);
  if (!candidates.size) {
    try {
      const history = await baw(['wallet', 'tx-history', '--type', 'all', '--size', '50',
        '--startTime', String(state.startedMs - 60000), '--binanceChainId', '56']);
      for (const item of history.transactions || [])
        if (/^0x[0-9a-fA-F]{64}$/.test(item.txHash || '')) candidates.add(item.txHash);
    } catch { /* A missing wallet history never authorizes a retry. */ }
  }
  for (const hash of candidates) {
    const tx = await provider.getTransaction(hash);
    if (!tx || tx.blockNumber < state.fromBlock || tx.chainId !== 56n ||
        tx.from.toLowerCase() !== WALLET.toLowerCase() ||
        tx.to?.toLowerCase() !== state.to.toLowerCase() || tx.value !== 0n ||
        keccak256(tx.data) !== state.inputHash) continue;
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) continue;
    if (state.operation === 'sell' && receipt.status === 1) {
      const trade = receipt.logs.filter(x => x.address.toLowerCase() === CORE.toLowerCase())
        .map(x => { try { return coreInterface.parseLog(x); } catch { return null; } })
        .find(x => x?.name === 'TradeExecuted' &&
          x.args.token.toLowerCase() === token.toLowerCase() && !x.args.isBuy);
      if (!trade) throw new Error('sell_receipt_missing_trade_event');
      recordSaleReceipt(state,receipt,WALLET);
      state = save(path, { ...state, stage: state.settlement?'sell_confirmed':'confirmed', txHash: hash,
        tokenSold: trade.args.tokenAmount.toString(),
        quoteReceived: trade.args.traderQuoteAmount.toString(),
        quoteAsset: trade.args.quoteAsset });
    } else {
      if(receipt.status===1)recordNativeReceipt(state,receipt,state.operation);
      state = save(path, { ...state,
        stage: receipt.status === 1 ? `${state.operation==='approval'?'approval':state.operation}_confirmed` : 'reverted', txHash: hash });
    }
    return state;
  }
  return state;
}

async function submit(provider, token, path, operation, to, inputData, head, state, manualConfirm) {
  let marked = false;
  try {
    const result = await submitContractCall({ from: WALLET, to, valueWei: 0n, inputData,
      allowAppConfirmation: true,
      allowMediumRisk: manualConfirm,
      onPreview: async details => { out({ stage: `${operation}_preview`, token,
        requestId: details.requestId,
        requireConfirmation: details.requireConfirmation, risks: details.riskDetails,
        addressRisks: details.addressRisks,
        riskBehaviors: details.riskBehaviors,
        authorityChangeCount: details.authorityChangeCount,
        simulationCode: details.simulationCode,
        simulationErrorDetail: details.simulationErrorDetail,
        parsedTx: manualConfirm ? details.parsedTx : undefined,
        to: manualConfirm ? to : undefined, valueWei: manualConfirm ? '0' : undefined });
        if (manualConfirm) return waitForBrowserApproval(details,{from:WALLET,to,valueWei:0n,inputData,step:operation,
          proceedsWei:state.settlement?.amountRaw,proceedsTxHash:state.settlement?.saleTxHash});
      },
      beforeExecute: preview => {
        if (preview.parsedTx?.contractAddress &&
            preview.parsedTx.contractAddress.toLowerCase() !== to.toLowerCase())
          throw new Error('preview_target_mismatch');
        mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
        state = save(path, { ...state, operation, stage: `${operation}_submitting`,
          fromBlock: head, startedMs: Date.now(), to,
          inputHash: keccak256(inputData), requestId: preview.requestId,
          txHash: null, orderId: null }, !existsSync(path));
        marked = true;
      },
    });
    state = save(path, { ...state, stage: result.status === 'BROADCASTED'
      ? `${operation}_broadcast` : `${operation}_app_confirmation_pending`,
      txHash: result.txHash ?? null, orderId: result.orderId ?? null });
    out({ stage: state.stage, token, txHash: state.txHash, orderId: state.orderId });
    for(const end=Date.now()+300000;Date.now()<end;){
      try{state=await reconcile(provider,token,path);}catch{out({stage:'reconciliation_waiting'});}
      if(state.stage.endsWith('_confirmed')||['confirmed','reverted'].includes(state.stage))break;
      await new Promise(r=>setTimeout(r,state.txHash?(Date.now()-state.startedMs<5000?150:500):2000));
    }
    out({stage:state.stage,token,txHash:state.txHash,orderId:state.orderId});
    return state;
  } catch (error) {
    if (marked) save(path, { ...state, stage: `${operation}_submission_unknown` });
    throw error;
  }
}

async function main() {
  const { token, mode, bps, slippage, manualConfirm } = args(process.argv.slice(2));
  const path = pathOf(token);
  const provider = new FailoverRpcProvider(process.env.BSC_RPC_HTTP,
    ['https://bsc-rpc.publicnode.com', 'https://rpc-bsc.blockmachine.io']);
  try {
    let previous = await reconcile(provider, token, path);
    if (mode === '--status') return out({ stage: previous?.stage || 'not_started', token,
      txHash: previous?.txHash ?? null, orderId: previous?.orderId ?? null,
      tokenSold: previous?.tokenSold ? formatEther(previous.tokenSold) : null,
      quoteReceived: previous?.quoteReceived ? formatEther(previous.quoteReceived) : null });
    if(previous&&!['confirmed','reverted','approval_confirmed','confirmation_expired_unbroadcast'].includes(previous.stage)){
      const resolved=await reconcileRecordedCall(provider,previous,WALLET,baw);
      if(resolved.kind==='confirmation_closed'&&expiredCallMayRetry(previous)){previous=save(path,{...previous,stage:'confirmation_expired_unbroadcast',reconciliation:resolved});out({stage:'prior_confirmation_closed',orderId:previous.orderId});}
      else if(resolved.kind==='reverted')previous=save(path,{...previous,stage:'reverted',txHash:resolved.txHash});
      else throw Error('previous_order_unresolved');
    }
    const runtime = await preflight(provider, token);
    const { head, toolsAddress, options, beforeToken, bnbBalance } = runtime;
    if (beforeToken <= 0n) throw new Error('no_token_balance_to_sell');
    if (bnbBalance < 2000000000000000n) throw new Error('insufficient_bnb_for_sell_gas');
    const amount = beforeToken * bps / 10000n;
    if (amount <= 0n) throw new Error('sell_amount_too_small');
    const tokenContract = new Contract(token, ERC20, provider);
    const [allowance, estimate] = await Promise.all([
      tokenContract.allowance(WALLET, CORE, { blockTag: head }),
      new Contract(toolsAddress, toolsAbi, provider).estimateSell.staticCall(
        token, WALLET, amount, options, '0x', { blockTag: head }),
    ]);
    if (estimate.userReceives <= 0n || estimate.tokenAmount !== amount ||
        estimate.curveQuote <= 0n || estimate.totalFee * 10000n > estimate.curveQuote * 2500n)
      throw new Error('sell_quote_or_fee_invalid');
    const minReceived = estimate.userReceives * (10000n - slippage) / 10000n;
    out({ stage: 'quote', token, sellPercent: Number(bps) / 100,
      tokenBalance: formatEther(beforeToken), tokenToSell: formatEther(amount),
      expectedBNB: formatEther(estimate.userReceives), minBNB: formatEther(minReceived),
      approvalRequired: allowance < amount, readBlock: head });
    if (mode === '--check') {
      const to = allowance < amount ? token : CORE;
      const data = allowance < amount
        ? ERC20.encodeFunctionData('approve', [CORE, amount])
        : coreInterface.encodeFunctionData('sell', [token, amount, minReceived, options, '0x']);
      const preview = await baw(['contract-call', 'preview', '--binanceChainId', '56',
        '--from', WALLET, '--to', to, '--value', '0', '--inputData', data]);
      const details = previewDiagnostics(preview);
      return out({ stage: 'preview_only', operation: allowance < amount ? 'approval' : 'sell',
        requireConfirmation: details.requireConfirmation, risks: details.riskDetails,
        simulationCode: details.simulationCode });
    }
    if (allowance < amount) {
      previous = await submit(provider, token, path, 'approval', token,
        ERC20.encodeFunctionData('approve', [CORE, amount]), head, previous || {}, manualConfirm);
      if (previous.stage !== 'approval_confirmed') return;
    }
    const refreshed = await preflight(provider, token);
    const balanceNow = refreshed.beforeToken;
    const sellAmount = balanceNow * bps / 10000n;
    if (sellAmount <= 0n || sellAmount !== amount ||
        await tokenContract.allowance(WALLET, CORE) < sellAmount)
      throw new Error('sell_balance_or_approval_changed');
    const latest = await new Contract(refreshed.toolsAddress, toolsAbi, provider)
      .estimateSell.staticCall(token, WALLET, sellAmount, refreshed.options, '0x');
    if (latest.userReceives <= 0n || latest.totalFee * 10000n > latest.curveQuote * 2500n)
      throw new Error('sell_latest_quote_invalid');
    const sellMin = latest.userReceives * (10000n - slippage) / 10000n;
    const settlement=await prepareSaleSettlement(provider,{quote:refreshed.cfg.quoteAsset},WALLET,true);
    let flow=await submit(provider, token, path, 'sell', CORE,
      coreInterface.encodeFunctionData('sell',
        [token, sellAmount, sellMin, refreshed.options, '0x']), refreshed.head,
      { ...(previous || {}), settlement,sellBps: bps.toString(), beforeToken: balanceNow.toString() }, manualConfirm);
    if(flow.stage!=='sell_confirmed')return;
    const ok=await settleSaleToBNB({provider,wallet:WALLET,state:flow,slippageBps:slippage,
      persist:()=>{save(path,flow);},emit:out,
      submit:async(label,to,data)=>{const next=await submit(provider,token,path,label,to,data,
        await provider.getBlockNumber(),flow,manualConfirm);Object.assign(flow.settlement,next.settlement);
        Object.assign(flow,{...next,settlement:flow.settlement});return next.stage===`${label}_confirmed`;}});
    if(ok){flow=save(path,{...flow,stage:'confirmed'});out({stage:'confirmed',token,
      txHash:flow.settlement.saleTxHash,settlementTxHash:flow.settlement.nativeOrder?.txHash||null,receivedAsset:'BNB'});}
  } finally { provider.destroy(); }
}

main().catch(error => { const message=String(error.message || 'unknown');
  out({ stage: 'error', error: /^[a-z][a-z0-9_]{2,100}$/i.test(message) ? message : 'trade_failed',
  apiCode: error?.details?.apiCode ?? null }); process.exitCode = 1; });
