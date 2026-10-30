// If the L2 explorer is unavailable or returns incomplete data, query the
// native balance independently. This cannot discover tokens or NFTs.
const RPC_ENDPOINTS = {
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
};

async function scanEvmNativeFallback(address, network, fetcher = fetch) {
  if (!Object.hasOwn(RPC_ENDPOINTS, network) || !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('Invalid wallet or network');
  const response = await fetcher(RPC_ENDPOINTS[network], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw Object.assign(new Error(`RPC returned ${response.status}`), { status: response.status });
  const data = await response.json();
  if (data?.jsonrpc !== '2.0' || data.id !== 1 || data.error || typeof data.result !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(data.result)) {
    throw new Error('Invalid native balance from RPC');
  }
  return { address, network, coverage: 'native-only', assets: [{ name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: BigInt(data.result).toString(), decimals: 18, price: null }] };
}
module.exports = { scanEvmNativeFallback, RPC_ENDPOINTS };
