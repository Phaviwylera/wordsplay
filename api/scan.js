const { scanWallet, validAddress, NETWORKS } = require('../lib/scanner');
const { createHash } = require('node:crypto');
const { createAddressTools } = require('../lib/addresses');
const { classifyAddress } = createAddressTools(bytes => createHash('sha256').update(bytes).digest());
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  const { address, network } = req.query;
  if (!validAddress(address) || !Object.hasOwn(NETWORKS, network)) return res.status(400).json({ error: 'A valid address and supported network are required.' });
  const family = classifyAddress(address).family;
  if ((network === 'bitcoin' && family !== 'bitcoin') || (network === 'tron' && family !== 'tron') || (!['bitcoin', 'tron'].includes(network) && family !== 'evm')) return res.status(400).json({ error: 'Address does not match network.' });
  try { return res.status(200).json(await scanWallet(address, network)); }
  catch (error) {
    console.error('Scan failed:', error.message);
    const status = error.status === 429 ? 429 : 502;
    return res.status(status).json({ error: status === 429 ? 'The network indexer is rate limiting requests. Please retry later.' : 'Could not complete the network indexer check. Please try again.' });
  }
};
