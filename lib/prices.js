'use strict';

// Identify canonical stablecoins by contract, never by their spoofable symbol.
const BUSD_BSC = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const BTCB_BSC = '0x7130d2a12b9bcBfae4f2634d864A1Ee1Ce3Ead9c'.toLowerCase();
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WBTC_ETH = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
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
    key = network === 'bnb' ? 'bnb' : network === 'bitcoin' ? 'btc' : ['ethereum', 'base', 'arbitrum', 'optimism'].includes(network) ? 'eth' : null;
  } else if (typeof asset.contract === 'string') {
    const contract = asset.contract.toLowerCase();
    if (network === 'bnb') {
      if (contract === BUSD_BSC) key = 'busd';
      else if (contract === USDT_BSC) key = 'usdt';
      else if (contract === BTCB_BSC) key = 'btc';
    } else if (network === 'ethereum') {
      if (contract === USDT_ETH) key = 'usdt';
      else if (contract === WBTC_ETH) key = 'btc';
    }
  }
  return (key ? positive(prices?.[key]) : null) ?? nonnegative(asset.price);
}
module.exports = { BUSD_BSC, USDT_BSC, BTCB_BSC, USDT_ETH, WBTC_ETH, usdPrice, positive };
