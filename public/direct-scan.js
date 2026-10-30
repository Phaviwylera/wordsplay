// Browser-side fallback when the server cannot reach the public balance
// providers. These are read-only requests; no wallet keys are sent.
(function (root) {
  const explorers = {
    ethereum: 'https://eth.blockscout.com',
    base: 'https://base.blockscout.com',
    arbitrum: 'https://arbitrum.blockscout.com',
    optimism: 'https://optimism.blockscout.com',
  };
  const statsCaches = new WeakMap();
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
  function rawBalance(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid balance from indexer');
    return value;
  }
  async function scanDirect(address, network, fetcher = fetch) {
    if (['bitcoin', 'tron', 'bnb'].includes(network)) {
      const scan = typeof module !== 'undefined' && module.exports ? require('../lib/native-scanner').scanNativeNetwork : root.scanNativeNetwork;
      return scan(address, network, fetcher);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !Object.hasOwn(explorers, network)) throw new Error('Invalid wallet or network');
    async function get(path, timeout = ['ethereum', 'arbitrum', 'optimism'].includes(network) ? 8000 : 15000) {
      const response = await fetcher(`${explorers[network]}/api/v2${path}`, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } });
      if (!response.ok) throw Object.assign(new Error(`Indexer returned ${response.status}`), { status: response.status });
      return response.json();
    }
    let rpcAttempted = false; let rpcResult;
    const fallback = typeof module !== 'undefined' && module.exports ? require('../lib/evm-fallback').scanEvmNativeFallback : root.scanEvmNativeFallback;
    try {
      const [account, tokens, stats] = await Promise.all([
        get(`/addresses/${address}`), get(`/addresses/${address}/token-balances`), cachedStats(fetcher, network, get),
      ]);
      if (!Array.isArray(tokens)) throw new Error('Unexpected indexer response');
      let native;
      try { native = rawBalance(account?.coin_balance); }
      catch (error) {
        if (!['ethereum', 'arbitrum', 'optimism'].includes(network)) throw error;
        rpcAttempted = true;
        try { rpcResult = await fallback(address, network, fetcher); native = rpcResult.assets[0].rawBalance; }
        catch (_) { throw error; }
      }
      const assets = [{ name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: native, decimals: 18, price: stats?.coin_price ?? null }];
      for (const item of tokens) {
        if (!item || typeof item !== 'object') throw new Error('Invalid token balance from indexer');
        const token = item.token || {};
        const value = rawBalance(item.value);
        if (BigInt(value) === 0n) continue;
        assets.push({ name: token.name || 'Unknown token', symbol: token.symbol || 'UNKNOWN', type: token.type || 'token', rawBalance: value, decimals: Number.isInteger(Number(token.decimals)) && token.decimals !== null ? Number(token.decimals) : 0, price: token.exchange_rate ?? null, contract: token.address_hash || null, tokenId: item.token_id || null });
      }
      return { address, network, assets };
    } catch (indexerError) {
      if (!['ethereum', 'arbitrum', 'optimism'].includes(network)) throw indexerError;
      if (rpcAttempted) { if (rpcResult) return rpcResult; throw indexerError; }
      try { return await fallback(address, network, fetcher); }
      catch (_) { throw indexerError; }
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { scanDirect };
  else root.scanDirect = scanDirect;
})(globalThis);
