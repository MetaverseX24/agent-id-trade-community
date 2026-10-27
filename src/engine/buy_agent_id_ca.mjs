// One explicit Four.meme Agent ID inner-market buy per token. No background loop.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Contract, Interface, ZeroAddress, formatEther, getAddress, id, keccak256,
  parseEther, toBeHex,
} from 'ethers';
import { FailoverRpcProvider } from './rpc_failover.mjs';
import { makeBuyPlan } from './trade_logic.mjs';
import { baw, previewDiagnostics, submitContractCall } from './wallet_cli.mjs';
import { waitForBrowserApproval } from './agent_ui/approval_gate.mjs';
import {walletSnapshot} from './agent_ui/preflight_snapshot.mjs';
import {reconcileRecordedCall} from './agent_ui/recovery.mjs';

const REGISTRY = getAddress('0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94');
const CORE = getAddress('0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3');
const MANAGER = getAddress('0x7b377ad70a20556f4778c4cd878a68a7e7efabbc');
const WALLET = getAddress(process.env.AGENT_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000');
const PRESET = 1778027615735n;
const MAX_BUDGET = parseEther(process.env.AGENT_MAX_BUY_BNB || '0.3');
const GAS_RESERVE = parseEther(process.env.AGENT_GAS_RESERVE_BNB || '0.005');
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const BASELINE_PATH = process.env.OPENFOUR_BASELINE_STATE || './data/protocol-baseline.json';
const STATE_DIR = process.env.OPENFOUR_MANUAL_STATE_DIR || './data/manual';
const MANAGER_ABI = ['function isPresetWhitelistEnabled(uint256) view returns (bool)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)'];
const VAULT_ABI = ['function phase() view returns (uint8)'];
const BEACON_ABI = ['function implementation() view returns (address)'];
const TRANSFER_TOPIC = id('TradeExecuted(address,address,uint256,bool,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)');

const output = value => console.log(JSON.stringify(value));
const same = (a, b) => getAddress(a) === getAddress(b);
const abi = name => JSON.parse(readFileSync(new URL(`./abi/${name}.json`, import.meta.url), 'utf8'));
const statePath = (token, intent) => join(STATE_DIR,
  `${token.toLowerCase()}${intent ? `-${intent}` : ''}.json`);
const timeMs = value => typeof value === 'number' ? value : Date.parse(value);
const code = error => {
  const message = String(error?.message || 'unknown');
  if (/^[a-z][a-z0-9_]{1,100}$/i.test(message)) return message;
  return error?.code || error?.name || 'unknown';
};

function save(path, state, first = false) {
  const next = { ...state, updatedUtc: new Date().toISOString() };
  if (first) writeFileSync(path, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
  else {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, path);
  }
  return next;
}

function parseArgs(argv) {
  const [rawToken, ...flags] = argv;
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawToken || '')) throw new Error('invalid_token_address');
  const modes = flags.filter(x => ['--execute', '--status'].includes(x));
  const budgets = flags.filter(x => /^--budget-bnb=/.test(x));
  const percents = flags.filter(x => /^--percent-bps=/.test(x));
  const intents = flags.filter(x => /^--intent=/.test(x));
  const manualConfirm = flags.includes('--manual-confirm');
  if (modes.length > 1 || budgets.length > 1 || percents.length > 1 || intents.length > 1 ||
      flags.some(x => !['--execute', '--status', '--manual-confirm'].includes(x) &&
        !/^--budget-bnb=/.test(x) && !/^--percent-bps=/.test(x) && !/^--intent=/.test(x)))
    throw new Error('usage_token_then_optional_execute_or_status');
  const intent = intents.length ? intents[0].split('=')[1] : null;
  if (intent && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(intent))
    throw new Error('invalid_intent_id');
  const budget = budgets.length ? parseEther(budgets[0].split('=')[1]) : null;
  const percentBps = percents.length ? BigInt(percents[0].split('=')[1]) : null;
  if (budget !== null && (budget <= 0n || budget > MAX_BUDGET)) throw new Error('budget_limit_exceeded');
  if (percentBps !== null && (percentBps <= 0n || percentBps > 100n))
    throw new Error('percent_limit_exceeded');
  return { token: getAddress(rawToken), mode: modes[0] || '--check', budget, percentBps, intent, manualConfirm };
}

