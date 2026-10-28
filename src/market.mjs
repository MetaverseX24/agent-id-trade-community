import { AbiCoder, Contract, Interface, JsonRpcProvider, WebSocketProvider, formatEther, formatUnits, getAddress, toBeHex, zeroPadValue } from 'ethers';
import { FLAP, FOUR_CORE, FOUR_PRESET, WBNB } from './engine/agent_ui/platforms.mjs';

const FOUR_CREATED = '0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f';
const FOUR_TRADES = new Interface(['event TradeExecuted(address indexed token,address indexed trader,uint256 indexed presetId,bool isBuy,address quoteAsset,address vault,uint256 requestedTokenAmount,uint256 tokenAmount,uint256 curveQuoteAmount,uint256 traderQuoteAmount,uint256 lastPrice,uint256 slippageLimit,uint256 protocolFee,uint256 taxFee,uint256 devFee,uint256 antiSniperFee,uint256 totalRaised,uint256 remainingForSale)']);
const FOUR_TRADE_TOPIC = FOUR_TRADES.getEvent('TradeExecuted').topicHash;
const FOUR_CORE_READ = ['function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)'];
const FLAP_READER = [
  'function marketPage(uint256,uint256) view returns (address[],uint256,uint256)',
  'function marketCards(address[]) view returns (tuple(address market,address quoteToken,string name,string symbol,string meta,address predictedToken,address token,address pair,uint8 phase,uint256 poolRaw,uint256 capRaw,uint256 progressBps,uint256 buyCount,uint256 sellCount,uint256 curveH,uint256 curveK)[])',
];
const TEMPLATE_TOPIC = zeroPadValue(toBeHex(FOUR_PRESET), 32);
const GANG_BASE = 'https://gang.fun/api';
const GANG_V2_PAD = '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E';
const GANG_CREATED = '0xd23a447045c377a966a79f59983bae21db7b92fead61df8ace4aea5628043791';
const FSI_BASE = 'https://fsi.taxed.fun/fsi/v1';
const STABLE = new Set(['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d']);
const num = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const ms = value => { const n = num(value); return n < 1e12 ? n * 1000 : n; };
const key = value => String(value || '').toLowerCase();
const quoteLabel = address => key(address) === key(WBNB) || /^0x0+$/.test(key(address)) ? 'BNB' :
  key(address) === '0x0c6302401aa5325c2e36f170f52c00b1d220b405' ? 'GANG' :
  STABLE.has(key(address)) ? 'USD' : `${String(address).slice(0, 6)}…`;

export function candlesFromTrades(rows, bucketMs = 60_000) {
  const buckets = new Map();
  for (const row of [...rows].sort((a, b) => a.ts - b.ts)) {
    if (!(row.ts > 0 && row.price > 0)) continue;
    const time = Math.floor(row.ts / bucketMs) * bucketMs;
    const c = buckets.get(time);
    if (c) { c.high = Math.max(c.high, row.price); c.low = Math.min(c.low, row.price);
      c.close = row.price; c.volume += row.quoteAmount || 0; }
    else buckets.set(time, { time, open: row.price, high: row.price, low: row.price,
      close: row.price, volume: row.quoteAmount || 0 });
  }
  return [...buckets.values()].slice(-180);
}

async function json(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`source_http_${response.status}`);
  return response.json();
}

