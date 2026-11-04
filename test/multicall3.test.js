'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { multicallInterface, MULTICALL3_ADDRESS } = require('../lib/multicall3');
const { scanWallet } = require('../lib/scanner');
const { scanDirect } = require('../public/direct-scan');
const { inspectResult, mergeAssets } = require('../lib/scan-result');
const { BUSD_BSC, USDT_BSC, BTCB_BSC, USDT_ETH, WBTC_ETH } = require('../lib/prices');

const address = '0x1234567890123456789012345678901234567890';
const ethereumTokens = [USDT_ETH, WBTC_ETH];
function ok(body) { return { ok: true, json: async () => body }; }
function rpcResult(id, result) { return ok({ jsonrpc: '2.0', id, result }); }
function encodeUint(method, raw) { return multicallInterface.encodeFunctionResult(method, [raw]); }

function createMulticallFetcher(network, balances, { failedContracts = [], explorerTokens = [] } = {}) {
  const calls = [];
  const endpoint = network === 'bnb' ? 'https://bsc-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com';
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === endpoint) {
      const request = JSON.parse(options.body);
      if (request.method === 'eth_blockNumber') return rpcResult(request.id, '0x123');
      assert.equal(request.method, 'eth_call');
      assert.deepEqual(request.params[1], '0x123', 'the aggregate is pinned to the captured block');
      assert.equal(request.params[0].to.toLowerCase(), MULTICALL3_ADDRESS);
      const [batchCalls] = multicallInterface.decodeFunctionData('aggregate3', request.params[0].data);
      const responseItems = batchCalls.map(([target, allowFailure, data]) => {
        assert.equal(allowFailure, true);
        const selector = data.slice(0, 10).toLowerCase();
        if (selector === multicallInterface.getFunction('getEthBalance').selector.toLowerCase()) {
          return [true, encodeUint('getEthBalance', balances.native)];
        }
        assert.equal(selector, multicallInterface.getFunction('balanceOf').selector.toLowerCase());
        if (failedContracts.some(contract => contract.toLowerCase() === target.toLowerCase())) return [false, '0x'];
        const raw = balances.tokens[target.toLowerCase()];
        assert.notEqual(raw, undefined, `unexpected token contract ${target}`);
        return [true, encodeUint('balanceOf', raw)];
      });
      return rpcResult(request.id, multicallInterface.encodeFunctionResult('aggregate3', [responseItems]));
    }
    if (url === 'https://eth.blockscout.com/api/v2/addresses/' + address + '/token-balances') return ok(explorerTokens);
    if (url === 'https://eth.blockscout.com/api/v2/stats') return ok({ coin_price: '2000' });
    if (url === 'https://eth.blockscout.com/api/v2/addresses/' + address) return ok({ coin_balance: '9000000000000000000' });
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetcher, calls };
}

function indexedToken(contract, symbol, value, decimals) {
  return { value, token: { name: symbol, symbol, decimals: String(decimals), type: 'ERC-20', exchange_rate: null, address_hash: contract } };
}

test('Ethereum Multicall3 pins ETH, USDT and WBTC together and preserves broad Blockscout discovery', async () => {
  const other = '0x2222222222222222222222222222222222222222';
  const { fetcher, calls } = createMulticallFetcher('ethereum', {
    native: '1000000000000000000', tokens: { [USDT_ETH]: '5000000', [WBTC_ETH]: '200000000' },
  }, { explorerTokens: [indexedToken(USDT_ETH, 'USDT', '4000000', 6), indexedToken(other, 'OTHER', '42', 0)] });
  const result = await scanWallet(address, 'ethereum', fetcher);
  assert.equal(result.components.native, true);
  assert.equal(result.components.tokens, true);
  assert.equal(result.assets.find(asset => asset.type === 'native').rawBalance, '1000000000000000000');
  const usdt = result.assets.find(asset => asset.contract === USDT_ETH);
  const wbtc = result.assets.find(asset => asset.contract === WBTC_ETH);
  assert.equal(usdt.rawBalance, '5000000', 'the pinned Multicall result replaces the explorer copy');
  assert.equal(usdt.decimals, 6);
  assert.equal(wbtc.rawBalance, '200000000');
  assert.equal(wbtc.decimals, 8);
  assert.equal(result.assets.find(asset => asset.contract === other).rawBalance, '42');
  assert.equal(result.multicallBlockNumber, '0x123');
  assert.ok(calls.some(call => call.url.endsWith('/token-balances')), 'full Blockscout token discovery remains enabled');
  assert.equal(calls.some(call => call.url.endsWith(`/addresses/${address}`)), false, 'Multicall supplies the Ethereum native balance');
});

test('known Ethereum tokens remain available when Blockscout discovery fails, without claiming broad coverage', async () => {
  const { fetcher: base } = createMulticallFetcher('ethereum', {
    native: '1000000000000000000', tokens: { [USDT_ETH]: '5000000', [WBTC_ETH]: '0' },
  });
  const fetcher = async (url, options) => url.endsWith('/token-balances')
    ? { ok: false, status: 503 }
    : base(url, options);
  const result = await scanWallet(address, 'ethereum', fetcher);
  assert.equal(result.coverage, 'native-only');
  assert.deepEqual(result.components, { native: true, tokens: false, knownTokens: [USDT_ETH, WBTC_ETH] });
  assert.equal(result.assets.find(asset => asset.contract === USDT_ETH).rawBalance, '5000000');
  assert.equal(result.assets.some(asset => asset.contract === WBTC_ETH), false, 'zero balances need not be rendered as assets');
  const coverage = inspectResult(result, 'ethereum', address);
  assert.deepEqual(coverage, { native: true, tokens: false, partial: true, knownTokens: [USDT_ETH, WBTC_ETH] });
  const previous = [
    { type: 'ERC-20', contract: USDT_ETH, rawBalance: '4', decimals: 6 },
    { type: 'ERC-20', contract: WBTC_ETH, rawBalance: '9', decimals: 8 },
    { type: 'ERC-20', contract: '0x4444444444444444444444444444444444444444', rawBalance: '3', decimals: 0 },
  ];
  const merged = mergeAssets(previous, result.assets, coverage);
  assert.equal(merged.find(asset => asset.contract === USDT_ETH).rawBalance, '5000000');
  assert.equal(merged.some(asset => asset.contract === WBTC_ETH), false, 'a verified zero removes its previous positive balance');
  assert.equal(merged.find(asset => asset.contract?.startsWith('0x4444')).stale, true, 'unindexed old tokens remain visible but stale');
});

