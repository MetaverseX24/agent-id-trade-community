import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, formatEther, formatUnits, getAddress, keccak256, parseEther,
  ZeroAddress } from 'ethers';
import { FailoverRpcProvider } from '../rpc_failover.mjs';
import { baw, previewDiagnostics, submitContractCall } from '../wallet_cli.mjs';
import { waitForBrowserApproval } from './approval_gate.mjs';
import { assertProtocolPins } from './protocol_pins.mjs';
import { findGross, resolveBuyQuote } from './quote_search.mjs';
import { bestPathQuote, quotePaths, quoteCapacity } from './quote_paths.mjs';
import {prepareSaleSettlement,recordSaleReceipt,recordBuyFundingReceipt,recordNativeReceipt,settleSaleToBNB,settleBuySurplus,netReceived} from './sale_settlement.mjs';
import { canRetryAfterApproval,reconcileRecordedCall,expiredCallMayRetry } from './recovery.mjs';
import {gangV2BuyQuote,gangV2SellQuote,resolveGangBuyQuote} from './gang_curve.mjs';
import {walletSnapshot} from './preflight_snapshot.mjs';
import {prepareFundedBuy} from './funded_buy.mjs';
import { ABI, BNB, FLAP, FOUR_CORE, GANG_PADS, IFACE, ROUTER, WALLET, WBNB,
  detectAgentToken, verifiedPair } from './platforms.mjs';

const FOUR_ABI = JSON.parse(readFileSync(new URL('../abi/OpenFourCore.json', import.meta.url), 'utf8'));
const STATE_DIR = process.env.AGENT_TRADE_STATE_DIR || './data/orders';
const RESERVE = parseEther(process.env.AGENT_GAS_RESERVE_BNB || '0.005');
const SLIPPAGE = BigInt(process.env.AGENT_SLIPPAGE_BPS||'3000');
if(SLIPPAGE<0n||SLIPPAGE>5000n)throw Error('invalid_slippage');
const MAX_BUDGET = parseEther(process.env.AGENT_MAX_BUY_BNB || '0.3');
let lastStage='starting';
const output = value => {if(value.stage!=='error')lastStage=value.stage;console.log(JSON.stringify(value));};
const minOut = x => x * (10000n - SLIPPAGE) / 10000n;
const same = (a, b) => getAddress(a) === getAddress(b);
const ceil = (a, b) => (a + b - 1n) / b;

