'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectResult, mergeAssets } = require('../lib/scan-result');
const { BUSD_BSC, USDT_BSC, BTCB_BSC, USDT_ETH, WBTC_ETH } = require('../lib/prices');
const address = '0x1111111111111111111111111111111111111111';
const native = { type: 'native', symbol: 'ETH', rawBalance: '100', decimals: 18 };
const token = { type: 'ERC-20', symbol: 'T', contract: '0x2222222222222222222222222222222222222222', rawBalance: '25', decimals: 2 };
const busd = { type: 'BEP-20', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '0', decimals: 18 };
const usdt = { type: 'BEP-20', symbol: 'USDT', contract: USDT_BSC, rawBalance: '0', decimals: 18 };
const btcb = { type: 'BEP-20', symbol: 'BTCB', contract: BTCB_BSC, rawBalance: '0', decimals: 18 };

test('coverage distinguishes unknown components from verified zero and keeps BUSD checks honest', () => {
  const onlyTokens = { coverage: 'tokens-only', components: { native: false, tokens: true }, assets: [token] };
  assert.deepEqual(inspectResult(onlyTokens, 'base'), { native: false, tokens: true, partial: true });
  assert.deepEqual(inspectResult({ coverage: 'native-only', assets: [native] }, 'bitcoin'), { native: true, tokens: false, partial: false });
  assert.equal(inspectResult({ assets: [native] }, 'bnb').partial, true, 'an old unmarked BNB-only result did not verify BUSD');
  assert.throws(() => inspectResult({ coverage: 'bnb-and-busd', assets: [native] }, 'bnb'), /BUSD/);
  assert.equal(inspectResult({ coverage: 'bnb-and-busd', assets: [native, busd] }, 'bnb').partial, false);
  assert.throws(() => inspectResult({ coverage: 'tokens-only', assets: [token] }, 'bnb'), /BUSD/);
  assert.equal(inspectResult({ coverage: 'bnb-and-stables', assets: [native, busd, usdt] }, 'bnb').partial, false);
  assert.throws(() => inspectResult({ coverage: 'bnb-and-stables', assets: [native, busd] }, 'bnb'), /USDT/);
  assert.equal(inspectResult({ coverage: 'bnb-and-known', assets: [native, busd, usdt, btcb] }, 'bnb').partial, false);
  assert.throws(() => inspectResult({ coverage: 'bnb-and-known', assets: [native, busd, usdt] }, 'bnb'), /BTCB/);
  assert.deepEqual(inspectResult({ coverage: 'bnb-tokens-only', components: { native: false, tokens: true }, assets: [busd, usdt, btcb] }, 'bnb'), { native: false, tokens: true, partial: true });
});

test('known Ethereum Multicall results remain independently verified when broad discovery is unavailable', () => {
  const wbtc = { type: 'ERC-20', symbol: 'WBTC', contract: WBTC_ETH, rawBalance: '200000000', decimals: 8, tokenId: null };
  const result = { coverage: 'native-only', components: { native: true, tokens: false, knownTokens: [USDT_ETH, WBTC_ETH] }, assets: [native, wbtc] };
  const coverage = inspectResult(result, 'ethereum');
  assert.deepEqual(coverage, { native: true, tokens: false, partial: true, knownTokens: [USDT_ETH, WBTC_ETH] });
  const previous = [{ ...wbtc, rawBalance: '1' }, { ...token, rawBalance: '5' }];
  const merged = mergeAssets(previous, result.assets, coverage);
  assert.deepEqual(merged, [native, wbtc, { ...token, rawBalance: '5', stale: true }]);
  assert.throws(() => inspectResult({ ...result, assets: [native, { ...token, contract: '0x3333333333333333333333333333333333333333' }] }, 'ethereum'), /Invalid token coverage/);
  assert.throws(() => inspectResult({ ...result, coverage: 'known-tokens-only', components: { native: false, tokens: false }, assets: [wbtc] }, 'ethereum'), /coverage/);
});

test('results reject mismatched wallets, contradictory coverage, duplicates and invalid numeric metadata', () => {
  assert.throws(() => inspectResult({ address: '0x2222222222222222222222222222222222222222', assets: [native] }, 'base', address), /address/);
  assert.throws(() => inspectResult({ network: 'arbitrum', assets: [native] }, 'base', address), /network/);
  assert.throws(() => inspectResult({ coverage: 'complete', components: { native: true, tokens: false }, assets: [native] }, 'base'), /coverage/);
  assert.throws(() => inspectResult({ coverage: 'made-up', assets: [native] }, 'base'), /coverage/);
  assert.throws(() => inspectResult({ assets: [native, token, { ...token }] }, 'base'), /Duplicate/);
  for (const bad of [null, '', -1, 256, 1.5]) assert.throws(() => inspectResult({ assets: [{ ...native, decimals: bad }] }, 'base'), /Invalid/);
  assert.throws(() => inspectResult({ assets: [{ ...native, rawBalance: null }] }, 'base'), /Invalid/);
});

test('component merges retain only missing previous data and replace it on a verified recheck', () => {
  const first = [native, token];
  const coverage = inspectResult({ coverage: 'tokens-only', assets: [{ ...token, rawBalance: '30' }] }, 'base');
  const partial = mergeAssets(first, [{ ...token, rawBalance: '30' }], coverage);
  assert.deepEqual(partial, [{ ...token, rawBalance: '30' }, { ...native, stale: true }]);
  const complete = [ { ...native, rawBalance: '0' }, { ...token, rawBalance: '40' } ];
  assert.deepEqual(mergeAssets(partial, complete, inspectResult({ assets: complete }, 'base')), complete);
  const nativeOnly = mergeAssets(first, [{ ...native, rawBalance: '0' }], { native: true, tokens: false });
  assert.deepEqual(nativeOnly, [{ ...native, rawBalance: '0' }, { ...token, stale: true }]);
});
