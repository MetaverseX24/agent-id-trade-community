import { AbiCoder, Contract, Interface, ZeroAddress, dataSlice, formatUnits,
  getAddress, keccak256, parseEther, toBeHex, toUtf8Bytes } from 'ethers';
import { baw } from './wallet_cli.mjs';

export const PANCAKE_V2_ROUTER = getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E');
export const BNB_NATIVE = getAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
const PAIR_ABI = [
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
];
const ROUTER_ABI = ['function factory() view returns (address)'];
const MIGRATE_TAG = dataSlice(keccak256(toUtf8Bytes('module.migrate.pcs_v2')), 0, 8);

function same(a, b) { return getAddress(a) === getAddress(b); }

export async function migratedPair({ provider, coreAddress, coreInterface,
  token, quoteAsset, fromBlock, toBlock }) {
  const topic = coreInterface.getEvent('MigrateExecuted').topicHash;
  const logs = await provider.getLogs({ address: coreAddress,
    topics: [topic, null, null, toBeHex(token, 32)], fromBlock, toBlock });
  if (!logs.length) throw new Error('migration_event_missing');
  const event = coreInterface.parseLog(logs[logs.length - 1]);
  if (event?.name !== 'MigrateExecuted' || !same(event.args.token, token) ||
      event.args.migrateTagId.toLowerCase() !== MIGRATE_TAG.toLowerCase() ||
      event.args.encodedMigratedData.length !== 66)
    throw new Error('unexpected_migration_route');
  const pairAddress = getAddress(AbiCoder.defaultAbiCoder().decode(
    ['address'], event.args.encodedMigratedData)[0]);
  if (pairAddress === ZeroAddress) throw new Error('zero_migration_pair');
  const pair = new Contract(pairAddress, PAIR_ABI, provider);
  const router = new Contract(PANCAKE_V2_ROUTER, ROUTER_ABI, provider);
  const [t0, t1, factory, routerFactory] = await Promise.all([
    pair.token0(), pair.token1(), pair.factory(), router.factory(),
  ]);
  if (!((same(t0, token) && same(t1, quoteAsset)) ||
        (same(t1, token) && same(t0, quoteAsset))) ||
      !same(factory, routerFactory)) throw new Error('migration_pair_mismatch');
  return { address: pairAddress, pair, tokenIs0: same(t0, token),
    migrateTxHash: logs[logs.length - 1].transactionHash };
}

export async function externalSpotNativeWei({ pairInfo, quoteAsset, wrappedNative,
  tokenDecimals, zapRouter }) {
  const reserves = await pairInfo.pair.getReserves();
  const tokenReserve = pairInfo.tokenIs0 ? reserves[0] : reserves[1];
  const quoteReserve = pairInfo.tokenIs0 ? reserves[1] : reserves[0];
  if (tokenReserve <= 0n || quoteReserve <= 0n) throw new Error('migration_pool_empty');
  const quotePerToken = quoteReserve * 10n ** BigInt(tokenDecimals) / tokenReserve;
  if (same(quoteAsset, wrappedNative)) return quotePerToken;
  const result = await zapRouter.quoteTokenToNative.staticCall(quoteAsset, quotePerToken);
  if (result[0] <= 0n) throw new Error('migration_quote_to_bnb_unavailable');
  return result[0];
}

export async function marketQuoteToBnb({ token, amountWei, decimals }) {
  const result = await baw(['market-order', 'quote', '--fromTokenQty',
    formatUnits(amountWei, decimals), '--fromToken', token, '--toToken', BNB_NATIVE,
    '--binanceChainId', '56', '--slippage', '5']);
  if (!result?.toCoinAmount) throw new Error('market_quote_missing_amount');
  return parseEther(result.toCoinAmount);
}

export async function submitMarketSell({ token, amountWei, decimals }) {
  const result = await baw(['market-order', 'swap', '--fromTokenQty',
    formatUnits(amountWei, decimals), '--fromToken', token, '--toToken', BNB_NATIVE,
    '--binanceChainId', '56', '--slippage', '5', '--mev', 'true',
    '--gasLevel', 'MEDIUM'], 60000);
  if (!result?.orderId) throw new Error('market_order_missing_id');
  return String(result.orderId);
}

export async function marketOrderStatus(orderId) {
  const result = await baw(['market-order', 'list', '--orderId', orderId]);
  const order = result?.list?.find(item => String(item.orderId) === orderId);
  if (!order) throw new Error('market_order_not_found');
  return order;
}