async function assertNoUnresolvedBuy(provider,token) {
  if (!existsSync(STATE_DIR)) return;
  for (const file of readdirSync(STATE_DIR)) {
    if (!file.startsWith(token.toLowerCase()) || !file.endsWith('.json')) continue;
    const previous = JSON.parse(readFileSync(join(STATE_DIR, file), 'utf8'));
    if (['confirmed','reverted','confirmation_expired_unbroadcast'].includes(previous.stage))continue;
    const result=await reconcileRecordedCall(provider,{...previous,to:CORE},WALLET,baw);
    if(result.kind==='confirmation_closed'){save(join(STATE_DIR,file),{...previous,stage:'confirmation_expired_unbroadcast',reconciliation:result});continue;}
    if(result.kind==='reverted'){save(join(STATE_DIR,file),{...previous,stage:'reverted',txHash:result.txHash});continue;}
    throw new Error('previous_buy_unresolved_check_status_first');
  }
}

async function fingerprint(provider, address) {
  const [bytecode, implWord, beaconWord] = await Promise.all([
    provider.getCode(address), provider.getStorage(address, IMPL_SLOT),
    provider.getStorage(address, BEACON_SLOT),
  ]);
  if (bytecode === '0x') throw new Error('missing_contract_code');
  const beacon = getAddress(`0x${beaconWord.slice(-40)}`);
  const impl = beacon !== ZeroAddress
    ? getAddress(await new Contract(beacon, BEACON_ABI, provider).implementation())
    : getAddress(`0x${implWord.slice(-40)}`);
  const [implCode, beaconCode] = await Promise.all([
    impl === ZeroAddress ? '0x' : provider.getCode(impl),
    beacon === ZeroAddress ? '0x' : provider.getCode(beacon),
  ]);
  if (impl !== ZeroAddress && implCode === '0x') throw new Error('missing_implementation_code');
  if (beacon !== ZeroAddress && beaconCode === '0x') throw new Error('missing_beacon_code');
  const base = `${keccak256(bytecode)}:${impl.toLowerCase()}:${implCode === '0x' ? '-' : keccak256(implCode)}`;
  return beacon === ZeroAddress ? base : `${base}:${beacon.toLowerCase()}:${keccak256(beaconCode)}`;
}

async function checkPinnedContracts(provider, registry, toolsAddress, zapAddress, preset) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (!baseline.fingerprints || !baseline.moduleFingerprints || !baseline.presetConfig ||
      !same(toolsAddress, baseline.toolsAddress) || !same(zapAddress, baseline.zapAddress))
    throw new Error('contract_baseline_missing_or_changed');
  const fixed = { core: CORE, registry: REGISTRY, tools: toolsAddress, manager: MANAGER, zap: zapAddress };
  const [fixedActual, resolved, tokenImpl] = await Promise.all([
    Promise.all(Object.values(fixed).map(address => fingerprint(provider, address))),
    registry.resolvePresetImplementations(PRESET), registry.getPresetTokenImpl(PRESET),
  ]);
  Object.keys(fixed).forEach((key, index) => {
    if (fixedActual[index] !== baseline.fingerprints[key]) throw new Error(`code_changed_${key}`);
  });
  const modules = [resolved.tokenModule, resolved.vaultModule, resolved.curveModule,
    resolved.tradeModule, resolved.migrateModule, resolved.customDataModule, tokenImpl]
    .filter(address => address && !same(address, ZeroAddress)).map(getAddress);
  const hashes = await Promise.all(modules.map(address => fingerprint(provider, address)));
  if (modules.length !== Object.keys(baseline.moduleFingerprints).length ||
      modules.some((address, index) => hashes[index] !== baseline.moduleFingerprints[address]))
    throw new Error('code_changed_preset_modules');
  if (JSON.stringify(preset.toArray().map(String)) !== JSON.stringify(baseline.presetConfig))
    throw new Error('preset_changed');
  // This pins the previously reviewed Core, Agent ID trade module, and admin paths.
  // Fingerprints are a change detector, not a proof that the contracts are bug free.
}