export class MarketData {
  constructor(provider = new JsonRpcProvider('https://bsc-rpc.publicnode.com', 56, { staticNetwork: true }),rpcWs='') {
    this.provider = provider;
    this.four = new Contract(FOUR_CORE, FOUR_CORE_READ, provider);
    this.flap = new Contract(FLAP.reader, FLAP_READER, provider);
    this.rows = new Map();
    this.sources = { four: null, flap: null, gang: null };
    this.lastFourBlock = 0;
    this.lastGangBlock = 0;
    this.flapTimeAttempted = new Set();
    this.running = false;
    this.rpcWs=rpcWs;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 8_000);
    this.timer.unref?.();
    if(this.rpcWs){this.ws=new WebSocketProvider(this.rpcWs,56,{staticNetwork:true});
      this.ws.on('block',()=>this.tick()).catch(()=>{});
      this.ws.websocket.on?.('error',()=>{});}
  }
  stop(){clearInterval(this.timer);this.running=false;this.ws?.destroy().catch(()=>{});}

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const tasks = [['four', () => this.pullFour()], ['flap', () => this.pullFlap()], ['gang', () => this.pullGang()]];
      await Promise.all(tasks.map(async ([name, work]) => {
        try { const result = await work(); this.sources[name] = { ok: true, at: Date.now(), ...result }; }
        catch (error) { this.sources[name] = { ok: false, at: Date.now(), error: String(error.message || error).slice(0, 80) }; }
      }));
    } finally { this.busy = false; }
  }

  upsert(row) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(row.token || '')) return;
    const id = key(row.token);
    this.rows.set(id, { ...this.rows.get(id), ...row, token: getAddress(row.token) });
    if (this.rows.size > 400) {
      const oldest = [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.rows.delete(key(oldest.token));
    }
  }

  list() {
    return { updatedAt: Date.now(), sources: this.sources,
      tokens: [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 240) };
  }

  async pullFour() {
    const head = await this.provider.getBlockNumber();
    const from = this.lastFourBlock ? Math.max(this.lastFourBlock - 2, head - 5000) : head - 5000;
    const found = [];
    for (let n = from; n <= head; n += 1000) {
      found.push(...await this.provider.getLogs({ address: FOUR_CORE,
        topics: [FOUR_CREATED, TEMPLATE_TOPIC], fromBlock: n, toBlock: Math.min(head, n + 999) }));
    }
    const recent = found.slice(-100).filter(log => !this.rows.has(key(`0x${log.topics[3].slice(26)}`)));
    await Promise.all(recent.map(async log => {
      const token = getAddress(`0x${log.topics[3].slice(26)}`);
      const cfg = await this.four.tokens(token);
      if (!cfg.exists || cfg.presetId !== FOUR_PRESET) return;
      const phase = await new Contract(cfg.vault, ['function phase() view returns (uint8)'], this.provider)
        .phase().catch(() => null);
      this.upsert({ token, platform: 'four', name: String(cfg.name).slice(0, 64),
        symbol: String(cfg.symbol).slice(0, 24), quote: quoteLabel(cfg.quoteAsset),
        quoteAddress: cfg.quoteAsset, vault: cfg.vault,
        phase: phase === 1n ? 'curve' : 'graduated', createdAt: 0,
        block: log.blockNumber, source: 'Four.meme 链上创建事件' });
    }));
    this.lastFourBlock = head;
    for (const row of this.rows.values()) if (row.platform === 'four' && !row.createdAt) {
      // Chain block timestamps are authoritative; one read per block, then cached by this row.
      const block = await this.provider.getBlock(row.block);
      row.createdAt = Number(block.timestamp) * 1000;
    }
    const stale = [...this.rows.values()].filter(row => row.platform === 'four' && row.vault &&
      Date.now() - (row.phaseCheckedAt || 0) > 60_000);
    await Promise.all(stale.map(async row => {
      const phase = await new Contract(row.vault, ['function phase() view returns (uint8)'], this.provider)
        .phase().catch(() => null);
      if (phase !== null) row.phase = phase === 1n ? 'curve' : 'graduated';
      row.phaseCheckedAt = Date.now();
    }));
  }

  async pullFlap() {
    const first = await this.flap.marketPage(0, 1);
    const total = Number(first[2]);
    const from = Math.max(0, total - 48);
    for (let cursor = from; cursor < total; cursor += 16) {
      const page = await this.flap.marketPage(cursor, Math.min(16, total - cursor));
      const addresses = [...page[0]];
      if (!addresses.length) continue;
      const cards = await this.flap.marketCards(addresses);
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const token = c.phase === 1n ? c.predictedToken : c.token;
        const existing = this.rows.get(key(token));
        this.upsert({ token, market: c.market, platform: 'flap', name: String(c.name).slice(0, 64),
          symbol: String(c.symbol).slice(0, 24), quote: quoteLabel(c.quoteToken),
          quoteAddress: c.quoteToken, phase: c.phase === 1n ? 'curve' : c.phase === 2n ? 'launching' : 'graduated',
          progress: Number(c.progressBps) / 100, createdAt: existing?.createdAt || 0,
          order: cursor + i, source: 'Flap Agent Reader 链上登记' });
      }
    }
    const latest = [...this.rows.values()].filter(x => x.platform === 'flap' && !x.createdAt &&
      !this.flapTimeAttempted.has(key(x.market))).sort((a, b) => b.order - a.order).slice(0, 16);
    await Promise.all(latest.map(async row => {
      this.flapTimeAttempted.add(key(row.market));
      try {
        const data = await json(`${FSI_BASE}/${row.market.toLowerCase()}/G/virtualBuyFill?sort=time_asc&limit=1`);
        row.createdAt = ms(data.items?.[0]?.updatedAt);
      } catch { /* The Reader index still gives a reliable platform-local newest order. */ }
    }));
  }

  async pullGang() {
    let apiError;
    try {
      const results=await Promise.allSettled([
        json(`${GANG_BASE}/stocks/tokens?limit=100&offset=0`),
        json(`${GANG_BASE}/v3/tokens?status=all&limit=100`),
        json(`${GANG_BASE}/fair/sales?status=all&limit=100`)]);
      const successful=results.filter(x=>x.status==='fulfilled');
      if(!successful.length)throw Error('gang_lists_unavailable');
      for (const x of successful.flatMap(x=>x.value.items||[])) {
        this.upsert({ token: x.address, platform: 'gang', name: String(x.name || '').slice(0, 64),
          symbol: String(x.symbol || '').slice(0, 24), quote: x.quoteSymbol || 'BNB',
          quoteAddress: x.quoteAddress || WBNB, phase: x.graduated||x.status==='launched' ? 'graduated' : 'curve',kind:x.track||'v2',
          progress: num(x.progressPct), marketCapUsd: num(x.fdvUsd),
          createdAt: ms(x.createdAt), source: 'Gang.fun 公开列表' });
      }
    } catch (error) { apiError = error; }
    try { await this.pullGangChain(); }
    catch (error) { if (apiError) throw new Error(`gang_api_and_chain_failed: ${error.message}`); }
    if (apiError) return { degraded: '公开接口不可用，改用链上创建事件' };
  }

  async pullGangChain() {
    const head = await this.provider.getBlockNumber();
    const from = this.lastGangBlock ? Math.max(this.lastGangBlock - 2, head - 1500) : head - 1500;
    for (let n = from; n <= head; n += 1000) {
      const logs = await this.provider.getLogs({ address: GANG_V2_PAD,
        topics: [GANG_CREATED], fromBlock: n, toBlock: Math.min(head, n + 999) });
      for (const log of logs) {
        const token = getAddress(`0x${log.topics[1].slice(26)}`);
        if (this.rows.has(key(token))) continue;
        const quoteAddress = getAddress(`0x${log.topics[3].slice(26)}`);
        let name = '', symbol = '';
        try { [name, symbol] = AbiCoder.defaultAbiCoder().decode(['string','string'], log.data); }
        catch { /* Keep contract address visible when metadata cannot be decoded. */ }
        const block = await this.provider.getBlock(log.blockNumber);
        this.upsert({ token, platform: 'gang', name: String(name).slice(0, 64),
          symbol: String(symbol).slice(0, 24), quote: quoteLabel(quoteAddress),
          quoteAddress, phase: 'curve', createdAt: Number(block.timestamp) * 1000,
          source: 'Gang V2 链上创建事件' });
      }
    }
    this.lastGangBlock = head;
  }

  async detail(info,interval='1m') {
    const bucketMs={'1m':60000,'5m':300000,'15m':900000,'1h':3600000}[interval];if(!bucketMs)throw Error('invalid_chart_interval');
    const quoteDecimals=!info.quote||/^0x0+$/.test(info.quote)?18:
      Number(await new Contract(info.quote,['function decimals() view returns(uint8)'],this.provider).decimals());
    const token = getAddress(info.token);
    let trades = [], source = '', chartSource = '';
    if (info.platform === 'four') {
      const cfg = await this.four.tokens(token);
      const head = await this.provider.getBlockNumber();
      const from = Math.max(Number(cfg.createBlock), head - 5000);
      const logs = [];
      for (let n = from; n <= head; n += 1000) logs.push(...await this.provider.getLogs({
        address: FOUR_CORE, topics: [FOUR_TRADE_TOPIC, zeroPadValue(token, 32)],
        fromBlock: n, toBlock: Math.min(head, n + 999) }));
      const blockTimes = new Map();
      const recentLogs = logs.slice(-120);
      const blocks = [...new Set(recentLogs.map(x => x.blockNumber))];
      for (let n = 0; n < blocks.length; n += 20) {
        await Promise.all(blocks.slice(n, n + 20).map(async blockNumber => {
          blockTimes.set(blockNumber, Number((await this.provider.getBlock(blockNumber)).timestamp) * 1000);
        }));
      }
      for (const log of recentLogs) {
        const a = FOUR_TRADES.parseLog(log).args;
        trades.push({ ts: blockTimes.get(log.blockNumber), side: a.isBuy ? 'buy' : 'sell',
          tokens: num(formatEther(a.tokenAmount)), quoteAmount: num(formatUnits(a.traderQuoteAmount,quoteDecimals)),
          price: num(formatUnits(a.lastPrice,quoteDecimals)), trader: a.trader, tx: log.transactionHash });
      }
      source = `Four.meme 链上成交，最近 ${head - from + 1} 个区块`;
    } else if (info.platform === 'gang') {
      const segment = info.kind === 'soft' ? '' : info.kind==='v3'?'/v3':info.kind==='fair'?'/fair':'/stocks';
      const resource=info.kind==='fair'?'sales':'tokens';
      const data = await json(`${GANG_BASE}${segment}/${resource}/${token}/trades?limit=200&offset=0&sort=ts_desc`);
      trades = (data.items || []).map(x => ({ ts: ms(x.ts), side: x.side,
        tokens: num(x.tokens), quoteAmount: num(x.quoteIn ?? x.bnb ?? x.quoteOut),
        price: num(x.price), trader: x.trader, tx: x.tx })).sort((a, b) => a.ts - b.ts);
      source = 'Gang.fun 公开成交接口';
    } else if (info.platform === 'flap') {
      const market = getAddress(info.market);
      const sides = await Promise.all(['virtualBuyFill', 'virtualSellFill'].map(ns =>
        json(`${FSI_BASE}/${market.toLowerCase()}/G/${ns}?sort=time_desc&limit=120`)));
      trades = sides.flatMap((data, i) => (data.items || []).filter(x => x.confirmed).map(x => {
        const quoteAmount = num(x.amount) / (10**quoteDecimals), tokens = num(x.extra) / 1e18;
        return { ts: ms(x.updatedAt), side: i ? 'sell' : 'buy', tokens, quoteAmount,
          price: tokens > 0 ? quoteAmount / tokens : 0, trader: x.actor, tx: x.txHash };
      })).sort((a, b) => a.ts - b.ts);
      source = 'Flap 成交索引';
    }
    trades = trades.filter(x => x.ts && x.price > 0).slice(-200);
    let candles = candlesFromTrades(trades,bucketMs);
    chartSource = source;
    if (info.phase === 'graduated' && info.pair) {
      try {
        const frame=interval==='1h'?'hour':'minute',aggregate=interval==='1h'?1:bucketMs/60000;
        const data = await json(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${info.pair}/ohlcv/${frame}?aggregate=${aggregate}&limit=180&currency=usd&token=${token}`);
        const rows = data?.data?.attributes?.ohlcv_list || [];
        if (rows.length) {
          candles = rows.map(x => ({ time: ms(x[0]), open: num(x[1]), high: num(x[2]),
            low: num(x[3]), close: num(x[4]), volume: num(x[5]) })).sort((a, b) => a.time - b.time);
          chartSource = `GeckoTerminal 外盘池 USD ${interval==='1h'?'1 小时':parseInt(interval)+' 分钟'} K 线`;
        }
      } catch { /* Keep the available venue trades, with their original source label. */ }
    }
    return { token, platform: info.platform, phase: info.phase, quote: quoteLabel(info.quote),interval,summary:this.rows.get(key(token))||null,
      source, chartSource, updatedAt: Date.now(), candles, trades: trades.slice(-60).reverse() };
  }
}
