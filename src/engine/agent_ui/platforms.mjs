import { Contract, Interface, ZeroAddress, getAddress } from 'ethers';
import { migratedPair } from '../external_market.mjs';
import {detectModernGang} from './gang_protocol.mjs';

export const WALLET = getAddress(process.env.AGENT_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000');
export const WBNB = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
export const BNB = getAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
export const ROUTER = getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E');
export const FOUR_CORE = getAddress('0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3');
export const FOUR_PRESET = 1778027615735n;
export const FLAP = Object.freeze({
  portal: getAddress('0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062'),
  factory: getAddress('0xC55820f24015bE7c4f18949D9e1363A3609B300e'),
  reader: getAddress('0x18Aa6C93f1887a243fdc348C9A77F5136555174a'),
  standardPortal: getAddress('0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0'),
});
export const GANG_PADS = Object.freeze([
  { id: 'v2', address: getAddress('0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E'), kind: 'v2' },
  { id: 'soft', address: getAddress('0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7'), kind: 'soft' },
  { id: 'u', address: getAddress('0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb'), kind: 'v2' },
  { id: 's', address: getAddress('0x60aee38576035E757deD30fF8db8A8DA476430C1'), kind: 'v2' },
]);
const ERC20 = [
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function locked() view returns (bool)',
];
const GANG_V2 = [
  'function curves(address) view returns (address creator,address quote,uint256 realQuote,uint256 sold,uint256 gradAmt,uint256 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
  'function walletRoom(address,address) view returns (uint256)',
  'function buy(address,uint256,uint256)', 'function sell(address,uint256,uint256)',
];
const GANG_S=GANG_V2.map(x=>x.startsWith('function curves(')?x.replace(',bool taxed',''):x);
const GANG_SOFT = [
  'function curves(address) view returns (address creator,uint256 realBnb,uint256 sold,bool graduated,address pair)',
  'function walletRoom(address,address) view returns (uint256)',
  'function quoteBuy(address,address,uint256) view returns (uint256,uint256,uint256,uint256)',
  'function quoteSell(address,uint256) view returns (uint256,uint256)',
  'function buy(address,uint256) payable', 'function sell(address,uint256,uint256)',
];
const FLAP_FACTORY = [
  'function marketOfToken(address) view returns (address)', 'function isMarket(address) view returns (bool)',
];
const FLAP_CARD = 'tuple(address market,address quote,string name,string symbol,string description,address predictedToken,address token,address creator,uint8 phase,uint256 pool,uint256 cap,uint256 progress,uint256 a,uint256 b,uint256 c,uint256 d)[]';
const FLAP_READER = [`function marketCards(address[]) view returns (${FLAP_CARD})`];
const FLAP_MARKET = [
  'function sharesOf(address) view returns (uint256)',
  'function maxSharesPerWallet() view returns (uint256)',
];
const FLAP_PORTAL = [
  'function quoteBuy(address,address,uint256) view returns (uint256,uint256,uint256,uint256)',
  'function quoteSellAll(address,address) view returns (uint256,uint256,uint256,uint256)',
  'function buy(address,uint256) payable',
  'function buyWithQuote(address,uint256,uint256)',
  'function sellBps(address,uint256,uint256)',
  'function claim(address)',
];
const FLAP_STANDARD = [
  'function getTokenV8Safe(address) view returns (tuple(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId))',
  'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount)) returns (uint256)',
  'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData)) payable returns (uint256)',
];
const FOUR_VAULT = ['function phase() view returns (uint8)'];
const PCS_FACTORY = ['function getPair(address,address) view returns (address)'];
const PCS_ROUTER = [
  'function factory() view returns (address)',
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function getAmountsIn(uint256,address[]) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
];
const PCS_PAIR = [
  'function factory() view returns (address)', 'function token0() view returns (address)',
  'function token1() view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)',
];
export const ABI = Object.freeze({ ERC20, GANG_V2, GANG_SOFT, GANG_S, FLAP_PORTAL, FLAP_MARKET, FLAP_STANDARD, PCS_ROUTER });
export const IFACE = Object.freeze({
  erc20: new Interface(ERC20),
  gangV2: new Interface(GANG_V2), gangSoft: new Interface(GANG_SOFT),
  flapPortal: new Interface(FLAP_PORTAL), router: new Interface(PCS_ROUTER),
  flapStandard: new Interface(FLAP_STANDARD),
});
const isSame = (a, b) => getAddress(a) === getAddress(b);
const factoryPromises=new WeakMap();
function routerFactory(provider){let pending=factoryPromises.get(provider);if(!pending){pending=new Contract(ROUTER,PCS_ROUTER,provider).factory()
  .catch(e=>{factoryPromises.delete(provider);throw e;});factoryPromises.set(provider,pending);}return pending;}

export async function verifiedPair(provider, token, quote) {
  const router = new Contract(ROUTER, PCS_ROUTER, provider);
  const factoryAddress = await routerFactory(provider);
  const factory = new Contract(factoryAddress, PCS_FACTORY, provider);
  const address = await factory.getPair(token, quote);
  if (isSame(address, ZeroAddress)) return null;
  const pair = new Contract(address, PCS_PAIR, provider);
  const [actualFactory, a, b, reserves] = await Promise.all([
    pair.factory(), pair.token0(), pair.token1(), pair.getReserves(),
  ]);
  if (!isSame(actualFactory, factoryAddress) ||
      !((isSame(a, token) && isSame(b, quote)) || (isSame(a, quote) && isSame(b, token))) ||
      reserves[0] <= 0n || reserves[1] <= 0n) return null;
  return getAddress(address);
}

async function detectFour(provider, token, fourAbi) {
  const core = new Contract(FOUR_CORE, fourAbi, provider);
  let cfg;
  try { cfg = await core.tokens(token); } catch { return null; }
  if (!cfg.exists || !isSame(cfg.token, token) || cfg.presetId !== FOUR_PRESET) return null;
  const vault = new Contract(cfg.vault, FOUR_VAULT, provider);
  const phase = Number(await vault.phase());
  const result = { platform: 'four', label: 'Four.meme Agent', token,
    phase: phase === 1 ? 'curve' : 'graduated', quote: getAddress(cfg.quoteAsset),
    venue: FOUR_CORE, template: FOUR_PRESET.toString() };
  if (phase !== 1) {
    const current = await provider.getBlockNumber();
    const step = 4000;
    const coreInterface = new Interface(fourAbi);
    for (let end = current; end >= Number(cfg.createBlock); end -= step) {
      try {
        const migrated = await migratedPair({ provider, coreAddress:FOUR_CORE,
          coreInterface, token, quoteAsset:cfg.quoteAsset,
          fromBlock:Math.max(Number(cfg.createBlock),end-step+1), toBlock:end });
        result.pair = migrated.address;
        break;
      } catch (error) {
        if (error.message !== 'migration_event_missing') throw error;
      }
    }
  }
  return result;
}

async function detectFlap(provider, address, wallet=WALLET) {
  const factory = new Contract(FLAP.factory, FLAP_FACTORY, provider);
  let market = await factory.marketOfToken(address).catch(() => ZeroAddress);
  if (isSame(market, ZeroAddress) && await factory.isMarket(address).catch(() => false)) market = address;
  if (isSame(market, ZeroAddress)) return null;
  const reader = new Contract(FLAP.reader, FLAP_READER, provider);
  const [card] = await reader.marketCards([market]);
  if (!card || !isSame(card.market, market)) throw new Error('flap_market_card_mismatch');
  const phase = Number(card.phase);
  const token = phase === 1 ? getAddress(card.predictedToken) : getAddress(card.token);
  if (!isSame(address, market) && !isSame(address, token) &&
      !isSame(address, card.predictedToken)) throw new Error('flap_token_mismatch');
  const result = { platform: 'flap', label: 'Flap ID Agent', token, market: getAddress(market),
    phase: phase === 1 ? 'curve' : 'launched', quote: getAddress(card.quote),
    symbol: String(card.symbol).slice(0, 32), venue: FLAP.portal };
  if (phase === 1) {
    const m = new Contract(market, FLAP_MARKET, provider);
    const [held, cap] = await Promise.all([m.sharesOf(wallet), m.maxSharesPerWallet()]);
    result.held = held;
    result.cap = cap;
    result.unit = 'shares';
  } else if (!isSame(token, ZeroAddress)) {
    const portal = new Contract(FLAP.standardPortal, FLAP_STANDARD, provider);
    const standard = await portal.getTokenV8Safe(token);
    result.standardStatus = Number(standard.status);
    result.nativeToQuoteSwapEnabled = standard.nativeToQuoteSwapEnabled;
    const quote = isSame(standard.quoteTokenAddress, ZeroAddress) ? WBNB :
      getAddress(standard.quoteTokenAddress);
    if (standard.status === 1n) {
      result.phase = 'standard_curve';
      result.quote = quote;
    }
    if (standard.status === 4n && !isSame(standard.pool, ZeroAddress)) {
      if (await provider.getCode(standard.pool) !== '0x') {
        result.phase = 'graduated';
        result.quote = quote;
        result.pair = getAddress(standard.pool);
        result.externalVia = 'flap_portal';
      }
    }
  }
  return result;
}

async function detectGang(provider, token, wallet=WALLET) {
  const modern=await detectModernGang(provider,token,wallet,{ercAbi:ERC20,wbnb:WBNB,verifiedPair});
  if(modern)return modern;
  for (const pad of GANG_PADS) {
    const contract = new Contract(pad.address, pad.kind === 'soft' ? GANG_SOFT : pad.id==='s'?GANG_S:GANG_V2, provider);
    let curve;
    try { curve = await contract.curves(token); } catch { continue; }
    if (isSame(curve.creator, ZeroAddress)) continue;
    const erc = new Contract(token, ERC20, provider);
    const [locked, supply, held] = await Promise.all([
      erc.locked().catch(() => null), erc.totalSupply(), erc.balanceOf(wallet),
    ]);
    if (locked === null) throw new Error('gang_lock_state_unknown');
    const rawQuote = pad.kind === 'soft' ? WBNB : getAddress(curve.quote);
    const quote = isSame(rawQuote, ZeroAddress) ? WBNB : rawQuote;
    const result = { platform: 'gang', label: 'Gang.fun Agent', token,
      phase: locked ? 'curve' : 'graduated', quote, venue: pad.address,
      pad: pad.id, kind: pad.kind, held, supply, curve };
    if (!locked) {
      const actual = await verifiedPair(provider, token, quote);
      if (actual && isSame(actual, curve.pair)) result.pair = actual;
    }
    return result;
  }
  return null;
}

export async function detectAgentToken(provider, raw, fourAbi,wallet=WALLET) {
  const token = getAddress(raw);
  for (const detect of [() => detectFour(provider, token, fourAbi),
    () => detectFlap(provider, token,wallet), () => detectGang(provider, token,wallet)]) {
    const found = await detect();
    if (found) return found;
  }
  throw new Error('not_agent_launch_token');
}
