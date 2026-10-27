import test from 'node:test';
import assert from 'node:assert/strict';
import { candlesFromTrades } from '../src/market.mjs';
test('candles preserve actual trade chronology and never manufacture prices',()=>{
  const rows=candlesFromTrades([{ts:61000,price:2,quoteAmount:4},{ts:62000,price:1,quoteAmount:3},
    {ts:63000,price:3,quoteAmount:6},{ts:120000,price:5,quoteAmount:7}]);
  assert.deepEqual(rows,[{time:60000,open:2,high:3,low:1,close:3,volume:13},
    {time:120000,open:5,high:5,low:5,close:5,volume:7}]);assert.deepEqual(candlesFromTrades([]),[]);
});
