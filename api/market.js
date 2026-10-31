'use strict';
const market = require('../lib/market');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try { return res.status(200).json(await market.getMarket()); }
  catch (_) { return res.status(503).json({ error: 'Market data unavailable.' }); }
};
