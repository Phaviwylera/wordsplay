// A browser-side fallback for environments where the app server cannot reach
// Blockscout. These are public, read-only endpoints; no wallet keys are sent.
(function (root) {
  const explorers = {
    ethereum: 'https://eth.blockscout.com',
    base: 'https://base.blockscout.com',
    arbitrum: 'https://arbitrum.blockscout.com',
    optimism: 'https://optimism.blockscout.com',
  };
  async function scanDirect(address, network, fetcher = fetch) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !Object.hasOwn(explorers, network)) throw new Error('Invalid wallet or network');
    async function get(path) {
      const response = await fetcher(`${explorers[network]}/api/v2${path}`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Indexer returned ${response.status}`);
      return response.json();
    }
    const [account, tokens, stats] = await Promise.all([
      get(`/addresses/${address}`), get(`/addresses/${address}/token-balances`), get('/stats').catch(() => null),
    ]);
    if (!Array.isArray(tokens)) throw new Error('Unexpected indexer response');
    const assets = [{ name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: account.coin_balance || '0', decimals: 18, price: stats?.coin_price ?? null }];
    for (const item of tokens) {
      const token = item.token || {};
      if (!item.value || item.value === '0') continue;
      assets.push({ name: token.name || 'Unknown token', symbol: token.symbol || 'UNKNOWN', type: token.type || 'token', rawBalance: String(item.value), decimals: Number.isInteger(Number(token.decimals)) && token.decimals !== null ? Number(token.decimals) : 0, price: token.exchange_rate ?? null, contract: token.address_hash || null, tokenId: item.token_id || null });
    }
    return { address, network, assets };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { scanDirect };
  else root.scanDirect = scanDirect;
})(globalThis);
