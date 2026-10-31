// Native balances plus a targeted BUSD check on BNB Smart Chain. These do not
// discover arbitrary tokens, NFTs or inscriptions.
const { BUSD_BSC } = require('./prices');
const ENDPOINTS = {
  bitcoin: 'https://mempool.space/api/address/',
  tron: 'https://api.trongrid.io/v1/accounts/',
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
  } else if (network === 'tron') {
    // An absent account/balance is not evidence that it has no TRC tokens.
    if (data?.success !== true || !Array.isArray(data.data) || data.data.length !== 1) throw new Error('Incomplete TRON account data');
    balance = unsigned(data.data[0]?.balance);
    name = 'TRON'; symbol = 'TRX'; decimals = 6;
  } else {
    if (data?.jsonrpc !== '2.0' || data.id !== 1 || data.error || typeof data.result !== 'string' || !/^0x[\da-f]+$/i.test(data.result)) throw new Error('Invalid BNB balance from provider');
    balance = BigInt(data.result);
    name = 'BNB'; symbol = 'BNB'; decimals = 18;
  }
  return { address, network, coverage: 'native-only', assets: [{ name, symbol, type: 'native', rawBalance: balance.toString(), decimals, price: null }] };
}
async function scanBnb(address, fetcher = fetch) {
  if (typeof address !== 'string' || !/^0x[a-f\d]{40}$/i.test(address)) throw new Error('Invalid BNB address');
  const checkBusd = async () => {
    const call = { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{
      to: BUSD_BSC, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`,
    }, 'latest'] };
    const response = await fetcher(ENDPOINTS.bnb, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(call), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Object.assign(new Error(`BUSD provider returned ${response.status}`), { status: response.status });
    const data = await response.json();
    // balanceOf returns one ABI-encoded uint256, not an RPC quantity. A failed
    // or malformed call must not be mistaken for a zero token balance.
    if (data?.jsonrpc !== '2.0' || data.id !== 2 || data.error || typeof data.result !== 'string' || !/^0x[\da-f]{64}$/i.test(data.result)) throw new Error('Invalid BUSD balance from provider');
    return { name: 'Binance-Peg BUSD', symbol: 'BUSD', type: 'BEP-20', contract: BUSD_BSC, rawBalance: BigInt(data.result).toString(), decimals: 18, price: null };
  };
  const [native, busd] = await Promise.allSettled([scanNativeNetwork(address, 'bnb', fetcher), checkBusd()]);
  if (native.status === 'rejected' && busd.status === 'rejected') {
    throw [native.reason, busd.reason].find(error => error?.status === 429) || native.reason || busd.reason;
  }
  const components = { native: native.status === 'fulfilled', tokens: busd.status === 'fulfilled' };
  const assets = [...(components.native ? native.value.assets : []), ...(components.tokens ? [busd.value] : [])];
  // Retain a zero BUSD entry as evidence of a successful token check.
  const coverage = components.native && components.tokens ? 'bnb-and-busd' : components.native ? 'native-only' : 'tokens-only';
  const reason = components.native && components.tokens ? undefined : components.native ? 'BUSD balance unavailable; retry this check.' : 'BNB balance unavailable; retry this check.';
  return { address, network: 'bnb', coverage, components, assets, ...(reason ? { reason } : {}) };
}
module.exports = { scanNativeNetwork, scanBnb, ENDPOINTS };