export async function preflight(provider, token) {
  const snapshot=walletSnapshot(baw,WALLET);
  const registry = new Contract(REGISTRY, abi('OpenFourRegistry'), provider);
  const core = new Contract(CORE, abi('OpenFourCore'), provider);
  const manager = new Contract(MANAGER, MANAGER_ABI, provider);
  const [head, coreAddress, toolsAddress, zapAddress, wrappedNative, preset,
    whitelist, paused, bnbBalance, status, settings, addresses, agentId] = await Promise.all([
    provider.getBlockNumber(), registry.openFourCore(), registry.openFourTool(),
    core.zapRouter(), core.wrappedNative(), registry.getPreset(PRESET),
    manager.isPresetWhitelistEnabled(PRESET), core.paused(), provider.getBalance(WALLET),
    ...[0,1,2,3].map(i=>snapshot.then(rows=>rows[i])),
  ]);
  if (!same(coreAddress, CORE) || whitelist || paused || !preset.active ||
      !preset.createEnabled) throw new Error('core_preset_or_whitelist_blocked');
  if (status.status !== 'CONNECTED' || !addresses.addresses?.some(x =>
      String(x.binanceChainId) === '56' && same(x.address, WALLET)) || !agentId.claimed)
    throw new Error('wallet_identity_or_agent_id_invalid');
  const devExpires = timeMs(settings.devMode?.expiresAt);
  const sessionExpires = timeMs(settings.sessionExpireTime);
  if (!settings.devMode?.enabled || settings.devMode.balanceExceeded ||
      !Number.isFinite(devExpires) || !Number.isFinite(sessionExpires) ||
      devExpires < Date.now() + 120000 || sessionExpires < Date.now() + 120000)
    throw new Error('wallet_developer_mode_or_session_invalid');
  const cfg = await core.tokens(token, { blockTag: head });
  if (!cfg.exists || cfg.paused || cfg.presetId !== PRESET ||
      !same(cfg.token, token) || Number(cfg.createBlock) > head)
    throw new Error('token_registration_or_preset_invalid');
  const erc = new Contract(token, ERC20_ABI, provider);
  const vault = new Contract(cfg.vault, VAULT_ABI, provider);
  const options = same(cfg.quoteAsset, wrappedNative) ? 0n : 2n;
  const [phase, decimals, beforeToken, supply, tokenCode, vaultCode] = await Promise.all([
    vault.phase({ blockTag: head }), erc.decimals({ blockTag: head }),
    erc.balanceOf(WALLET, { blockTag: head }), erc.totalSupply({ blockTag: head }),
    provider.getCode(token, head),
    provider.getCode(cfg.vault, head),
  ]);
  if (Number(phase) !== 1 || Number(decimals) !== 18 || supply <= 0n ||
      tokenCode === '0x' || vaultCode === '0x' ||
      (options === 2n && same(zapAddress, ZeroAddress)))
    throw new Error('phase_balance_or_quote_route_invalid');
  await checkPinnedContracts(provider, registry, toolsAddress, zapAddress, preset);
  return { head, core, toolsAddress, cfg, options, bnbBalance, beforeToken, supply };
}

