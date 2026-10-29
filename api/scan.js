const { scanWallet, validAddress, NETWORKS } = require('../lib/scanner');
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  const { address, network } = req.query;
  if (!validAddress(address) || !Object.hasOwn(NETWORKS, network)) return res.status(400).json({ error: 'A valid address and supported network are required.' });
  try { return res.status(200).json(await scanWallet(address, network)); }
  catch (error) {
    console.error('Scan failed:', error.message);
    const status = error.status === 429 ? 429 : 502;
    return res.status(status).json({ error: status === 429 ? 'The network indexer is rate limiting requests. Please retry later.' : 'Could not complete the network indexer check. Please try again.' });
  }
};