test('BNB Multicall3 batches native BNB, existing BUSD/USDT and BTCB in one pinned call', async () => {
  for (const scanner of [scanWallet, scanDirect]) {
    const { fetcher, calls } = createMulticallFetcher('bnb', {
      native: '1000000000000000000', tokens: {
        [BUSD_BSC]: '25000000000000000000', [USDT_BSC]: '40000000000000000000', [BTCB_BSC]: '60000000000000000000',
      },
    });
    const result = await scanner(address, 'bnb', fetcher);
    assert.equal(result.coverage, 'bnb-and-known');
    assert.deepEqual(result.components, { native: true, tokens: true });
    assert.equal(result.multicallBlockNumber, '0x123');
    assert.deepEqual(result.assets.map(asset => asset.contract), [undefined, BUSD_BSC, USDT_BSC, BTCB_BSC]);
    assert.deepEqual(result.assets.map(asset => asset.rawBalance), [
      '1000000000000000000', '25000000000000000000', '40000000000000000000', '60000000000000000000',
    ]);
    assert.equal(calls.length, 2, 'only eth_blockNumber and one aggregate3 eth_call are required');
  }
});

test('failed Multicall3 subcalls use individual legacy calls without losing BNB coverage', async () => {
  const { fetcher: batchFetcher, calls } = createMulticallFetcher('bnb', {
    native: '1000000000000000000', tokens: {
      [BUSD_BSC]: '1', [USDT_BSC]: '2', [BTCB_BSC]: '3',
    },
  }, { failedContracts: [USDT_BSC] });
  const fetcher = async (url, options) => {
    if (url !== 'https://bsc-rpc.publicnode.com') return batchFetcher(url, options);
    const request = JSON.parse(options.body);
    if (request.method !== 'eth_call' || request.id === 73102) return batchFetcher(url, options);
    if (request.method === 'eth_getBalance') return rpcResult(request.id, '0xde0b6b3a7640000');
    const contract = request.params[0].to.toLowerCase();
    if (contract === USDT_BSC) return rpcResult(request.id, `0x${'2'.padStart(64, '0')}`);
    throw new Error(`Unexpected legacy call ${request.method} ${contract}`);
  };
  const result = await scanWallet(address, 'bnb', fetcher);
  assert.equal(result.coverage, 'bnb-and-known');
  assert.deepEqual(result.assets.map(asset => asset.rawBalance), ['1000000000000000000', '1', '2', '3']);
  assert.ok(calls.length >= 2);
});

test('an unavailable BNB Multicall3 falls back to the original individual RPC queries', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://bsc-rpc.publicnode.com');
    const request = JSON.parse(options.body); requests.push(request);
    if (request.method === 'eth_blockNumber') return { ok: false, status: 503 };
    if (request.method === 'eth_getBalance') return rpcResult(request.id, '0xde0b6b3a7640000');
    const balances = { [BUSD_BSC]: '11', [USDT_BSC]: '22', [BTCB_BSC]: '33' };
    const contract = request.params[0].to.toLowerCase();
    return rpcResult(request.id, `0x${BigInt(balances[contract]).toString(16).padStart(64, '0')}`);
  };
  const result = await scanWallet(address, 'bnb', fetcher);
  assert.equal(result.coverage, 'bnb-and-known');
  assert.equal(result.multicallBlockNumber, undefined);
  assert.deepEqual(result.assets.map(asset => asset.rawBalance), ['1000000000000000000', '11', '22', '33']);
  assert.deepEqual(requests.slice(1).map(request => request.method).sort(), ['eth_call', 'eth_call', 'eth_call', 'eth_getBalance'].sort());
});

test('unavailable Multicall3 falls back to Blockscout native and full token discovery on Ethereum', async () => {
  const other = '0x3333333333333333333333333333333333333333';
  const base = createMulticallFetcher('ethereum', { native: '1', tokens: {} }, {
    explorerTokens: [indexedToken(USDT_ETH, 'USDT', '5000000', 6), indexedToken(WBTC_ETH, 'WBTC', '200000000', 8), indexedToken(other, 'OTHER', '12', 0)],
  });
  const fetcher = async (url, options) => {
    if (url === 'https://ethereum-rpc.publicnode.com') return { ok: false, status: 503 };
    return base.fetcher(url, options);
  };
  const result = await scanWallet(address, 'ethereum', fetcher);
  assert.equal(result.assets.find(asset => asset.type === 'native').rawBalance, '9000000000000000000');
  assert.deepEqual(new Set(result.assets.filter(asset => asset.type !== 'native').map(asset => asset.contract)), new Set([USDT_ETH, WBTC_ETH, other]));
  assert.equal(result.components.tokens, true);
});
