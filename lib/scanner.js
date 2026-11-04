const { createHash } = require('node:crypto');
const { createAddressTools } = require('./addresses');
const { scanNativeNetwork, scanBnb } = require('./native-scanner');
const { scanEvmIndexed } = require('./evm-indexer');
const { classifyAddress } = createAddressTools(bytes => createHash('sha256').update(bytes).digest());
const NETWORKS = {
  ethereum: { name: 'Ethereum', symbol: 'ETH', explorer: 'https://eth.blockscout.com', color: '#627eea' },
  base: { name: 'Base', symbol: 'ETH', explorer: 'https://base.blockscout.com', color: '#1652f0' },
  arbitrum: { name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbitrum.blockscout.com', color: '#28a0f0' },
  optimism: { name: 'Optimism', symbol: 'ETH', explorer: 'https://optimism.blockscout.com', color: '#ff0420' },
  bnb: { name: 'BNB Smart Chain', symbol: 'BNB', color: '#d39b16' },
  bitcoin: { name: 'Bitcoin', symbol: 'BTC', color: '#f7931a' },
};

function validAddress(address) { return Boolean(classifyAddress(address)); }

async function scanWallet(address, network, fetcher = fetch, options = {}) {
  const info = classifyAddress(address);
  if (!info) throw new Error('Enter a valid wallet address.');
  const chain = Object.hasOwn(NETWORKS, network) ? NETWORKS[network] : null;
  if (!chain) throw new Error('Unsupported network.');
  if ((network === 'bitcoin' && info.family !== 'bitcoin') || (network !== 'bitcoin' && info.family !== 'evm')) throw new Error('Address does not match network.');
  if (network === 'bnb') return scanBnb(address, fetcher, options);
  if (network === 'bitcoin') return scanNativeNetwork(address, network, fetcher);
  return scanEvmIndexed(address, network, fetcher, options);
}
module.exports = { NETWORKS, validAddress, scanWallet };