async function reconcile(provider, token, path) {
  if (!existsSync(path)) return output({ stage: 'not_started', token });
  let state = JSON.parse(readFileSync(path, 'utf8'));
  const hashes = new Set(state.txHash ? [state.txHash] : []);
  if (!hashes.size) {
    const head = await provider.getBlockNumber();
    const logs = await provider.getLogs({ address: CORE, fromBlock: state.fromBlock,
      toBlock: head, topics: [TRANSFER_TOPIC, toBeHex(token, 32), toBeHex(WALLET, 32), toBeHex(PRESET, 32)] });
    for (const log of logs) hashes.add(log.transactionHash);
    try {
      const history = await baw(['wallet', 'tx-history', '--type', 'all', '--size', '50',
        '--startTime', String(state.startedMs - 60000), '--binanceChainId', '56']);
      for (const item of history.transactions || []) if (/^0x[0-9a-fA-F]{64}$/.test(item.txHash || '')) hashes.add(item.txHash);
    } catch { /* Chain logs remain authoritative when history is unavailable. */ }
  }
  for (const hash of hashes) {
    const tx = await provider.getTransaction(hash);
    if (!tx || tx.blockNumber < state.fromBlock || tx.chainId !== 56n ||
        !same(tx.from, WALLET) || !same(tx.to, CORE) ||
        tx.value !== BigInt(state.valueWei) || keccak256(tx.data) !== state.inputHash) continue;
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) continue;
    const coreInterface = new Interface(abi('OpenFourCore'));
    const trade = receipt.logs.filter(log => same(log.address, CORE)).map(log => {
      try { return coreInterface.parseLog(log); } catch { return null; }
    }).find(x => x?.name === 'TradeExecuted' && same(x.args.token, token) && x.args.isBuy);
    const tokenBalance = await new Contract(token, ERC20_ABI, provider).balanceOf(WALLET);
    state = save(path, { ...state, stage: receipt.status === 1 && trade ? 'confirmed' : 'reverted',
      txHash: hash, receiptBlock: receipt.blockNumber, tokenBalance: tokenBalance.toString(),
      tokensBought: trade?.args.tokenAmount?.toString() ?? null,
      quoteSpent: trade?.args.traderQuoteAmount?.toString() ?? null,
      quoteAsset: trade?.args.quoteAsset ?? null,
      gasWei: (receipt.gasUsed * receipt.gasPrice).toString() });
    return output({ stage: state.stage, token, txHash: hash,
      tokensBought: state.tokensBought ? formatEther(state.tokensBought) : null,
      tokenBalance: formatEther(tokenBalance),
      quoteSpent: state.quoteSpent ? formatEther(state.quoteSpent) : null,
      quoteAsset: state.quoteAsset,
      gasBNB: formatEther(state.gasWei) });
  }
  output({ stage: state.stage, token, orderId: state.orderId ?? null,
    txHash: state.txHash ?? null, note: 'No matching confirmed receipt yet; no retry submitted.' });
}

