'use strict';

// Binance-Peg BUSD on BNB Smart Chain. Do not identify tokens by symbol alone:
// an unrelated contract can use the same name and would be incorrectly priced.
const BUSD_BSC = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
function nonnegative(value) {
  if (value == null || (typeof value !== 'number' && typeof value !== 'string')) return null;
  if (typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function positive(value) {
  const number = nonnegative(value);
  return number !== null && number > 0 ? number : null;
}
function usdPrice(asset, network, prices = {}) {
  if (!asset || /(?:ERC|BEP)-(?:721|1155)/i.test(String(asset.type || ''))) return null;
  let key = null;
  if (asset.type === 'native') {
    key = network === 'bnb' ? 'bnb' : network === 'bitcoin' ? 'btc' : network === 'tron' ? 'trx' : ['ethereum', 'base', 'arbitrum', 'optimism'].includes(network) ? 'eth' : null;
  } else if (network === 'bnb' && typeof asset.contract === 'string' && asset.contract.toLowerCase() === BUSD_BSC) key = 'busd';
  return (key ? positive(prices?.[key]) : null) ?? nonnegative(asset.price);
}
module.exports = { BUSD_BSC, usdPrice, positive };