function args(argv) {
  const [raw, ...flags] = argv;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw || '')) throw new Error('invalid_token_address');
  const pick = name => flags.find(x => x.startsWith(`--${name}=`))?.split('=')[1] ?? null;
  for (const flag of flags) if (flag !== '--execute' && flag !== '--manual-confirm' &&
    !/^--(?:action|budget-bnb|intent|percent-bps|sell-bps)=/.test(flag))
    throw new Error('invalid_arguments');
  const action = pick('action');
  if (!['buy', 'sell'].includes(action) || !flags.includes('--execute') ||
      !flags.includes('--manual-confirm'))
    throw new Error('invalid_action');
  const intent = pick('intent');
  if (!/^[0-9a-f-]{36}$/.test(intent || '')) throw new Error('invalid_intent');
  const budget = action === 'buy' ? parseEther(pick('budget-bnb') || '0') : 0n;
  if (action === 'buy' && (budget <= 0n || budget > MAX_BUDGET))
    throw new Error('budget_out_of_range');
  const percent = pick('percent-bps') === null ? null : BigInt(pick('percent-bps'));
  const sellBps = pick('sell-bps') === null ? null : BigInt(pick('sell-bps'));
  if (percent !== null && (percent <= 0n || percent > 200n)) throw new Error('target_percent_out_of_range');
  if (action === 'sell' && (sellBps === null || sellBps <= 0n || sellBps > 10000n))
    throw new Error('sell_percent_out_of_range');
  return { token:getAddress(raw), action, intent, budget, percent, sellBps };
}
function stateFile(token, action) { return join(STATE_DIR, `${token.toLowerCase()}-${action}.json`); }
function save(path, value) {
  mkdirSync(STATE_DIR, { recursive:true, mode:0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...value, updatedUtc:new Date().toISOString() }), { mode:0o600 });
  renameSync(temp, path);
}
async function preflight(provider) {
  const [[status,settings,addresses,agentId],network]=await Promise.all([walletSnapshot(baw,WALLET),provider.getNetwork()]);
  if (network.chainId !== 56n || status.status !== 'CONNECTED' ||
      !addresses.addresses?.some(x => String(x.binanceChainId) === '56' && same(x.address,WALLET)) ||
      !agentId.claimed) throw new Error('wallet_or_agent_id_invalid');
  if (!settings.devMode?.enabled || settings.devMode.balanceExceeded ||
      Date.parse(settings.devMode.expiresAt) < Date.now() + 120000 ||
      Date.parse(settings.sessionExpireTime) < Date.now() + 120000)
    throw new Error('wallet_developer_mode_or_session_invalid');
  if (!settings.tradeAllTokens) throw new Error('wallet_trade_all_tokens_disabled');
}
async function codeCheck(provider, ...addresses) {
  const codes = await Promise.all(addresses.map(x => provider.getCode(x)));
  if (codes.some(x => x === '0x')) throw new Error('missing_contract_code');
}
async function matchingReceipt(provider, state) {
  const known = new Set(state.txHash ? [state.txHash] : []);
  const history = known.size ? {transactions:[]} : await baw(['wallet','tx-history','--type','all','--size','50',
    '--startTime',String(state.startedMs-60000),'--binanceChainId','56']);
  for (const item of history.transactions || [])
    if (/^0x[0-9a-fA-F]{64}$/.test(item.txHash || '')) known.add(item.txHash);
  for (const hash of known) {
    const [tx,receipt] = await Promise.all([provider.getTransaction(hash),provider.getTransactionReceipt(hash)]);
    if (!tx || !tx.to || !same(tx.from,WALLET) || !same(tx.to,state.to) ||
        tx.value !== BigInt(state.value) || keccak256(tx.data) !== state.inputHash ||
        tx.blockNumber === null || tx.blockNumber < state.fromBlock) continue;
    if (receipt && receipt.blockNumber >= state.fromBlock) return {hash,receipt};
  }
  return null;
}
async function submit(provider, path, state, label, to, value, data) {
  const head = await provider.getBlockNumber();
  await codeCheck(provider, to);
  const call = { from:WALLET, to, valueWei:value, inputData:data,
    allowAppConfirmation:true, allowMediumRisk:true,
    onPreview: async details => { output({ stage:`${label}_preview`,
      requestId:details.requestId,
      requireConfirmation:details.requireConfirmation, risks:details.riskDetails,
      addressRisks:details.addressRisks, riskBehaviors:details.riskBehaviors,
      simulationCode:details.simulationCode,
      simulationErrorDetail:details.simulationErrorDetail,
      authorityChangeCount:details.authorityChangeCount,
      parsedTx:details.parsedTx, to, valueWei:value.toString() });
      return waitForBrowserApproval(details,{from:WALLET,to,valueWei:value,inputData:data,step:label,
        proceedsWei:state.settlement?.amountRaw,proceedsTxHash:state.settlement?.saleTxHash,settlementKind:state.settlement?.kind});
    },
    beforeExecute: async preview => {
      if (preview.parsedTx?.contractAddress &&
          !same(preview.parsedTx.contractAddress,to)) throw new Error('preview_target_mismatch');
      if(state.unit==='shares'&&['buy','sell'].includes(label))state.sharesBefore=String(await new Contract(state.market,ABI.FLAP_MARKET,provider).sharesOf(WALLET));
      if(label==='claim')state.claimTokenBefore=String(await new Contract(state.token,ABI.ERC20,provider).balanceOf(WALLET));
      Object.assign(state, { stage:`${label}_submitting`, step:label, fromBlock:head,
        startedMs:Date.now(), to, value:value.toString(), inputHash:keccak256(data),
        requestId:preview.requestId, txHash:null, orderId:null });
      save(path,state);
    },
  };
  const result = await submitContractCall(call);
  Object.assign(state, { stage:result.status === 'BROADCASTED' ? `${label}_broadcast` :
    `${label}_app_confirmation_pending`, txHash:result.txHash ?? null,
    orderId:result.orderId ?? null });
  save(path,state);
  output({ stage:state.stage, txHash:state.txHash, orderId:state.orderId });
  let match=null;
  const deadline=Date.now()+300000;
  while (Date.now()<deadline && !match) {
    try { match=await matchingReceipt(provider,state); }
    catch { output({stage:'reconciliation_waiting',reason:'rpc_or_wallet_history_unavailable'}); }
    if (!match) await new Promise(resolve=>setTimeout(resolve,state.txHash?(Date.now()-state.startedMs<5000?150:500):2000));
  }
  if (!match) { output({ stage:'receipt_unresolved', orderId:state.orderId,
    txHash:state.txHash, message:'Check Binance App and chain before retrying.' }); return false; }
  state.txHash=match.hash;
  const {receipt}=match;
  if (receipt.status !== 1) {
    state.stage = `${label}_reverted`; save(path,state);
    throw new Error('transaction_reverted');
  }
  if(label==='sell')recordSaleReceipt(state,receipt,WALLET);
  state.nativeSpentWei=String(BigInt(state.nativeSpentWei||0)+value);
  if(['wrap','get_quote'].includes(label)&&state.quoteFunding){
    const got=label==='wrap'?value:netReceived(receipt,state.quoteFunding.asset,WALLET);
    if(got<=0n)throw Error('quote_swap_delivered_zero');
    state.quoteFunding.acquiredRaw=String(BigInt(state.quoteFunding.acquiredRaw||0)+got);
    state.quoteFunding.fundingTxHash=state.txHash;
  }
  if(label==='buy')recordBuyFundingReceipt(state,receipt,WALLET);
  recordNativeReceipt(state,receipt,label);
  if(state.unit==='shares'&&['buy','sell'].includes(label)){
    const after=await new Contract(state.market,ABI.FLAP_MARKET,provider).sharesOf(WALLET),before=BigInt(state.sharesBefore);
    output({stage:'trade_fill',txHash:state.txHash,unit:'shares',quantityRaw:String(label==='buy'?after-before:before-after),quoteRaw:state.value});
  }
  if(label==='claim'){
    const after=await new Contract(state.token,ABI.ERC20,provider).balanceOf(WALLET),received=after-BigInt(state.claimTokenBefore||0);
    if(received>0n)output({stage:'claim_fill',txHash:state.txHash,token:state.token,quantityRaw:String(received)});
  }
  state.stage = `${label}_confirmed`; save(path,state);
  output({ stage:state.stage, txHash:state.txHash,confirmationMs:Date.now()-state.startedMs });
  return true;
}
async function budgetAfterReserve(provider, requested) {
  const balance = await provider.getBalance(WALLET);
  const allowed = balance > RESERVE ? balance - RESERVE : 0n;
  if (allowed <= 0n) throw new Error('insufficient_bnb_for_gas_reserve');
  const amount = requested < allowed ? requested : allowed;
  if (amount < requested) output({ stage:'budget_reduced_for_gas', budgetBNB:formatEther(amount) });
  return amount;
}
async function ensureAllowance(provider,path,state,token,spender,amount) {
  const erc = new Contract(token,ABI.ERC20,provider);
  if ((await erc.allowance(WALLET,spender)) >= amount) return true;
  return submit(provider,path,state,'approve',token,0n,IFACE.erc20.encodeFunctionData('approve',[spender,amount]));
}
async function nativeRemaining(provider,state,plan){const spent=BigInt(state.nativeSpentWei||0),left=plan.budget>spent?plan.budget-spent:0n;
  const balance=await provider.getBalance(WALLET),available=balance>RESERVE?balance-RESERVE:0n;return left<available?left:available;}
