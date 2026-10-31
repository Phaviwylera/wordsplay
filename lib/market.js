'use strict';

// These public endpoints receive no wallet addresses. Both fetches are cached
// and coalesced: a large file scan must not issue a price request per wallet.
const { positive } = require('./prices');
const CRYPTO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin%2Cbinance-peg-busd%2Cbitcoin%2Ctron%2Cethereum&vs_currencies=usd&include_last_updated_at=true';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const COINS = { bnb: 'binancecoin', busd: 'binance-peg-busd', btc: 'bitcoin', trx: 'tron', eth: 'ethereum' };
const CRYPTO_MAX_AGE = 2 * 60 * 60 * 1000;
const FX_MAX_AGE = 3 * 24 * 60 * 60 * 1000;

function createMarketService({ fetcher = (...args) => globalThis.fetch(...args), now = () => Date.now() } = {}) {
  async function getJson(url) {
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Market provider unavailable');
    return response.json();
  }
  function freshTime(seconds, maxAge) {
    return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= now() + 300000 && now() - seconds * 1000 <= maxAge;
  }
  // Keep the last successful response during a temporary failure only while
  // its source timestamp remains fresh. Failed attempts are throttled too.
  function cached(load, ttl) {
    let value = null; let expires = 0; let inFlight = null;
    return async () => {
      if (now() < expires) return value;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try { value = await load(); expires = now() + ttl; }
        catch (_) { expires = now() + 60000; }
        return value;
      })().finally(() => { inFlight = null; });
      return inFlight;
    };
  }
  const crypto = cached(async () => {
    const data = await getJson(CRYPTO_URL);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid market data');
    const quotes = {};
    for (const [key, id] of Object.entries(COINS)) {
      const entry = data[id];
      if (positive(entry?.usd) !== null && freshTime(entry.last_updated_at, CRYPTO_MAX_AGE)) quotes[key] = { value: positive(entry.usd), at: entry.last_updated_at };
    }
    if (!Object.keys(quotes).length) throw new Error('No current market prices');
    return quotes;
  }, 5 * 60 * 1000);
  const fx = cached(async () => {
    const data = await getJson(FX_URL);
    const rate = positive(data?.rates?.INR);
    if (data?.result !== 'success' || data.base_code !== 'USD' || rate === null || !freshTime(data.time_last_update_unix, FX_MAX_AGE)) throw new Error('Invalid INR rate');
    return { value: rate, at: data.time_last_update_unix };
  }, 30 * 60 * 1000);
  return async function getMarket() {
    const [quotes, rate] = await Promise.all([crypto(), fx()]);
    const prices = Object.fromEntries(Object.keys(COINS).map(key => [key, quotes?.[key] && freshTime(quotes[key].at, CRYPTO_MAX_AGE) ? quotes[key].value : null]));
    return { currency: 'INR', usdToInr: rate && freshTime(rate.at, FX_MAX_AGE) ? rate.value : null, rateAt: rate && freshTime(rate.at, FX_MAX_AGE) ? new Date(rate.at * 1000).toISOString() : null, prices };
  };
}
const getMarket = createMarketService();
module.exports = { createMarketService, getMarket, CRYPTO_URL, FX_URL };
