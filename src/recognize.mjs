import { Contract, JsonRpcProvider, ZeroAddress, getAddress } from 'ethers';

// Public protocol addresses only. Verify live implementations before any real trade.
const FOUR_CORE = '0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3';
const FOUR_AGENT_PRESET = 1778027615735n;
const FLAP_FACTORY = '0xC55820f24015bE7c4f18949D9e1363A3609B300e';
const FLAP_READER = '0x18Aa6C93f1887a243fdc348C9A77F5136555174a';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const GANG_PADS = [
  ['v2', '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E'],
  ['soft', '0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7'],
  ['v2', '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb'],
  ['v2', '0x60aee38576035E757deD30fF8db8A8DA476430C1'],
];

const FOUR_ABI = [
  'function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)',
];
const FLAP_FACTORY_ABI = [
  'function marketOfToken(address) view returns (address)',
  'function isMarket(address) view returns (bool)',
];
const FLAP_CARD = 'tuple(address market,address quote,string name,string symbol,string description,address predictedToken,address token,address creator,uint8 phase,uint256 pool,uint256 cap,uint256 progress,uint256 a,uint256 b,uint256 c,uint256 d)[]';
const FLAP_READER_ABI = [`function marketCards(address[]) view returns (${FLAP_CARD})`];
const GANG_V2_ABI = [
  'function curves(address) view returns (address creator,address quote,uint256 realQuote,uint256 sold,uint256 gradAmt,uint256 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
];
const GANG_SOFT_ABI = [
  'function curves(address) view returns (address creator,uint256 realBnb,uint256 sold,bool graduated,address pair)',
];

const same = (a, b) => getAddress(a) === getAddress(b);

export function makeProvider(rpcUrl = process.env.BSC_RPC_HTTP) {
  return new JsonRpcProvider(rpcUrl || 'https://bsc-rpc.publicnode.com', 56);
}

export async function recognize(provider, rawAddress) {
  const address = getAddress(rawAddress);
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) throw new Error('BSC 主网 RPC 配置错误');

  const four = new Contract(FOUR_CORE, FOUR_ABI, provider);
  const fourRecord = await four.tokens(address);
  if (fourRecord.exists && same(fourRecord.token, address) &&
      fourRecord.presetId === FOUR_AGENT_PRESET) {
    const vault = new Contract(fourRecord.vault,
      ['function phase() view returns (uint8)'], provider);
    const phase = Number(await vault.phase());
    return { platform: 'Four.meme', token: address, symbol: fourRecord.symbol,
      phase: phase === 1 ? '内盘' : '非内盘，具体外盘路径需复核',
      quote: fourRecord.quoteAsset };
  }

  const factory = new Contract(FLAP_FACTORY, FLAP_FACTORY_ABI, provider);
  let market = await factory.marketOfToken(address).catch(() => ZeroAddress);
  if (same(market, ZeroAddress) &&
      await factory.isMarket(address).catch(() => false)) market = address;
  if (!same(market, ZeroAddress)) {
    const reader = new Contract(FLAP_READER, FLAP_READER_ABI, provider);
    const [card] = await reader.marketCards([market]);
    if (card && same(card.market, market)) {
      return { platform: 'Flap', token: address, symbol: String(card.symbol).slice(0, 32),
        phase: Number(card.phase) === 1 ? 'ID AGENT CURVE 份额内盘' : '已发行，具体阶段需复核',
        quote: card.quote };
    }
  }

  for (const [kind, pad] of GANG_PADS) {
    const abi = kind === 'soft' ? GANG_SOFT_ABI : GANG_V2_ABI;
    const contract = new Contract(pad, abi, provider);
    const record = await contract.curves(address).catch(() => null);
    if (record && !same(record.creator, ZeroAddress)) {
      return { platform: 'Gang.fun', token: address, symbol: '',
        phase: record.graduated ? '已毕业，具体外盘路径需复核' : '曲线内盘',
        quote: kind === 'soft' ? WBNB : record.quote };
    }
  }
  return null;
}