async function fundedBuy(provider,path,state,info,plan,initialGross,spender,refresh){
  const erc=new Contract(info.quote,ABI.ERC20,provider);
  try{return await prepareFundedBuy({initialGross,slippageBps:SLIPPAGE,
    capacity:async()=>{const [remaining,existing]=await Promise.all([nativeRemaining(provider,state,plan),erc.balanceOf(WALLET)]);
      return quoteCapacity(provider,info.quote,plan.budget,remaining,existing);},
    balance:()=>erc.balanceOf(WALLET),fund:async cap=>acquireQuote(provider,path,state,info.quote,cap,await nativeRemaining(provider,state,plan)),
    approve:cap=>ensureAllowance(provider,path,state,info.quote,spender,cap),refresh,emit:output});
  }catch(error){const f=state.quoteFunding;
    if(f?.fundingTxHash&&BigInt(f.acquiredRaw||0)>0n&&state.step!=='buy'&&
      ['budget_insufficient_for_target','buy_price_slippage_cap_exceeded','price_changed_during_funding','quote_acquired_but_target_unavailable','market_migrated_during_funding'].includes(error.message)){
      f.buyTxHash=f.fundingTxHash;f.spentRaw='0';save(path,state);
      try{const restored=await settleBuySurplus({provider,wallet:WALLET,state,slippageBps:SLIPPAGE,
        submit:(label,to,data)=>submit(provider,path,state,label,to,0n,data),persist:()=>save(path,state),emit:output});
        if(restored){state.stage='funding_returned_buy_not_submitted';save(path,state);output({stage:state.stage,reason:error.message});}
      }catch{output({stage:'funding_return_needs_review',reason:error.message});}
    }
    throw error;
  }
}
async function acquireQuote(provider,path,state,quote,need,nativeBudget) {
  const erc = new Contract(quote,ABI.ERC20,provider);
  const before = await erc.balanceOf(WALLET);
  if(!state.quoteFunding)state.quoteFunding={asset:quote,initialRaw:String(before),acquiredRaw:'0'};save(path,state);
  if(before>=need){output({stage:'quote_balance_reused',quoteAsset:quote,amount:need.toString()});return need;}
  const missing=need-before;
  if (same(quote,WBNB)) {
    if (missing > nativeBudget) throw new Error('bnb_budget_insufficient_for_quote');
    if (!await submit(provider,path,state,'wrap',WBNB,missing,
      new Contract(WBNB,['function deposit()'],provider).interface.encodeFunctionData('deposit')))
      return null;
    const available=await erc.balanceOf(WALLET);
    if (available<need) throw new Error('wrapped_quote_balance_mismatch');
    return need;
  }
  const router = new Contract(ROUTER,ABI.PCS_ROUTER,provider);
  const route=await bestPathQuote(provider,await quotePaths(provider,quote),missing,true);
  const required = route.amount * 102n / 100n;
  if (required > nativeBudget) throw new Error('bnb_budget_insufficient_for_quote');
  const out = (await router.getAmountsOut(required,route.path)).at(-1);
  const data = IFACE.router.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
    [minOut(out),route.path,WALLET,BigInt(Math.floor(Date.now()/1000)+120)]);
  if (!await submit(provider,path,state,'get_quote',ROUTER,required,data)) return null;
  const available=await erc.balanceOf(WALLET);
  if (available<=before) throw new Error('quote_swap_delivered_zero');
  return available;
}
async function buyFlap(provider,info,plan,path,state) {
  const portal = new Contract(FLAP.portal,ABI.FLAP_PORTAL,provider);
  const market = new Contract(info.market,ABI.FLAP_MARKET,provider);
  const [cap,held]=await Promise.all([market.maxSharesPerWallet(),market.sharesOf(WALLET)]);
  // Leave a small buffer below the contract's hard cap for a 2% target.
  const safeCap=cap*9995n/10000n;
  const target=plan.percent===null ? safeCap :
    (cap*plan.percent/200n < safeCap ? cap*plan.percent/200n : safeCap);
  const desired=target-held;
  if (desired<=0n) throw new Error('flap_target_already_held');
  const quoteAsset=info.quote;
  const native=await budgetAfterReserve(provider,plan.budget);
  let gross=native;
  if (!same(quoteAsset,ZeroAddress)) {
    gross=await quoteCapacity(provider,quoteAsset,plan.budget,native,
      await new Contract(quoteAsset,ABI.ERC20,provider).balanceOf(WALLET));
  }
  const quote=async x => (await portal.quoteBuy(info.market,WALLET,x))[3];
  const best=await findGross(gross,desired,quote);
  if (plan.percent!==null && best===null) throw new Error('budget_insufficient_for_target');
  if (best!==null) gross=best.gross;
  let expectedShares=best?.output ?? await quote(gross);
  if (gross<=0n || expectedShares>cap-held) throw new Error('flap_wallet_cap_exceeded');
  output({stage:'quote',platform:'flap',targetShares:desired.toString(),
    expectedShares:expectedShares.toString(),grossQuote:gross.toString(),quoteAsset});
  if (same(quoteAsset,ZeroAddress)) {
    return submit(provider,path,state,'buy',FLAP.portal,gross,
      IFACE.flapPortal.encodeFunctionData('buy',[info.market,minOut(expectedShares)]));
  }
  const ready=await fundedBuy(provider,path,state,{...info,quote:quoteAsset},plan,gross,info.market,async cap=>{
    const freshHeld=await market.sharesOf(WALLET),freshDesired=target-freshHeld;
    if(freshDesired<=0n)throw Error('flap_target_already_held');
    return resolveBuyQuote(cap,freshDesired,quote,plan.percent!==null);
  });
  if(!ready)return false;gross=ready.gross;expectedShares=ready.output;
  return submit(provider,path,state,'buy',FLAP.portal,0n,
    IFACE.flapPortal.encodeFunctionData('buyWithQuote',
      [info.market,gross,minOut(expectedShares)]));
}
async function sellFlap(provider,info,plan,path,state) {
  const portal=new Contract(FLAP.portal,ABI.FLAP_PORTAL,provider);
  const market=new Contract(info.market,ABI.FLAP_MARKET,provider);
  const held=await market.sharesOf(WALLET);
  if (held<=0n) throw new Error('no_flap_shares');
  const amount=held*plan.sellBps/10000n;
  if (amount<=0n) throw new Error('sell_amount_too_small');
  const estimate=(await portal.quoteSellAll(info.market,WALLET))[3]*plan.sellBps/10000n;
  output({stage:'quote',platform:'flap',sharesToSell:amount.toString(),
    expectedQuote:estimate.toString(),quoteAsset:info.quote});
  state.settlement=await prepareSaleSettlement(provider,info,WALLET,same(info.quote,ZeroAddress));
  return submit(provider,path,state,'sell',FLAP.portal,0n,
    IFACE.flapPortal.encodeFunctionData('sellBps',[info.market,plan.sellBps,minOut(estimate)]));
}
async function buyGang(provider,info,plan,path,state) {
  const pad=GANG_PADS.find(x=>x.id===info.pad);
  const launchpad=new Contract(pad.address,pad.kind==='soft'?ABI.GANG_SOFT:ABI.GANG_V2,provider);
  const native=await budgetAfterReserve(provider,plan.budget);
  const erc=new Contract(info.token,ABI.ERC20,provider);
  const [held,supply]=await Promise.all([erc.balanceOf(WALLET),erc.totalSupply()]);
  const target=plan.percent===null ? supply/100n : supply*plan.percent/10000n;
  const desired=target-held;
  if (desired<=0n) throw new Error('gang_target_already_held');
  if (pad.kind==='soft') {
    const quote=async x=>(await launchpad.quoteBuy(info.token,WALLET,x))[0];
    const { gross, output:expected }=await resolveBuyQuote(native,desired,quote,plan.percent!==null);
    output({stage:'quote',platform:'gang',expectedTokens:formatEther(expected),grossBNB:formatEther(gross)});
    return submit(provider,path,state,'buy',pad.address,gross,
      IFACE.gangSoft.encodeFunctionData('buy',[info.token,minOut(expected)]));
  }
  const maxQuote=await quoteCapacity(provider,info.quote,plan.budget,native,
    await new Contract(info.quote,ABI.ERC20,provider).balanceOf(WALLET));
  const [curve,room]=await Promise.all([launchpad.curves(info.token),launchpad.walletRoom(info.token,WALLET)]);
  if (room<=0n) throw new Error('gang_wallet_cap_reached');
  const quote=x=>gangV2BuyQuote(curve,x,room);
  let { gross, output:expected }=resolveGangBuyQuote(curve,maxQuote,desired,room,plan.percent!==null);
  if (expected<=0n) throw new Error('gang_zero_quote');
  output({stage:'quote',platform:'gang',expectedTokens:formatEther(expected),
    grossQuote:gross.toString(),quoteAsset:info.quote});
  const ready=await fundedBuy(provider,path,state,info,plan,gross,pad.address,async cap=>{
    const [latestCurve,latestRoom,latestHeld]=await Promise.all([launchpad.curves(info.token),launchpad.walletRoom(info.token,WALLET),erc.balanceOf(WALLET)]);
    if(latestCurve.graduated)throw Error('market_migrated_during_funding');
    const wanted=target-latestHeld;if(wanted<=0n)throw Error('gang_target_already_held');
    return resolveGangBuyQuote(latestCurve,cap,wanted,latestRoom,plan.percent!==null);
  });
  if(!ready)return false;gross=ready.gross;expected=ready.output;
  output({stage:'quote_refreshed',platform:'gang',grossQuote:String(gross),expectedTokens:formatEther(expected)});
  return submit(provider,path,state,'buy',pad.address,0n,
    IFACE.gangV2.encodeFunctionData('buy',[info.token,gross,minOut(expected)]));
}
async function sellGang(provider,info,plan,path,state) {
  const erc=new Contract(info.token,ABI.ERC20,provider);
  const balance=await erc.balanceOf(WALLET);
  const amount=balance*plan.sellBps/10000n;
  if (amount<=0n) throw new Error('no_gang_tokens_to_sell');
  const pad=GANG_PADS.find(x=>x.id===info.pad);
  const launchpad=new Contract(pad.address,pad.kind==='soft'?ABI.GANG_SOFT:ABI.GANG_V2,provider);
  const expected=pad.kind==='soft' ? (await launchpad.quoteSell(info.token,amount))[0] :
    gangV2SellQuote(await launchpad.curves(info.token),amount);
  output({stage:'quote',platform:'gang',tokensToSell:formatEther(amount),
    expectedQuote:expected.toString(),quoteAsset:info.quote});
  state.settlement=await prepareSaleSettlement(provider,info,WALLET,pad.kind==='soft');
  if (!await ensureAllowance(provider,path,state,info.token,pad.address,amount)) return false;
  const data=pad.kind==='soft' ? IFACE.gangSoft.encodeFunctionData('sell',
    [info.token,amount,minOut(expected)]) : IFACE.gangV2.encodeFunctionData('sell',
    [info.token,amount,minOut(expected)]);
  return submit(provider,path,state,'sell',pad.address,0n,data);
}
async function claimFlapShares(provider,info,path,state) {
  const market=new Contract(info.market,ABI.FLAP_MARKET,provider);
  const shares=await market.sharesOf(WALLET);
  if (shares<=0n) return true;
  output({stage:'claim_required',shares:shares.toString()});
  return submit(provider,path,state,'claim',FLAP.portal,0n,
    IFACE.flapPortal.encodeFunctionData('claim',[info.market]));
}
async function tradeStandardFlap(provider,info,plan,path,state) {
  const portal=new Contract(FLAP.standardPortal,ABI.FLAP_STANDARD,provider);
  const token=new Contract(info.token,ABI.ERC20,provider);
  if (plan.action==='buy') {
    if (plan.percent!==null && !await claimFlapShares(provider,info,path,state)) return false;
    const native=await budgetAfterReserve(provider,plan.budget);
    const nativeInput=same(info.quote,WBNB) || info.nativeToQuoteSwapEnabled;
    const input=nativeInput ? ZeroAddress : info.quote;
    let gross=native;
    if (!nativeInput) {
      gross=await quoteCapacity(provider,info.quote,plan.budget,native,
        await new Contract(info.quote,ABI.ERC20,provider).balanceOf(WALLET));
    }
    const quote=async amount=>portal.quoteExactInput.staticCall([input,info.token,amount]);
    if (plan.percent!==null) {
      const [supply,held]=await Promise.all([token.totalSupply(),token.balanceOf(WALLET)]);
      const desired=supply*plan.percent/10000n-held;
      if (desired<=0n) throw new Error('target_already_held');
      const best=await findGross(gross,desired,quote);
      if (best===null) throw new Error('budget_insufficient_for_target');
      gross=best.gross;
    }
    if (!nativeInput) {
      const ready=await fundedBuy(provider,path,state,info,plan,gross,FLAP.standardPortal,async cap=>{
        if(plan.percent===null)return {gross:cap,output:await quote(cap)};
        const [supply,held]=await Promise.all([token.totalSupply(),token.balanceOf(WALLET)]);
        const desired=supply*plan.percent/10000n-held;if(desired<=0n)throw Error('target_already_held');
        return resolveBuyQuote(cap,desired,quote,true);
      });if(!ready)return false;gross=ready.gross;
    }
    const expected=await quote(gross);
    output({stage:'quote',platform:'flap',phase:'standard_curve',
      expectedTokens:expected.toString(),grossQuote:gross.toString(),quoteAsset:input});
    return submit(provider,path,state,'buy',FLAP.standardPortal,nativeInput?gross:0n,
      IFACE.flapStandard.encodeFunctionData('swapExactInput',
        [[input,info.token,gross,minOut(expected),'0x']]));
  }
  if (!await claimFlapShares(provider,info,path,state)) return false;
  const held=await token.balanceOf(WALLET);
  const amount=held*plan.sellBps/10000n;
  if (amount<=0n) throw new Error('no_flap_tokens_to_sell');
  let outputAsset=ZeroAddress,expected;
  try{expected=await portal.quoteExactInput.staticCall([info.token,ZeroAddress,amount]);}
  catch{outputAsset=info.quote;expected=await portal.quoteExactInput.staticCall([info.token,outputAsset,amount]);}
  output({stage:'quote',platform:'flap',phase:'standard_curve',
    tokensToSell:amount.toString(),expectedQuote:expected.toString(),quoteAsset:outputAsset});
  state.settlement=await prepareSaleSettlement(provider,info,WALLET,same(outputAsset,ZeroAddress));
  if (!await ensureAllowance(provider,path,state,info.token,FLAP.standardPortal,amount)) return false;
  return submit(provider,path,state,'sell',FLAP.standardPortal,0n,
    IFACE.flapStandard.encodeFunctionData('swapExactInput',
      [[info.token,outputAsset,amount,minOut(expected),'0x']]));
}
async function tradeDex(provider,info,plan,path,state) {
  if (!info.pair) throw new Error('external_pool_unverified');
  if (plan.action==='buy' && plan.percent!==null && info.platform==='flap' &&
      !await claimFlapShares(provider,info,path,state)) return false;
  const token=new Contract(info.token,ABI.ERC20,provider);
  let [held,supply,decimals]=await Promise.all([
    token.balanceOf(WALLET),token.totalSupply(),token.decimals(),
  ]);
  if (plan.action==='sell' && info.platform==='flap') {
    if (!await claimFlapShares(provider,info,path,state)) return false;
    held=await token.balanceOf(WALLET);
  }
  const route=same(info.quote,WBNB) ? [WBNB,info.token] : [WBNB,info.quote,info.token];
  if (route.length===3 && !await verifiedPair(provider,info.quote,WBNB))
    throw new Error('quote_bnb_pair_unverified');
  const router=new Contract(ROUTER,ABI.PCS_ROUTER,provider);
  const deadline=BigInt(Math.floor(Date.now()/1000)+120);
  if (plan.action==='buy') {
    const native=await budgetAfterReserve(provider,plan.budget);
    let spend=native;
    if (plan.percent!==null) {
      const target=supply*plan.percent/10000n;
      if (held>=target) throw new Error('target_already_held');
      const estimate=(await router.getAmountsIn(target-held,route))[0];
      spend=estimate;
      if (spend>native) throw new Error('budget_insufficient_for_target');
    }
    const expected=(await router.getAmountsOut(spend,route)).at(-1);
    output({stage:'quote',platform:info.platform,phase:'graduated',
      budgetBNB:formatEther(spend),expectedTokens:formatUnits(expected,decimals)});
    const data=IFACE.router.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
      [minOut(expected),route,WALLET,deadline]);
    return submit(provider,path,state,'buy',ROUTER,spend,data);
  }
  const amount=held*plan.sellBps/10000n;
  if (amount<=0n) throw new Error('no_tokens_to_sell');
  const reverse=[...route].reverse();
  const expected=(await router.getAmountsOut(amount,reverse)).at(-1);
  output({stage:'quote',platform:info.platform,phase:'graduated',
    tokensToSell:formatUnits(amount,decimals),expectedBNB:formatEther(expected)});
  state.settlement=await prepareSaleSettlement(provider,info,WALLET,true);
  if (!await ensureAllowance(provider,path,state,info.token,ROUTER,amount)) return false;
  const data=IFACE.router.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
    [amount,minOut(expected),reverse,WALLET,deadline]);
  return submit(provider,path,state,'sell',ROUTER,0n,data);
}
async function main() {
  const plan=args(process.argv.slice(2));
  const path=stateFile(plan.token,plan.action);
  const provider=new FailoverRpcProvider(process.env.BSC_RPC_HTTP ||
    'https://bsc-rpc.publicnode.com', ['https://bsc-rpc.publicnode.com',
    'https://rpc-bsc.blockmachine.io']);
  try {
    if (existsSync(path)) {
      const prior=JSON.parse(readFileSync(path,'utf8'));
      if (!['completed','confirmation_expired_unbroadcast','funding_returned_buy_not_submitted'].includes(prior.stage)) {
        if(await canRetryAfterApproval(provider,prior,WALLET))output({stage:'prior_approval_reconciled',txHash:prior.txHash});
        else{const resolved=await reconcileRecordedCall(provider,prior,WALLET,baw);
          if(resolved.kind==='confirmation_closed'&&expiredCallMayRetry(prior)){prior.stage='confirmation_expired_unbroadcast';prior.reconciliation=resolved;save(path,prior);
            output({stage:'prior_confirmation_closed',orderId:prior.orderId});}
          else if(resolved.kind==='confirmed'&&['buy','sell'].includes(prior.step)){
            prior.txHash=resolved.txHash;
            if(prior.step==='sell')recordSaleReceipt(prior,resolved.receipt,WALLET);else recordBuyFundingReceipt(prior,resolved.receipt,WALLET);
            output({stage:`${prior.step}_confirmed`,txHash:resolved.txHash,reconciled:true});
            const options={provider,wallet:WALLET,state:prior,slippageBps:SLIPPAGE,submit:(label,to,data)=>submit(provider,path,prior,label,to,0n,data),persist:()=>save(path,prior),emit:output};
            const done=prior.action==='sell'?(prior.settlement?await settleSaleToBNB(options):true):await settleBuySurplus(options);
            if(done){prior.stage='completed';save(path,prior);output({stage:'confirmed',token:plan.token,action:prior.action,txHash:resolved.txHash,reconciled:true});}return;
          }else if(resolved.kind==='reverted'||(resolved.kind==='confirmed'&&['approve','wrap','get_quote','claim'].includes(prior.step))){
            prior.stage='prior_call_reconciled';prior.reconciliation={kind:resolved.kind,txHash:resolved.txHash};save(path,prior);output({stage:'prior_call_reconciled',txHash:resolved.txHash});
          }else throw new Error('prior_trade_unresolved_check_chain');
        }
      }
    }
    const [,info]=await Promise.all([preflight(provider),detectAgentToken(provider,plan.token,FOUR_ABI)]);
    await assertProtocolPins(provider,info);
    if (plan.percent>100n && info.platform!=='flap')
      throw new Error('target_percent_out_of_range');
    if (info.platform==='four' && info.phase==='curve') throw new Error('four_curve_use_existing_adapter');
    const state={version:1,intent:plan.intent,token:info.token,platform:info.platform,unit:info.unit||'token',market:info.market||null,
      action:plan.action,stage:'preflight',createdUtc:new Date().toISOString()};
    let ok;
    if (info.platform==='flap' && info.phase==='standard_curve')
      ok=await tradeStandardFlap(provider,info,plan,path,state);
    else if (info.phase==='graduated') ok=await tradeDex(provider,info,plan,path,state);
    else if (info.platform==='flap') ok=plan.action==='buy' ?
      await buyFlap(provider,info,plan,path,state) : await sellFlap(provider,info,plan,path,state);
    else if (info.platform==='gang') ok=plan.action==='buy' ?
      await buyGang(provider,info,plan,path,state) : await sellGang(provider,info,plan,path,state);
    else throw new Error('unsupported_agent_route');
    if(ok&&plan.action==='sell')ok=await settleSaleToBNB({provider,wallet:WALLET,state,slippageBps:SLIPPAGE,
      submit:(label,to,data)=>submit(provider,path,state,label,to,0n,data),
      ensureAllowance:(asset,spender,amount)=>ensureAllowance(provider,path,state,asset,spender,amount),
      persist:()=>save(path,state),emit:output});
    if(ok&&plan.action==='buy')ok=await settleBuySurplus({provider,wallet:WALLET,state,slippageBps:SLIPPAGE,
      submit:(label,to,data)=>submit(provider,path,state,label,to,0n,data),persist:()=>save(path,state),emit:output});
    if (ok) {
      state.stage='completed'; save(path,state);
      output({stage:'confirmed',token:info.token,action:plan.action});
    }
  } finally { provider.destroy(); }
}
main().catch(error => {
  const message=String(error?.message || 'unknown');
  output({stage:'error',error:/^[a-z][a-z0-9_]{2,100}$/i.test(message) ? message :
    error?.name || 'trade_failed',failedAfter:lastStage,
    location:String(error?.stack||'').match(/curve_trade\.mjs:(\d+):/)?.[1]||null});
  process.exitCode=1;
});
