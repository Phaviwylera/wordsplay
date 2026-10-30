const { createHash } = require('node:crypto');
const { createAddressTools } = require('./addresses');
const { scanNativeNetwork } = require('./native-scanner');
const { classifyAddress } = createAddressTools(bytes => createHash('sha256').update(bytes).digest());
const NETWORKS = {
  ethereum: { name: 'Ethereum', symbol: 'ETH', explorer: 'https://eth.blockscout.com', color: '#627eea' },
  base: { name: 'Base', symbol: 'ETH', explorer: 'https://base.blockscout.com', color: '#1652f0' },
  arbitrum: { name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbitrum.blockscout.com', color: '#28a0f0' },
  optimism: { name: 'Optimism', symbol: 'ETH', explorer: 'https://optimism.blockscout.com', color: '#ff0420' },
  bnb: { name: 'BNB Smart Chain', symbol: 'BNB', color: '#d39b16' },
  bitcoin: { name: 'Bitcoin', symbol: 'BTC', color: '#f7931a' },
  tron: { name: 'TRON', symbol: 'TRX', color: '#eb0029' },
};

const statsCaches = new WeakMap();
function rawBalance(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid balance from indexer.');
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

function validAddress(address) { return Boolean(classifyAddress(address)); }

async function scanWallet(address, network, fetcher = fetch) {
  const info = classifyAddress(address);
  if (!info) throw new Error('Enter a valid wallet address.');
  const chain = Object.hasOwn(NETWORKS, network) ? NETWORKS[network] : null;
  if (!chain) throw new Error('Unsupported network.');
  if ((network === 'bitcoin' && info.family !== 'bitcoin') || (network === 'tron' && info.family !== 'tron') || (!['bitcoin', 'tron'].includes(network) && info.family !== 'evm')) throw new Error('Address does not match network.');
  if (['bitcoin', 'tron', 'bnb'].includes(network)) return scanNativeNetwork(address, network, fetcher);
  const get = async (path, timeout = 15000) => {
    const response = await fetcher(`${chain.explorer}/api/v2${path}`, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } });
    if (!response.ok) throw Object.assign(new Error(`Indexer returned ${response.status}`), { status: response.status });
    return response.json();
  };
  // Stats are optional: balances remain useful even if pricing is unavailable.
  const [account, tokens, stats] = await Promise.all([
    get(`/addresses/${address}`), get(`/addresses/${address}/token-balances`), cachedStats(fetcher, network, get),
  ]);
  if (!Array.isArray(tokens)) throw new Error('Unexpected response from indexer.');
  const assets = [{ name: 'Ether', symbol: chain.symbol, type: 'native', rawBalance: rawBalance(account?.coin_balance), decimals: 18, price: stats?.coin_price ?? null, contract: null, icon: null }];
  for (const item of tokens) {
    if (!item || typeof item !== 'object') throw new Error('Invalid token balance from indexer.');
    const token = item.token || {};
    const value = rawBalance(item.value);
    if (BigInt(value) === 0n) continue;
    assets.push({ name: token.name || 'Unknown token', symbol: token.symbol || 'UNKNOWN', type: token.type || 'token', rawBalance: value, decimals: Number.isInteger(Number(token.decimals)) && token.decimals !== null ? Number(token.decimals) : 0, price: token.exchange_rate ?? null, contract: token.address_hash || null, icon: token.icon_url || null, tokenId: item.token_id || null });
  }
  return { address, network, assets, scannedAt: new Date().toISOString() };
}
module.exports = { NETWORKS, validAddress, scanWallet };
