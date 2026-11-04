'use strict';

const { scanEvmNativeFallback } = require('./evm-fallback');
const { MULTICALL3_ADDRESS, readMulticall3 } = require('./multicall3');
const { USDT_ETH, WBTC_ETH } = require('./prices');
const EXPLORERS = {
  ethereum: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
};
const statsCaches = new WeakMap();
const ETHEREUM_KNOWN_TOKENS = [
  { contract: USDT_ETH, method: 'balanceOf', args: address => [address], name: 'Tether USD', symbol: 'USDT', decimals: 6 },
  { contract: WBTC_ETH, method: 'balanceOf', args: address => [address], name: 'Wrapped Bitcoin', symbol: 'WBTC', decimals: 8 },
];
function rawBalance(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid balance from indexer');
  return value;
}
function cachedStats(fetcher, network, get) {
  let cache = statsCaches.get(fetcher);
  if (!cache) { cache = new Map(); statsCaches.set(fetcher, cache); }
  const entry = cache.get(network);
  if (entry && entry.expires > Date.now()) return entry.promise;
  const fresh = { expires: Date.now() + 60000 };
  fresh.promise = get('/stats', 4000).catch(() => { if (cache.get(network) === fresh) cache.delete(network); return null; });
  cache.set(network, fresh);
  return fresh.promise;
}
async function soon(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function tokensFrom(data) {
  if (!Array.isArray(data)) throw new Error('Unexpected token response from indexer');
  const assets = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') throw new Error('Invalid token balance from indexer');
    const token = item.token || {};
    const value = rawBalance(item.value);
    if (BigInt(value) === 0n) continue;
    const nft = /(?:ERC|BEP)-(?:721|1155)/i.test(String(token.type || ''));
    const rawDecimals = token.decimals == null && nft ? 0 : token.decimals;
    if (!((typeof rawDecimals === 'number' && Number.isInteger(rawDecimals)) || (typeof rawDecimals === 'string' && /^\d+$/.test(rawDecimals)))) throw new Error('Invalid token decimals from indexer');
    const decimals = Number(rawDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals from indexer');
    assets.push({ name: token.name || 'Unknown token', symbol: token.symbol || 'UNKNOWN', type: token.type || 'token', rawBalance: value, decimals, price: token.exchange_rate ?? null, contract: token.address_hash || null, icon: token.icon_url || null, tokenId: item.token_id ?? null });
  }
  return assets;
}
function mergeKnownTokens(indexedTokens, batch) {
  const assets = [...indexedTokens];
  if (!batch) return assets;
  ETHEREUM_KNOWN_TOKENS.forEach((token, index) => {
    const result = batch.values[index + 1];
    if (!result?.success) return;
    const contract = token.contract.toLowerCase();
    const matches = [];
    assets.forEach((asset, assetIndex) => {
      if (typeof asset.contract === 'string' && asset.contract.toLowerCase() === contract) matches.push(assetIndex);
    });
    const balance = BigInt(result.value);
    if (balance === 0n) {
      for (const assetIndex of matches.reverse()) assets.splice(assetIndex, 1);
    } else {
      const known = { name: token.name, symbol: token.symbol, type: 'ERC-20', rawBalance: result.value, decimals: token.decimals, price: null, contract: token.contract, icon: null, tokenId: null };
      if (matches.length) {
        assets[matches[0]] = known;
        for (const assetIndex of matches.slice(1).reverse()) assets.splice(assetIndex, 1);
      } else assets.push(known);
    }
  });
  return assets;
}
async function scanEvmIndexed(address, network, fetcher = fetch, { multicall = true } = {}) {
  if (typeof address !== 'string' || !/^0x[\da-f]{40}$/i.test(address) || !Object.hasOwn(EXPLORERS, network)) throw new Error('Invalid wallet or network');
  async function get(path, timeout = 6000) {
    const response = await fetcher(`${EXPLORERS[network]}/api/v2${path}`, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } });
    if (!response.ok) throw Object.assign(new Error(`Indexer returned ${response.status}`), { status: response.status });
    return response.json();
  }
  // Ethereum's native balance and canonical USDT/WBTC balances can be read in
  // one block-pinned Multicall3. Blockscout token discovery still runs in full
  // so arbitrary ERC-20s and NFTs remain covered.
  const multicallPromise = network === 'ethereum' && multicall
    ? readMulticall3('ethereum', [
      { target: MULTICALL3_ADDRESS, method: 'getEthBalance', args: [address] },
      ...ETHEREUM_KNOWN_TOKENS.map(token => ({ target: token.contract, method: token.method, args: token.args(address) })),
    ], fetcher).catch(() => null)
    : Promise.resolve(null);
  const tokensPromise = get(`/addresses/${address}/token-balances`).then(tokensFrom);
  const statsPromise = cachedStats(fetcher, network, get);
  const [batch, tokens] = await Promise.all([
    multicallPromise,
    tokensPromise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })),
  ]);
  let native;
  if (batch?.values[0]?.success) native = { status: 'fulfilled', value: batch.values[0].value };
  else {
    const nativePromise = get(`/addresses/${address}`).then(account => rawBalance(account?.coin_balance)).catch(async error => {
      try { return (await scanEvmNativeFallback(address, network, fetcher)).assets[0].rawBalance; }
      catch (_) { throw error; }
    });
    [native] = await Promise.all([nativePromise.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))]);
  }
  if (native.status === 'rejected' && tokens.status === 'rejected' && !(network === 'ethereum' && batch?.values.slice(1).some(value => value.success))) {
    throw [native.reason, tokens.reason].find(error => error?.status === 429) || native.reason || tokens.reason;
  }
  // Pricing is optional; never make fast balance results wait up to four more
  // seconds for a slow stats endpoint. The shared request continues to cache.
  const stats = native.status === 'fulfilled' ? await soon(statsPromise, 250) : null;
  const assets = [];
  if (native.status === 'fulfilled') assets.push({ name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: native.value, decimals: 18, price: stats?.coin_price ?? null, contract: null, icon: null });
  const components = { native: native.status === 'fulfilled', tokens: tokens.status === 'fulfilled' };
  if (tokens.status === 'fulfilled') assets.push(...(network === 'ethereum' ? mergeKnownTokens(tokens.value, batch) : tokens.value));
  else if (network === 'ethereum' && batch) {
    const checked = ETHEREUM_KNOWN_TOKENS.filter((_, index) => batch.values[index + 1]?.success).map(token => token.contract);
    if (checked.length) {
      components.knownTokens = checked;
      assets.push(...mergeKnownTokens([], batch));
    }
  }
  const coverage = components.native && components.tokens ? undefined
    : components.native ? 'native-only'
      : components.tokens ? 'tokens-only'
        : components.knownTokens?.length ? 'known-tokens-only' : 'tokens-only';
  const pinned = batch?.values.every(value => value.success) ? { multicallBlockNumber: batch.blockNumber } : {};
  return { address, network, ...(coverage ? { coverage } : {}), components, assets, ...pinned, scannedAt: new Date().toISOString() };
}
module.exports = { scanEvmIndexed, EXPLORERS };
