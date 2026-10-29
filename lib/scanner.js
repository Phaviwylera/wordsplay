const NETWORKS = {
  ethereum: { name: 'Ethereum', symbol: 'ETH', explorer: 'https://eth.blockscout.com', color: '#627eea' },
  base: { name: 'Base', symbol: 'ETH', explorer: 'https://base.blockscout.com', color: '#1652f0' },
  arbitrum: { name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbitrum.blockscout.com', color: '#28a0f0' },
  optimism: { name: 'Optimism', symbol: 'ETH', explorer: 'https://optimism.blockscout.com', color: '#ff0420' },
};

function validAddress(address) { return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address); }

async function scanWallet(address, network, fetcher = fetch) {
  if (!validAddress(address)) throw new Error('Enter a valid EVM wallet address.');
  const chain = Object.hasOwn(NETWORKS, network) ? NETWORKS[network] : null;
  if (!chain) throw new Error('Unsupported network.');
  const get = async (path) => {
    const response = await fetcher(`${chain.explorer}/api/v2${path}`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Indexer returned ${response.status}`);
    return response.json();
  };
  // Stats are optional: balances remain useful even if pricing is unavailable.
  const [account, tokens, stats] = await Promise.all([
    get(`/addresses/${address}`), get(`/addresses/${address}/token-balances`), get('/stats').catch(() => null),
  ]);
  if (!Array.isArray(tokens)) throw new Error('Unexpected response from indexer.');
  const assets = [{ name: 'Ether', symbol: chain.symbol, type: 'native', rawBalance: account.coin_balance || '0', decimals: 18, price: stats?.coin_price ?? null, contract: null, icon: null }];
  for (const item of tokens) {
    const token = item.token || {};
    if (!item.value || item.value === '0') continue;
    assets.push({ name: token.name || 'Unknown token', symbol: token.symbol || 'UNKNOWN', type: token.type || 'token', rawBalance: String(item.value), decimals: Number.isInteger(Number(token.decimals)) && token.decimals !== null ? Number(token.decimals) : 0, price: token.exchange_rate ?? null, contract: token.address_hash || null, icon: token.icon_url || null, tokenId: item.token_id || null });
  }
  return { address, network, assets, scannedAt: new Date().toISOString() };
}
module.exports = { NETWORKS, validAddress, scanWallet };
