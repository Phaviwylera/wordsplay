const { scanWallet, validAddress, NETWORKS } = require('../lib/scanner');
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  const { address, network } = req.query;
  if (!validAddress(address) || !Object.hasOwn(NETWORKS, network)) return res.status(400).json({ error: 'A valid address and supported network are required.' });
  try { return res.status(200).json(await scanWallet(address, network)); }
  catch (error) { console.error('Scan failed:', error.message); return res.status(502).json({ error: 'Could not reach the network indexer. Please try again.' }); }
};