async function main() {
  const { token, mode, budget: requestedBudget, percentBps, intent, manualConfirm } = parseArgs(process.argv.slice(2));
  const path = statePath(token, intent);
  const provider = new FailoverRpcProvider(process.env.BSC_RPC_HTTP,
    ['https://bsc-rpc.publicnode.com', 'https://rpc-bsc.blockmachine.io']);
  try {
    if (mode === '--status') return await reconcile(provider, token, path);
    if (mode === '--execute' && existsSync(path))
      throw new Error('duplicate_token_attempt_check_status_first');
    if (mode === '--execute') await assertNoUnresolvedBuy(provider,token);
    const { head, core, toolsAddress, cfg, options, bnbBalance, beforeToken, supply } =
      await preflight(provider, token);
    const balanceBudget = bnbBalance - GAS_RESERVE;
    const budget = balanceBudget < (requestedBudget ?? MAX_BUDGET)
      ? balanceBudget : (requestedBudget ?? MAX_BUDGET);
    if (budget <= 0n) throw new Error('insufficient_bnb_after_gas_reserve');
    const tools = new Contract(toolsAddress, abi('OpenFourTools'), provider);
    const cap = supply / 100n;
    if (beforeToken >= cap) throw new Error('wallet_at_one_percent_cap');
    const targetHolding = percentBps === null ? null : supply * percentBps / 10000n;
    const amount = targetHolding === null ? null : targetHolding - beforeToken;
    if (amount !== null && amount <= 0n)
      throw new Error('wallet_already_at_requested_percentage');
    if (amount !== null && amount + beforeToken > cap)
      throw new Error('percent_exceeds_wallet_cap');
    const est = amount === null
      ? await tools.estimateBuyByBudget.staticCall(token, WALLET, budget, options, '0x',
        { blockTag: head })
      : await tools.estimateBuy.staticCall(token, WALLET, amount, options, '0x',
        { blockTag: head });
    const plan = makeBuyPlan({ estimate: est, quoteIsWrappedNative: options === 0n,
      nativeBudgetWei: budget,slippageBps:BigInt(process.env.AGENT_SLIPPAGE_BPS||'3000') });
    const inputData = amount === null
      ? new Interface(abi('OpenFourCore')).encodeFunctionData('buyByBudget',
        [token, plan.maxQuotePay, plan.minTokenOut, plan.options, '0x'])
      : new Interface(abi('OpenFourCore')).encodeFunctionData('buy',
        [token, amount, plan.maxQuotePay, plan.options, '0x']);
    output({ stage: 'quote', token, readBlock: head, presetId: PRESET.toString(),
      quoteAsset: cfg.quoteAsset, maxSpendBNB: formatEther(budget),
      expectedSpendBNB: formatEther(est.userPays), expectedTokens: formatEther(est.tokenAmount),
      targetPercent: percentBps === null ? null : Number(percentBps) / 100,
      maxFeePct: 25, estimatedFeePct: Number(plan.feeBpsFloor) / 100,
      maxSlippagePct: Number(process.env.AGENT_SLIPPAGE_BPS||'3000')/100, rpc: provider.activeSource });
    const call = { from: WALLET, to: CORE, valueWei: budget, inputData };
    if (mode === '--check') {
      const preview = await baw(['contract-call', 'preview', '--binanceChainId', '56',
        '--from', WALLET, '--to', CORE, '--value', budget.toString(), '--inputData', inputData]);
      const details = previewDiagnostics(preview);
      return output({ stage: 'preview_only', token, requireConfirmation: preview.requireConfirmation,
        risks: details.riskDetails, addressRisks: details.addressRisks,
        authorityChangeCount: details.authorityChangeCount,
        simulationCode: details.simulationCode });
    }
    let submitting = false;
    let state;
    try {
      const result = await submitContractCall({ ...call, allowAppConfirmation: true,
        allowMediumRisk: manualConfirm,
        onPreview: async details => { output({ stage: 'preview', token,
          requestId: details.requestId,
          requireConfirmation: details.requireConfirmation, risks: details.riskDetails,
          addressRisks: details.addressRisks,
          riskBehaviors: details.riskBehaviors,
          authorityChangeCount: details.authorityChangeCount,
          simulationCode: details.simulationCode,
          simulationErrorDetail: details.simulationErrorDetail,
          parsedTx: manualConfirm ? details.parsedTx : undefined,
          to: manualConfirm ? CORE : undefined, valueWei: manualConfirm ? budget.toString() : undefined });
          if (manualConfirm) return waitForBrowserApproval(details,{from:WALLET,to:CORE,valueWei:budget,inputData,step:'buy'});
        },
        beforeExecute: preview => {
          if (preview.parsedTx?.contractAddress && !same(preview.parsedTx.contractAddress, CORE))
            throw new Error('preview_target_mismatch');
          mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
          state = save(path, { version: 1, stage: 'submitting', token,
            fromBlock: head, startedMs: Date.now(), beforeToken: beforeToken.toString(),
            beforeBnb: bnbBalance.toString(), valueWei: budget.toString(),
            inputHash: keccak256(inputData), requestId: preview.requestId }, true);
          submitting = true;
        },
      });
      state = save(path, { ...state, stage: result.status === 'BROADCASTED'
        ? 'broadcast' : 'app_confirmation_pending', txHash: result.txHash ?? null,
        orderId: result.orderId ?? null });
      output({ stage: state.stage, token, txHash: state.txHash, orderId: state.orderId,
        previewMs: result.previewMs, totalWalletMs: result.totalWalletMs });
      for(const end=Date.now()+300000;Date.now()<end;){
        try{await reconcile(provider,token,path);}catch{output({stage:'reconciliation_waiting',token});}
        const latest=JSON.parse(readFileSync(path,'utf8'));
        if(['confirmed','reverted'].includes(latest.stage))break;
        await new Promise(r=>setTimeout(r,latest.txHash?(Date.now()-latest.startedMs<5000?150:500):2000));
      }
    } catch (error) {
      if (submitting) save(path, { ...state, stage: 'submission_unknown' });
      throw error;
    }
  } finally { provider.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { output({ stage: 'error', error: code(error),
    apiCode: error?.details?.apiCode ?? null, apiName: error?.details?.apiName ?? null });
    process.exitCode = 1; });
}
