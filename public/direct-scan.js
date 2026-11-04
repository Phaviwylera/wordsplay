// Browser fallback for manually tracked addresses and pasted phrases only.
// File uploads are always processed by the server and never use this path.
(function (root) {
  async function scanDirect(address, network, fetcher = fetch, options = {}) {
    if (network === 'bnb') {
      const scan = typeof module !== 'undefined' && module.exports ? require('../lib/native-scanner').scanBnb : root.scanBnb;
      return scan(address, fetcher, options);
    }
    if (network === 'bitcoin') {
      const scan = typeof module !== 'undefined' && module.exports ? require('../lib/native-scanner').scanNativeNetwork : root.scanNativeNetwork;
      return scan(address, network, fetcher);
    }
    const scan = typeof module !== 'undefined' && module.exports ? require('../lib/evm-indexer').scanEvmIndexed : root.scanEvmIndexed;
    return scan(address, network, fetcher, options);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { scanDirect };
  else root.scanDirect = scanDirect;
})(globalThis);
