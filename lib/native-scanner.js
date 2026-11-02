'use strict';

// Native balances plus targeted BUSD and USDT checks on BNB Smart Chain.
// These do not discover arbitrary tokens, NFTs or inscriptions.
const { BUSD_BSC, USDT_BSC } = require('./prices');
const ENDPOINTS = {
  bitcoin: 'https://mempool.space/api/address/',
  bnb: 'https://bsc-rpc.publicnode.com',
};
function unsigned(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid balance from provider');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid balance from provider');
  return BigInt(value);
}
async function scanNativeNetwork(address, network, fetcher = fetch) {
  if (!Object.hasOwn(ENDPOINTS, network)) throw new Error('Unsupported network');
  const url = ENDPOINTS[network] + (network === 'bnb' ? '' : encodeURIComponent(address));
  const options = network === 'bnb'
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }) }
    : { headers: { Accept: 'application/json' } };
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error(`Provider returned ${response.status}`), { status: response.status });
  const data = await response.json();
  let balance; let name; let symbol; let decimals;
  if (network === 'bitcoin') {
    const confirmed = data?.chain_stats; const pending = data?.mempool_stats;
    balance = unsigned(confirmed?.funded_txo_sum) - unsigned(confirmed?.spent_txo_sum) + unsigned(pending?.funded_txo_sum) - unsigned(pending?.spent_txo_sum);
    if (balance < 0n) throw new Error('Invalid Bitcoin balance from provider');
    name = 'Bitcoin'; symbol = 'BTC'; decimals = 8;
  } else {
    if (data?.jsonrpc !== '2.0' || data.id !== 1 || data.error || typeof data.result !== 'string' || !/^0x[\da-f]+$/i.test(data.result)) throw new Error('Invalid BNB balance from provider');
    balance = BigInt(data.result);
    name = 'BNB'; symbol = 'BNB'; decimals = 18;
  }
  return { address, network, coverage: 'native-only', assets: [{ name, symbol, type: 'native', rawBalance: balance.toString(), decimals, price: null }] };
}
function tokenCall(address, id, contract, name, symbol) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{
    to: contract, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`,
  }, 'latest'], token: { name, symbol, contract } };
}
async function requestBnbCall(call, fetcher) {
  const { token, ...rpcCall } = call;
  const response = await fetcher(ENDPOINTS.bnb, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(rpcCall), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Object.assign(new Error(`${call.token.symbol} provider returned ${response.status}`), { status: response.status });
  const data = await response.json();
  return parseBnbCall(data, call);
}
function parseBnbCall(data, call) {
  if (data?.jsonrpc !== '2.0' || data.id !== call.id || data.error || typeof data.result !== 'string' || !/^0x[\da-f]{64}$/i.test(data.result)) throw new Error(`Invalid ${call.token.symbol} balance from provider`);
  return { ...call.token, type: 'BEP-20', rawBalance: BigInt(data.result).toString(), decimals: 18, price: null };
}
async function scanBnb(address, fetcher = fetch) {
  if (typeof address !== 'string' || !/^0x[a-f\d]{40}$/i.test(address)) throw new Error('Invalid BNB address');
  const [native, busd, usdt] = await Promise.allSettled([
    scanNativeNetwork(address, 'bnb', fetcher),
    requestBnbCall(tokenCall(address, 2, BUSD_BSC, 'Binance-Peg BUSD', 'BUSD'), fetcher),
    requestBnbCall(tokenCall(address, 3, USDT_BSC, 'Binance-Peg BSC-USD', 'USDT'), fetcher),
  ]);
  const tokensSucceeded = busd.status === 'fulfilled' && usdt.status === 'fulfilled';
  if (native.status === 'rejected' && !tokensSucceeded) {
    throw [native.reason, busd.reason, usdt.reason].find(error => error?.status === 429) || native.reason || busd.reason || usdt.reason;
  }
  const components = { native: native.status === 'fulfilled', tokens: tokensSucceeded };
  const assets = [
    ...(components.native ? native.value.assets : []),
    ...(components.tokens ? [busd.value, usdt.value] : []),
  ];
  // Both stablecoins must be successfully queried before the token component
  // is called complete; successful zero balances are retained as evidence.
  const coverage = components.native && components.tokens ? 'bnb-and-stables' : components.native ? 'native-only' : 'tokens-only';
  const reason = components.native && components.tokens ? undefined : components.native ? 'BUSD/USDT balances unavailable; retry this check.' : 'BNB balance unavailable; retry this check.';
  return { address, network: 'bnb', coverage, components, assets, ...(reason ? { reason } : {}) };
}
module.exports = { scanNativeNetwork, scanBnb, ENDPOINTS };
